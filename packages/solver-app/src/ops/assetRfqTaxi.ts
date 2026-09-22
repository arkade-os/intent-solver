/**
 * The receive-carrier adapter's READ half. DELIBERATELY NOT a complete
 * {@link ReceiveCarrierQuotes}: `settle` and `reconcile` are a later slice, and
 * the orchestrator's completeness gate refuses a recycle rather than degrading.
 */

import { ArkAddress, asset, type IContractManager } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { verifyReceiveQuote, type TaxiClient, type VerifiedReceiveQuote } from '@arkade-taxi/client'
import { outpointKey, usableSatsOf } from '@arkade-os/solver-arkade/arkade/lockupFunding.js'
import type { AssetLeg } from '@arkade-os/solver-core/core/assetRfq.js'
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
  const domain = { kind: deps.trust.locktimeDomain, value: 1n } as const
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
      // ECHOED, and the minimums below assert only the DOMAIN: the client made
      // this quote, so its funding expiry is not ours to know. What guards the
      // floor is `recovery < floor <= batch`, and the inventory filter below.
      fundingExpiry: floor,
      maxServiceFareSats: deps.maxServiceFareSats,
      minRecoveryLocktime: domain,
      minInputExpiryFloor: domain,
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
): Pick<ReceiveCarrierQuotes, 'resolve' | 'available'> => ({
  resolve: async (request) => carrierQuoteFrom(await verifiedQuoteFor(deps, request)),

  available: async (request) => {
    const floor = carrierQuoteFrom(await verifiedQuoteFor(deps, request)).inputExpiryFloor
    const reserved = deps.reserved()
    const dust = Number(deps.trust.dustSats)
    const inventory = new Map<AssetLeg, bigint>([[null, 0n]])
    for (const coin of await deps.coins()) {
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
})
