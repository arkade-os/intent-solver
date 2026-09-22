/**
 * The receive-carrier adapter's READ half. DELIBERATELY NOT a complete
 * {@link ReceiveCarrierQuotes}: `settle` and `reconcile` are a later slice, and
 * the orchestrator's completeness gate refuses a recycle rather than degrading.
 */

import { ArkAddress, asset, type IContractManager } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { TaxiClient, verifyReceiveQuote, type VerifiedReceiveQuote } from '@arkade-taxi/client'
import { outpointKey, usableSatsOf } from '@arkade-os/solver-arkade/arkade/lockupFunding.js'
import type { ReleaseReservation } from '@arkade-os/solver-arkade/arkade/reservations.js'
import { esploraChainTip, type ChainTipProvider } from '@arkade-os/solver-rails/onchain/chainTip.js'
import type { EsploraClient } from '@arkade-os/solver-rails-esplora/esplora.js'
import type { AssetLeg } from '@arkade-os/solver-core/core/assetRfq.js'
import type { CarrierAttemptRecord } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import type { JsonObject } from '@arkade-os/solver-corridors/db/carrierAttempt.js'
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
}

export interface TaxiReceiveCarrierDeps {
  quotes: Pick<TaxiClient, 'info' | 'getReceiveQuote'>
  trust: TaxiCarrierTrust
  maxServiceFareSats: bigint
  coins: () => Promise<readonly CarrierCoin[]>
  reserved: () => ReadonlySet<string>
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

const payoutAddressOf = (makerPkScript: string, trust: TaxiCarrierTrust): string => {
  const program = TAPROOT_PK_SCRIPT.exec(makerPkScript)?.[1]
  if (program === undefined) throw new Error(`carrier payout script ${makerPkScript} is not a taproot output`)
  return new ArkAddress(trust.serverKey, hex.decode(program), trust.hrp).encode()
}

const assetIdValue = (assetId: string): { txid: Uint8Array; groupIndex: number } => {
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

const verifiedQuoteFor = async (
  deps: TaxiReceiveCarrierDeps,
  request: ReceiveCarrierQuoteRequest,
  minInputExpiryFloor: { kind: 'height' | 'time'; value: bigint },
): Promise<VerifiedReceiveQuote> => {
  const receiverAddress = payoutAddressOf(request.makerPkScript, deps.trust)
  if (!XONLY_HEX.test(request.makerPublicKey)) {
    throw new Error(`carrier maker key ${request.makerPublicKey} is not an x-only public key`)
  }
  const assetId = assetIdValue(request.assetId)
  const [info, quote] = await Promise.all([deps.quotes.info(), deps.quotes.getReceiveQuote(request.quoteId)])
  // Verification binds every other field but not the id, and `available` reads
  // this quote's floor without the orchestrator's own id check beside it.
  if (quote.quoteId !== request.quoteId)
    throw new Error(`carrier quote ${request.quoteId} answered as ${quote.quoteId}`)
  const floor = locktimeOf(quote.inputExpiryFloor, 'inputExpiryFloor')
  return verifyReceiveQuote({
    quote,
    info,
    trustedServerKey: deps.trust.serverKey,
    trustedEmulatorKey: deps.trust.emulatorKey,
    dust: deps.trust.dustSats,
    vtxoMinAmount: deps.trust.vtxoMinAmount,
    hrp: deps.trust.hrp,
    now: request.now,
    expect: {
      receiverAddress,
      makerPublicKey: hex.decode(request.makerPublicKey),
      assetId,
      // ECHOED, so this sub-check collapses: the CLIENT made the quote.
      fundingExpiry: floor,
      maxServiceFareSats: deps.maxServiceFareSats,
      minRecoveryLocktime: { kind: deps.trust.locktimeDomain, value: 1n },
      minInputExpiryFloor,
    },
  })
}

const carrierQuoteFrom = (verified: VerifiedReceiveQuote): ReceiveCarrierQuote => ({
  quoteId: verified.descriptor.quoteId,
  // From the VERIFIED address, never echoed back off the request.
  makerPkScript: hex.encode(ArkAddress.decode(verified.quote.receiverAddress).pkScript),
  makerPublicKey: verified.descriptor.makerPublicKey,
  assetId: verified.descriptor.assetId,
  physicalSats: verified.descriptor.physicalSats,
  loanSats: verified.descriptor.loanSats,
  receiptSats: verified.descriptor.receiptSats,
  serviceFareSats: verified.descriptor.serviceFareSats,
  inputExpiryFloor: locktimeOf(verified.quote.inputExpiryFloor, 'inputExpiryFloor'),
  expiresAt: verified.descriptor.expiresAt,
})

/** KNOWN same-domain expiry only — the other unit, neither, and both are all
 * excluded: an unknown expiry is not a distant one, and comparing a height to a
 * clock needs a chain tip this layer does not take. */
const clearsFloor = (coin: CarrierCoin, floor: { kind: 'height' | 'time'; value: bigint }): boolean => {
  const height = coin.expiresAtHeight
  const time = coin.expiresAt
  if ((height === undefined) === (time === undefined)) return false
  if (floor.kind === 'height') return height !== undefined && BigInt(height) >= floor.value
  return time !== undefined && BigInt(Math.floor(time.getTime() / 1000)) >= floor.value
}

export const createTaxiReceiveCarrierReader = (
  deps: TaxiReceiveCarrierDeps,
): Pick<ReceiveCarrierQuotes, 'resolve' | 'available'> => {
  const tip = deps.trust.locktimeDomain === 'height' ? deps.tipHeight : undefined
  if (deps.trust.locktimeDomain === 'height' && tip === undefined) {
    throw new Error('a height-typed deployment needs a chain tip to anchor the carrier input expiry floor on')
  }
  const anchoredFloor = async (now: number) => ({
    kind: deps.trust.locktimeDomain,
    value: (tip === undefined ? BigInt(now) : BigInt(await tip())) + deps.trust.inputExpiryMargin,
  })
  const quoteFor = async (request: ReceiveCarrierQuoteRequest): Promise<ReceiveCarrierQuote> =>
    carrierQuoteFrom(await verifiedQuoteFor(deps, request, await anchoredFloor(request.now)))

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

/** The whole of the runtime switch. Unset, nothing below is reached — not the
 * operator, not the tip, not the extra arkd round-trip `trust` costs. */
export interface TaxiCarrierComposition {
  taxiUrl?: string
  trust: () => Promise<TaxiCarrierTrust>
  maxServiceFareSats: bigint
  contracts: () => Promise<Pick<IContractManager, 'getContractsWithVtxos'>>
  reserved: () => ReadonlySet<string>
  tipHeight?: () => Promise<number>
  fetch?: typeof fetch
}

/** UNCACHED, unlike the shared reader: one block mined inside its 15s window
 * puts the floor behind the chain, admitting an already-expired coin. */
export const carrierChainTip = (client: EsploraClient): ChainTipProvider => esploraChainTip(client, { cacheMs: 0 })

export const taxiReceiveCarrier = async (
  deps: TaxiCarrierComposition,
): Promise<Pick<ReceiveCarrierQuotes, 'resolve' | 'available'> | undefined> => {
  // Blank is NOT configured: an operator pointed nowhere must leave the rail off.
  const baseUrl = deps.taxiUrl?.trim()
  if (!baseUrl) return undefined
  return createTaxiReceiveCarrierReader({
    quotes: new TaxiClient({ baseUrl, fetch: deps.fetch }),
    trust: await deps.trust(),
    maxServiceFareSats: deps.maxServiceFareSats,
    coins: async () => spendableCarrierCoins(await deps.contracts()),
    reserved: deps.reserved,
    tipHeight: deps.tipHeight,
  })
}

export interface CarrierAttemptPin {
  id: string
  release: ReleaseReservation
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

/** Re-pin what an unresolved attempt still owns, before anything can tick: a
 * reservation is process-local, so a restart drops it while the liability
 * survives. REFUSES rather than skips. Releasing is the reconcile slice's. */
export const restoreCarrierAttemptPins = async (deps: {
  attempts: () => Promise<readonly CarrierAttemptRecord[]>
  reserve: (outpoints: readonly CarrierOutpoint[]) => ReleaseReservation
}): Promise<readonly CarrierAttemptPin[]> => {
  const records = await deps.attempts()
  const pinned = records.map(({ row, attempt }) => ({
    id: row.id,
    inputs: decodeCarrierAttemptInputs(attempt.snapshot, row.id),
  }))
  return pinned.map(({ id, inputs }) => ({ id, release: deps.reserve(inputs) }))
}
