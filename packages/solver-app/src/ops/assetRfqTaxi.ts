import {
  asset,
  MultisigTapscript,
  scriptFromTapLeafScript,
  VtxoScript,
  type IContractManager,
  type TapLeafScript,
} from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { TaxiClient, verifyReceiveQuote, type VerifiedReceiveQuote } from '@arkade-taxi/client'
import { outpointKey, usableSatsOf } from '@arkade-os/solver-arkade/arkade/lockupFunding.js'
import type { ReleaseReservation } from '@arkade-os/solver-arkade/arkade/reservations.js'
import { esploraChainTip, type ChainTipProvider } from '@arkade-os/solver-rails/onchain/chainTip.js'
import type { EsploraClient } from '@arkade-os/solver-rails-esplora/esplora.js'
import type { AssetLeg } from '@arkade-os/solver-core/core/assetRfq.js'
import { RateLimiter } from '@arkade-os/solver-core/core/rateLimit.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { createPinnedTaxiFetch, guardedTaxiFetch, normalizeTaxiUrl, type TaxiUrlPolicy } from './taxiUrlGuard.js'
import type { CarrierAttemptRecord } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import type { JsonObject } from '@arkade-os/solver-corridors/db/carrierAttempt.js'
import { CARRIER_FILL_MARGIN_SECONDS } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import type {
  ReceiveCarrierQuote,
  ReceiveCarrierQuoteRequest,
  ReceiveCarrierQuotes,
} from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'

/** Trust comes from the running wallet, never the request-named operator. */
export interface TaxiCarrierTrust {
  serverKey: Uint8Array
  emulatorKey: Uint8Array
  dustSats: bigint
  vtxoMinAmount: bigint
  hrp: string
  locktimeDomain: 'height' | 'time'
  /** Minimum input-expiry headroom, in the deployment's locktime units. */
  inputExpiryMargin: bigint
}

export interface CarrierCoin {
  txid: string
  vout: number
  value: number
  expiresAt?: Date
  expiresAtHeight?: number
  assets?: readonly { assetId: string; amount: bigint | string }[]
  /** Required to prove and spend the selected coin's taproot path. */
  tapTree?: Uint8Array
  forfeitTapLeafScript?: TapLeafScript
  script?: string
}

export type TaxiCarrierClient = Pick<
  TaxiClient,
  'info' | 'getReceiveQuote' | 'requestVerifiedSwapFillQuote' | 'submitSwapFill'
>

export interface TaxiReceiveCarrierDeps {
  /** Absent resolves the configured Taxi, which no budget limits; throws when none is configured. */
  clientFor: (url?: string, budget?: TaxiBudget) => TaxiCarrierClient
  trust: TaxiCarrierTrust
  maxServiceFareSats: bigint
  coins: () => Promise<readonly CarrierCoin[]>
  reserved: () => ReadonlySet<string>
  quoteValiditySeconds: number
  /** Required on a height-typed deployment: the clock cannot anchor a height. */
  tipHeight?: () => Promise<number>
}

const TAPROOT_PK_SCRIPT = /^5120([0-9a-f]{64})$/
const XONLY_HEX = /^[0-9a-f]{64}$/

export const spendableCarrierCoins = async (
  manager: Pick<IContractManager, 'getContractsWithVtxos'>,
): Promise<readonly CarrierCoin[]> =>
  (await manager.getContractsWithVtxos({ type: ['default', 'delegate'] })).flatMap(({ vtxos }) =>
    vtxos.filter((vtxo) => !vtxo.isSwept && !(vtxo.isSpent || vtxo.spentBy || vtxo.settledBy)),
  )

export const assetIdValue = (assetId: string): { txid: Uint8Array; groupIndex: number } => {
  const parsed = asset.AssetId.fromString(assetId)
  // Taxi carries the genesis txid in INTERNAL byte order; `AssetId` holds display order.
  return { txid: Uint8Array.from(parsed.txid).reverse(), groupIndex: parsed.groupIndex }
}

export const canonicalDecimal = (value: string, label: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} is not a canonical decimal`)
  return BigInt(value)
}

const locktimeOf = (
  tagged: { kind: 'height' | 'time'; value: string },
  field: string,
): { kind: 'height' | 'time'; value: bigint } => ({
  kind: tagged.kind,
  value: canonicalDecimal(tagged.value, `carrier quote ${field}`),
})

type ReceiveQuoteWire = Awaited<ReturnType<TaxiClient['getReceiveQuote']>>

/** Reverify a bound quote only when boundFillId names this fill. */
const boundTo = (quote: ReceiveQuoteWire, fillId: string): ReceiveQuoteWire => {
  if (quote.state !== 'bound' || quote.boundFillId !== fillId) {
    const to = quote.boundFillId === undefined ? '' : ` to ${quote.boundFillId}`
    throw new Error(`carrier quote ${quote.quoteId} is ${quote.state}${to}, not bound to fill ${fillId}`)
  }
  const quoted: ReceiveQuoteWire = { ...quote, state: 'quoted' }
  delete quoted.boundFillId
  return quoted
}

type InfoWire = Awaited<ReturnType<TaxiClient['info']>>
type FarePricing = InfoWire['assetRules'][number]['fares'][number]['pricing']

const decimal = (value: unknown): bigint | undefined =>
  typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : undefined

const pricedAt = (pricing: FarePricing, loan: bigint): bigint | undefined => {
  if (pricing.kind === 'flat') return decimal(pricing.units)
  const min = decimal(pricing.minUnits)
  const max = pricing.maxUnits === null ? null : decimal(pricing.maxUnits)
  if (min === undefined || max === undefined || !Number.isInteger(pricing.bps)) return undefined
  const fare = (loan * BigInt(pricing.bps)) / 10_000n
  const floored = fare < min ? min : fare
  return max !== null && floored > max ? max : floored
}

/** A token fare is never a receiver's to pay, so it names no currency here. */
const RECEIVER_FARE_CURRENCY: Readonly<Record<string, 'sats' | 'asset'>> = { sats: 'sats', sameAsset: 'asset' }

/** Recover the advertised receiver fare so verification does not default to the first fare. */
const receiverFareId = (
  info: InfoWire,
  quote: ReceiveQuoteWire,
  assetId: ReturnType<typeof assetIdValue>,
  loan: bigint,
): string => {
  const fare = quote.receiverFare
  const units = decimal(fare?.units)
  // The rule the client's verifyPolicy resolves, or the id names a fare it never looks in: exact first, then "*".
  const rule =
    info.assetRules.find(
      (candidate) =>
        typeof candidate.assetId === 'object' &&
        candidate.assetId?.txid.toLowerCase() === hex.encode(assetId.txid) &&
        candidate.assetId.groupIndex === assetId.groupIndex,
    ) ?? info.assetRules.find((candidate) => candidate.assetId === '*')
  const option = rule?.fares.find(
    (offered) =>
      RECEIVER_FARE_CURRENCY[offered.currency] === fare?.currency &&
      units !== undefined &&
      pricedAt(offered.pricing, loan) === units,
  )
  if (option === undefined) throw new Error(`carrier quote ${quote.quoteId} is priced at no fare the Taxi advertises`)
  return option.id
}

const verifiedQuoteFor = async (
  deps: TaxiReceiveCarrierDeps,
  request: ReceiveCarrierQuoteRequest,
  minInputExpiryFloor: { kind: 'height' | 'time'; value: bigint },
): Promise<{ verified: VerifiedReceiveQuote; operatorKey: string }> => {
  if (!TAPROOT_PK_SCRIPT.test(request.makerPkScript)) {
    throw new Error(`carrier payout script ${request.makerPkScript} is not a taproot output`)
  }
  if (!XONLY_HEX.test(request.makerPublicKey)) {
    throw new Error(`carrier maker key ${request.makerPublicKey} is not an x-only public key`)
  }
  const assetId = assetIdValue(request.assetId)
  const client = deps.clientFor(request.taxi?.url, request.admission ? 'quote' : 'fill')
  const [info, served] = await Promise.all([client.info(), client.getReceiveQuote(request.quoteId)])
  // Verification does not bind the quote id; availability must check it separately.
  if (served.quoteId !== request.quoteId)
    throw new Error(`carrier quote ${request.quoteId} answered as ${served.quoteId}`)
  const quote = request.boundFillId === undefined ? served : boundTo(served, request.boundFillId)
  const operatorKey = info.operatorKey.toLowerCase()
  // Request-named Taxi identity is separate from the wallet trust anchors.
  if (request.taxi && operatorKey !== request.taxi.operatorKey.toLowerCase()) {
    throw new Error('carrier quote operator key differs from the one the request named')
  }
  const floor = locktimeOf(quote.inputExpiryFloor, 'inputExpiryFloor')
  const verified = await verifyReceiveQuote({
    quote,
    info,
    trustedServerKey: deps.trust.serverKey,
    trustedEmulatorKey: deps.trust.emulatorKey,
    dust: deps.trust.dustSats,
    vtxoMinAmount: deps.trust.vtxoMinAmount,
    hrp: deps.trust.hrp,
    now: request.now,
    expect: {
      // The offer pays the covenant, not this address; still pinned to the trusted server and `params.receiverKey`.
      receiverAddress: quote.receiverAddress,
      makerPublicKey: hex.decode(request.makerPublicKey),
      assetId,
      fundingExpiry: floor,
      ...(request.receiverPaid
        ? { payer: 'receiver' as const, fareId: receiverFareId(info, quote, assetId, deps.trust.dustSats) }
        : {}),
      maxServiceFareSats: deps.maxServiceFareSats,
      minRecoveryLocktime: { kind: deps.trust.locktimeDomain, value: 1n },
      minInputExpiryFloor,
    },
  })
  if (hex.encode(verified.script.pkScript) !== request.makerPkScript) {
    throw new Error(`carrier payout script ${request.makerPkScript} is not the verified quote's receive covenant`)
  }
  return { verified, operatorKey }
}

/** Refresh operator identity from verified info, never request data. */
const carrierQuoteFrom = (from: { verified: VerifiedReceiveQuote; operatorKey: string }): ReceiveCarrierQuote => {
  const { verified, operatorKey } = from
  return {
    quoteId: verified.descriptor.quoteId,
    // From the VERIFIED covenant, never echoed back off the request.
    makerPkScript: hex.encode(verified.script.pkScript),
    makerPublicKey: verified.descriptor.makerPublicKey,
    assetId: verified.descriptor.assetId,
    physicalSats: verified.descriptor.physicalSats,
    loanSats: verified.descriptor.loanSats,
    receiptSats: verified.descriptor.receiptSats,
    serviceFareSats: verified.descriptor.serviceFareSats,
    taxiKey: operatorKey,
    inputExpiryFloor: locktimeOf(verified.quote.inputExpiryFloor, 'inputExpiryFloor'),
    ...(verified.receiverFare === undefined
      ? {}
      : { receiverFare: { currency: verified.receiverFare.currency, units: verified.receiverFare.units } }),
    expiresAt: verified.descriptor.expiresAt,
  }
}

/** Require a known expiry in exactly the deployment's locktime domain. */
export const clearsFloor = (coin: CarrierCoin, floor: { kind: 'height' | 'time'; value: bigint }): boolean => {
  const height = coin.expiresAtHeight
  const time = coin.expiresAt
  if ((height === undefined) === (time === undefined)) return false
  if (floor.kind === 'height') return height !== undefined && BigInt(height) >= floor.value
  return time !== undefined && BigInt(Math.floor(time.getTime() / 1000)) >= floor.value
}

export interface CarrierTaprootEvidence {
  tapTree: Uint8Array
  spendLeaf: Uint8Array
}

/** Require a matching taproot script and a collaborative leaf for the solver and server. */
export const carrierTaprootEvidence = (
  coin: CarrierCoin,
  solverKeys: readonly string[],
  serverKey: Uint8Array,
): CarrierTaprootEvidence | undefined => {
  if (coin.tapTree === undefined || coin.forfeitTapLeafScript === undefined || coin.script === undefined) {
    return undefined
  }
  try {
    const tree = VtxoScript.decode(coin.tapTree)
    if (hex.encode(tree.pkScript) !== coin.script.toLowerCase()) return undefined
    const spendLeaf = scriptFromTapLeafScript(coin.forfeitTapLeafScript)
    if (!tree.scripts.some((script) => hex.encode(script) === hex.encode(spendLeaf))) return undefined
    const keys = MultisigTapscript.decode(spendLeaf)
      .params.pubkeys.map((key) => hex.encode(key))
      .sort()
    const server = hex.encode(serverKey)
    const collaborative = solverKeys.some(
      (solverKey) => JSON.stringify(keys) === JSON.stringify([solverKey.toLowerCase(), server].sort()),
    )
    return collaborative ? { tapTree: tree.encode(), spendLeaf } : undefined
  } catch {
    return undefined
  }
}

/** A conservative seconds-per-block divisor overstates the required expiry slack. */
const CARRIER_FAST_BLOCK_SECONDS = 30

/** Headroom over an expected count that is only a mean — arrivals are Poisson. */
const CARRIER_SLACK_FLOOR_BLOCKS = 6

export const carrierAdmissionSlack = (domain: 'height' | 'time', quoteValiditySeconds: number): bigint => {
  const window = Math.max(0, Math.ceil(quoteValiditySeconds))
  if (domain === 'time') return BigInt(window + CARRIER_FILL_MARGIN_SECONDS)
  return BigInt(2 * Math.ceil(window / CARRIER_FAST_BLOCK_SECONDS) + CARRIER_SLACK_FLOOR_BLOCKS)
}

export const createTaxiReceiveCarrierReader = (
  deps: TaxiReceiveCarrierDeps,
): Pick<ReceiveCarrierQuotes, 'resolve' | 'available'> => {
  const tip = deps.trust.locktimeDomain === 'height' ? deps.tipHeight : undefined
  const slack = carrierAdmissionSlack(deps.trust.locktimeDomain, deps.quoteValiditySeconds)
  const anchoredFloor = async (now: number, admission: boolean) => {
    if (deps.trust.locktimeDomain === 'height' && tip === undefined) {
      throw new Error('a height-typed deployment needs a chain tip to anchor the carrier input expiry floor on')
    }
    return {
      kind: deps.trust.locktimeDomain,
      value:
        (tip === undefined ? BigInt(now) : BigInt(await tip())) +
        deps.trust.inputExpiryMargin +
        (admission ? slack : 0n),
    }
  }
  const quoteFor = async (request: ReceiveCarrierQuoteRequest): Promise<ReceiveCarrierQuote> =>
    carrierQuoteFrom(await verifiedQuoteFor(deps, request, await anchoredFloor(request.now, request.admission)))

  return {
    resolve: quoteFor,

    available: async (request) => {
      const floor = (await quoteFor(request)).inputExpiryFloor
      const coins = await deps.coins()
      // AFTER every await above: a pin taken during one is still a pin.
      const reserved = deps.reserved()
      const dust = Number(deps.trust.dustSats)
      const inventory = new Map<AssetLeg, bigint>([[null, 0n]])
      for (const coin of coins) {
        if (reserved.has(outpointKey(coin.txid, coin.vout))) continue
        if (!clearsFloor(coin, floor)) continue
        const sats = usableSatsOf(coin, dust)
        if (sats > 0) inventory.set(null, (inventory.get(null) ?? 0n) + BigInt(sats))
        for (const held of coin.assets ?? []) {
          const amount = BigInt(held.amount)
          if (amount > 0n) inventory.set(held.assetId, (inventory.get(held.assetId) ?? 0n) + amount)
        }
      }
      return inventory
    },
  }
}

export interface TaxiCarrierComposition {
  taxiUrl?: string
  trust: () => Promise<TaxiCarrierTrust>
  maxServiceFareSats: bigint
  contracts: () => Promise<Pick<IContractManager, 'getContractsWithVtxos'>>
  reserved: () => ReadonlySet<string>
  quoteValiditySeconds: number
  tipHeight?: () => Promise<number>
  /** SSRF policy for request-named URLs; configured URLs are trusted separately. */
  policy: TaxiUrlPolicy
}

/** Do not cache the chain tip: a newly mined block can invalidate the expiry floor. */
export const carrierChainTip = (client: EsploraClient): ChainTipProvider => esploraChainTip(client, { cacheMs: 0 })

/** Separate cheap quote traffic from funded-fill traffic. */
export type TaxiBudget = 'quote' | 'fill'

export const TAXI_QUOTE_RATE_LIMIT = 20
/** Funded fills use at most six requests per host. */
export const TAXI_FILL_RATE_LIMIT = 60
/** Shared by every named host, so fresh subdomains cannot multiply it: ten receiver-paid quotes a minute, 4 reads each. */
export const TAXI_QUOTE_GLOBAL_RATE_LIMIT = 40
/** Bound how long an untrusted quote endpoint can hold the queue. */
export const TAXI_QUOTE_TIMEOUT_MS = 2_000
const TAXI_CLIENT_RATE_WINDOW_SECONDS = 60
const TAXI_CLIENT_CACHE_SIZE = 32

/** Bounded FIFO cache per URL and budget; configured URLs still use bounded reads. */
export const taxiClientCache = (deps: {
  configuredUrl?: string
  policy: TaxiUrlPolicy
}): ((url?: string, budget?: TaxiBudget) => TaxiCarrierClient) => {
  const configured = deps.configuredUrl
    ? new TaxiClient({
        baseUrl: deps.configuredUrl,
        fetch: guardedTaxiFetch(
          fetch,
          new RateLimiter(Number.MAX_SAFE_INTEGER, TAXI_CLIENT_RATE_WINDOW_SECONDS, nowSeconds),
        ),
      })
    : undefined
  const requestFetch = deps.policy.allowPrivate ? fetch : createPinnedTaxiFetch()
  const limiters: Record<TaxiBudget, RateLimiter> = {
    quote: new RateLimiter(TAXI_QUOTE_RATE_LIMIT, TAXI_CLIENT_RATE_WINDOW_SECONDS, nowSeconds),
    fill: new RateLimiter(TAXI_FILL_RATE_LIMIT, TAXI_CLIENT_RATE_WINDOW_SECONDS, nowSeconds),
  }
  const guards: Record<TaxiBudget, Parameters<typeof guardedTaxiFetch>[2]> = {
    quote: {
      timeoutMs: TAXI_QUOTE_TIMEOUT_MS,
      global: new RateLimiter(TAXI_QUOTE_GLOBAL_RATE_LIMIT, TAXI_CLIENT_RATE_WINDOW_SECONDS, nowSeconds),
    },
    fill: {},
  }
  const cache = new Map<string, TaxiCarrierClient>()
  return (url, budget = 'quote') => {
    if (url === undefined) {
      if (!configured) throw new Error('no receive-carrier Taxi is configured for this request')
      return configured
    }
    const normalized = normalizeTaxiUrl(url, deps.policy)
    const key = `${budget} ${normalized}`
    const cached = cache.get(key)
    if (cached) return cached
    if (cache.size >= TAXI_CLIENT_CACHE_SIZE) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    const client = new TaxiClient({
      baseUrl: normalized,
      fetch: guardedTaxiFetch(requestFetch, limiters[budget], guards[budget]),
    })
    cache.set(key, client)
    return client
  }
}

export const taxiReceiveCarrier = async (
  deps: TaxiCarrierComposition,
): Promise<Pick<ReceiveCarrierQuotes, 'resolve' | 'available'>> =>
  createTaxiReceiveCarrierReader({
    clientFor: taxiClientCache({
      configuredUrl: deps.taxiUrl?.trim() || undefined,
      policy: deps.policy,
    }),
    trust: await deps.trust(),
    maxServiceFareSats: deps.maxServiceFareSats,
    coins: async () => spendableCarrierCoins(await deps.contracts()),
    reserved: deps.reserved,
    quoteValiditySeconds: deps.quoteValiditySeconds,
    tipHeight: deps.tipHeight,
  })

/** Caller-scoped ownership prevents a losing CAS from releasing the winner's coins. */
export interface CarrierPin {
  readonly id: string
  /** Frees this reservation and no other. Idempotent. */
  release(): void
}

/** Pins survive the settle call until durable evidence permits release. */
export interface CarrierPinLedger {
  adopt(id: string, release: ReleaseReservation): CarrierPin
  heldFor(id: string): readonly CarrierPin[]
}

export const createCarrierPinLedger = (): CarrierPinLedger => {
  const held = new Map<string, Set<CarrierPin>>()
  return {
    adopt(id, release) {
      const owed = held.get(id) ?? new Set<CarrierPin>()
      held.set(id, owed)
      const pin: CarrierPin = {
        id,
        release() {
          if (!owed.delete(pin)) return
          if (owed.size === 0) held.delete(id)
          release()
        },
      }
      owed.add(pin)
      return pin
    },
    heldFor: (id) => [...(held.get(id) ?? [])],
  }
}

const CANONICAL_TXID = /^[0-9a-f]{64}$/

export interface CarrierOutpoint {
  txid: string
  vout: number
}

/** Shared snapshot codec: writer and reader must agree on reserved outpoints. */
export const encodeCarrierAttemptInputs = (outpoints: readonly CarrierOutpoint[]): JsonObject => ({
  inputs: checkedOutpoints(outpoints, 'carrier attempt inputs').map(({ txid, vout }) => ({ txid, vout })),
})

export const decodeCarrierAttemptInputs = (snapshot: JsonObject, id: string): readonly CarrierOutpoint[] =>
  checkedOutpoints(snapshot.inputs, `carrier attempt ${id} inputs`)

const checkedOutpoints = (value: unknown, label: string): CarrierOutpoint[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label}: names no inputs`)
  return value.map((raw) => {
    const input = raw as { txid?: unknown; vout?: unknown }
    if (typeof input?.txid !== 'string' || !CANONICAL_TXID.test(input.txid)) {
      throw new Error(`${label}: non-canonical input txid`)
    }
    if (!Number.isInteger(input.vout) || (input.vout as number) < 0) {
      throw new Error(`${label}: non-canonical input vout`)
    }
    return { txid: input.txid, vout: input.vout as number }
  })
}

/** Restore unresolved pins before any tick; liability survives process-local reservations. */
export const restoreCarrierAttemptPins = async (deps: {
  attempts: () => Promise<readonly CarrierAttemptRecord[]>
  reserve: (outpoints: readonly CarrierOutpoint[]) => ReleaseReservation
  pins: CarrierPinLedger
}): Promise<readonly string[]> => {
  const records = await deps.attempts()
  const pinned = records.map(({ row, attempt }) => ({
    id: row.id,
    inputs: decodeCarrierAttemptInputs(attempt.snapshot, row.id),
  }))
  for (const { id, inputs } of pinned) deps.pins.adopt(id, deps.reserve(inputs))
  return pinned.map(({ id }) => id)
}
