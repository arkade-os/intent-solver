/**
 * The receive-carrier adapter's READ half. DELIBERATELY NOT a complete
 * {@link ReceiveCarrierQuotes}: `settle` and `reconcile` are a later slice, and
 * the orchestrator's completeness gate refuses a recycle rather than degrading.
 */

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

/** The running Arkade context's, so an operator URL substitutes none of it. */
export interface TaxiCarrierTrust {
  serverKey: Uint8Array
  emulatorKey: Uint8Array
  dustSats: bigint
  vtxoMinAmount: bigint
  hrp: string
  /** @see resolveTimelockUnit */
  locktimeDomain: 'height' | 'time'
  /** How far past the anchor the operator's input expiry floor must sit, in this
   * domain's units — arkd's advertised exit delay. Verification only ORDERS the
   * quote's deadlines, which `recovery=1 / floor=2` satisfies. */
  inputExpiryMargin: bigint
}

export interface CarrierCoin {
  txid: string
  vout: number
  value: number
  expiresAt?: Date
  expiresAtHeight?: number
  assets?: readonly { assetId: string; amount: bigint | string }[]
  /** Carried by every real ContractManager coin; the rebuild refuses without
   * them rather than spending a coin it cannot prove a path into. */
  tapTree?: Uint8Array
  forfeitTapLeafScript?: TapLeafScript
  /** The indexer's scriptPubKey — what `tapTree` must actually rebuild. */
  script?: string
}

/** T21 routes settle/reconcile through this same client, so it is typed for that now, not narrowed to today's two reads. */
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
  /** How long a quote binds — the window an admission read must also clear. */
  quoteValiditySeconds: number
  /** Required on a height-typed deployment: the clock cannot anchor a height. */
  tipHeight?: () => Promise<number>
}

const TAPROOT_PK_SCRIPT = /^5120([0-9a-f]{64})$/
const XONLY_HEX = /^[0-9a-f]{64}$/

/** NOT `ContractManagerLike`: that slice is the lockup watcher's and narrows the
 * manager to its event and watch trio, which carries no coins. */
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

const locktimeOf = (
  tagged: { kind: 'height' | 'time'; value: string },
  field: string,
): { kind: 'height' | 'time'; value: bigint } => {
  if (!/^(0|[1-9][0-9]*)$/.test(tagged.value)) throw new Error(`carrier quote ${field} is not a canonical decimal`)
  return { kind: tagged.kind, value: BigInt(tagged.value) }
}

type ReceiveQuoteWire = Awaited<ReturnType<TaxiClient['getReceiveQuote']>>

/** The Taxi's bind moves only `state` and `boundFillId`, so a quote bound to THIS fill re-verifies as the quoted one
 * it was. Bound to another fill, or not bound at all, is refused. */
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

/** The client's own `verifyPolicy` arithmetic, used only to pick an id: the client re-verifies against it. */
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

/** The advertised fare a receiver-paid quote was priced at. The RFQ names none, and without one the client checks the
 * first listed, refusing every payee who picked another. */
const receiverFareId = (
  info: InfoWire,
  quote: ReceiveQuoteWire,
  assetId: ReturnType<typeof assetIdValue>,
  loan: bigint,
): string => {
  const fare = quote.receiverFare
  const units = decimal(fare?.units)
  const rule = info.assetRules.find(
    (candidate) =>
      candidate.assetId?.txid.toLowerCase() === hex.encode(assetId.txid) &&
      candidate.assetId.groupIndex === assetId.groupIndex,
  )
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
  // Verification binds every other field but not the id, and `available` reads
  // this quote's floor without the orchestrator's own id check beside it.
  if (served.quoteId !== request.quoteId)
    throw new Error(`carrier quote ${request.quoteId} answered as ${served.quoteId}`)
  const quote = request.boundFillId === undefined ? served : boundTo(served, request.boundFillId)
  const operatorKey = info.operatorKey.toLowerCase()
  // The ONLY identity read off a request-named Taxi. `deps.trust` below is
  // shared and singular regardless — see the module comment on `TaxiCarrierTrust`.
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
      // ECHOED, so this sub-check collapses: the CLIENT made the quote.
      fundingExpiry: floor,
      // Keyed on `receiverPaid`, NOT `taxi`: WHICH Taxi vs who pays it.
      ...(request.receiverPaid
        ? { payer: 'receiver' as const, fareId: receiverFareId(info, quote, assetId, deps.trust.dustSats) }
        : {}),
      maxServiceFareSats: deps.maxServiceFareSats,
      minRecoveryLocktime: { kind: deps.trust.locktimeDomain, value: 1n },
      minInputExpiryFloor,
    },
  })
  // The covenant REBUILT from params: receiver, maker and operator keys, asset, split and, receiver-paid, the fare.
  if (hex.encode(verified.script.pkScript) !== request.makerPkScript) {
    throw new Error(`carrier payout script ${request.makerPkScript} is not the verified quote's receive covenant`)
  }
  return { verified, operatorKey }
}

/** `taxiKey` is the SAME `info` already fetched above, never copied off the
 * request — set on every resolve, since `recycle` never reads it anyway. */
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

/** KNOWN same-domain expiry only — the other unit, neither, and both are all
 * excluded: an unknown expiry is not a distant one, and comparing a height to a
 * clock needs a chain tip this layer does not take. */
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

/** The coin's own tree and forfeit leaf, wire-shaped — but only when the tree
 * rebuilds the coin's own script and the leaf is a collaborative multisig of
 * one of `solverKeys` and `serverKey`. `undefined` for anything else, so
 * callers exclude the coin at selection rather than pin it toward a refusal. */
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

/** Mutinynet's rate, and a DIVISOR: assuming blocks are fast over-states the
 * slack, which is the safe side and the opposite of `HTLC_SECONDS_PER_BLOCK`. */
const CARRIER_FAST_BLOCK_SECONDS = 30

/** Headroom over an expected count that is only a mean — arrivals are Poisson. */
const CARRIER_SLACK_FLOOR_BLOCKS = 6

/** How far the anchor may move between admitting a quote and filling it. */
export const carrierAdmissionSlack = (domain: 'height' | 'time', quoteValiditySeconds: number): bigint => {
  const window = Math.max(0, Math.ceil(quoteValiditySeconds))
  if (domain === 'time') return BigInt(window + CARRIER_FILL_MARGIN_SECONDS)
  return BigInt(2 * Math.ceil(window / CARRIER_FAST_BLOCK_SECONDS) + CARRIER_SLACK_FLOOR_BLOCKS)
}

export const createTaxiReceiveCarrierReader = (
  deps: TaxiReceiveCarrierDeps,
): Pick<ReceiveCarrierQuotes, 'resolve' | 'available'> => {
  const tip = deps.trust.locktimeDomain === 'height' ? deps.tipHeight : undefined
  if (deps.trust.locktimeDomain === 'height' && tip === undefined) {
    throw new Error('a height-typed deployment needs a chain tip to anchor the carrier input expiry floor on')
  }
  const slack = carrierAdmissionSlack(deps.trust.locktimeDomain, deps.quoteValiditySeconds)
  const anchoredFloor = async (now: number, admission: boolean) => ({
    kind: deps.trust.locktimeDomain,
    value:
      (tip === undefined ? BigInt(now) : BigInt(await tip())) + deps.trust.inputExpiryMargin + (admission ? slack : 0n),
  })
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

/** G4: runs regardless of `taxiUrl` — only the fallback for a request naming
 * none still needs it, so `trust`/the tip are now always paid for. */
export interface TaxiCarrierComposition {
  taxiUrl?: string
  trust: () => Promise<TaxiCarrierTrust>
  maxServiceFareSats: bigint
  contracts: () => Promise<Pick<IContractManager, 'getContractsWithVtxos'>>
  reserved: () => ReadonlySet<string>
  quoteValiditySeconds: number
  tipHeight?: () => Promise<number>
  fetch?: typeof fetch
  /** Ruling 3's SSRF gate for a request-named URL; `taxiUrl` above never routes through it. */
  policy: TaxiUrlPolicy
}

/** UNCACHED, unlike the shared reader: one block mined inside its 15s window
 * puts the floor behind the chain, admitting an already-expired coin. */
export const carrierChainTip = (client: EsploraClient): ChainTipProvider => esploraChainTip(client, { cacheMs: 0 })

/** Which per-host budget a named-Taxi request spends. Quote traffic costs nothing to generate, so it has its own. */
export type TaxiBudget = 'quote' | 'fill'

/** A named Taxi's quote budget: generous for real traffic, tight enough to cap a hostile URL's round-trip storm. */
export const TAXI_QUOTE_RATE_LIMIT = 20
/** Spent only behind a funded deposit, at most 6 requests a fill per host, so ten concurrent fills a minute. */
export const TAXI_FILL_RATE_LIMIT = 60
/** Shared by every named host, so fresh subdomains cannot multiply it: ten receiver-paid quotes a minute, 4 reads each. */
export const TAXI_QUOTE_GLOBAL_RATE_LIMIT = 40
/** One small GET: an honest Taxi answers well inside it, and a tarpit holds a quote at most two parallel rounds. */
export const TAXI_QUOTE_TIMEOUT_MS = 2_000
const TAXI_CLIENT_RATE_WINDOW_SECONDS = 60
/** Ruling 3's cap on the client cache below. */
const TAXI_CLIENT_CACHE_SIZE = 32

/** One client per budget and normalized URL, built lazily in a FIFO cache — evicted oldest-INSERTED first, a hit
 * refreshes nothing — so distinct attacker URLs cannot grow it unbounded. The configured URL
 * skips untrusted URL normalization, but its responses still need bounded reads. */
export const taxiClientCache = (deps: {
  configuredUrl?: string
  policy: TaxiUrlPolicy
  fetch?: typeof fetch
}): ((url?: string, budget?: TaxiBudget) => TaxiCarrierClient) => {
  const baseFetch = deps.fetch ?? fetch
  const configured = deps.configuredUrl
    ? new TaxiClient({
        baseUrl: deps.configuredUrl,
        fetch: guardedTaxiFetch(
          baseFetch,
          new RateLimiter(Number.MAX_SAFE_INTEGER, TAXI_CLIENT_RATE_WINDOW_SECONDS, nowSeconds),
        ),
      })
    : undefined
  const requestFetch = deps.fetch ?? (deps.policy.allowPrivate ? fetch : createPinnedTaxiFetch())
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
      fetch: deps.fetch,
    }),
    trust: await deps.trust(),
    maxServiceFareSats: deps.maxServiceFareSats,
    coins: async () => spendableCarrierCoins(await deps.contracts()),
    reserved: deps.reserved,
    quoteValiditySeconds: deps.quoteValiditySeconds,
    tipHeight: deps.tipHeight,
  })

/** ONE caller's reservation on one row. Scoped rather than row-keyed: a settle
 * that lost a CAS must not free the coins of the one that won it. */
export interface CarrierPin {
  readonly id: string
  /** Frees this reservation and no other. Idempotent. */
  release(): void
}

/** A pin is only given up against durable proof that nothing was submitted, so
 * its release has to outlive the call that took it. */
export interface CarrierPinLedger {
  adopt(id: string, release: ReleaseReservation): CarrierPin
  /** Every pin a row still owes — the seam reconciliation resolves through. */
  heldFor(id: string): readonly CarrierPin[]
  held(): readonly string[]
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
    held: () => [...held.keys()],
  }
}

const CANONICAL_TXID = /^[0-9a-f]{64}$/

export interface CarrierOutpoint {
  txid: string
  vout: number
}

/** THE shape of `snapshot.inputs`, in one place: the settle slice writes through
 * this, {@link decodeCarrierAttemptInputs} is the only reader, and a key chosen
 * independently at either end silently un-pins a coin a fill may have spent. */
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

/**
 * Re-pin what an unresolved attempt still owns, before anything can tick: a
 * reservation is process-local, so a restart drops it while the liability
 * survives. REFUSES rather than skips, and the releases go into the ledger
 * rather than back to the caller, so there is no way to drop one.
 */
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
