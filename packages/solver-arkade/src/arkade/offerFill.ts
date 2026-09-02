/**
 * Turning a decoded Arkade offer into the decision `core/assetOffer.ts` takes.
 *
 * THE ADAPTER LAYER THAT MODULE NAMED. `evaluateOfferFill` deliberately does not
 * import `@arkade-os/swap`'s `Offer` — "the decision is pure data in and a
 * verdict out, and the package that decodes the offer packet belongs to the
 * adapter layer that will call this". This is that layer, and until now it did
 * not exist: the decision had no caller anywhere in `src/`.
 *
 * WHAT THE PACKET DOES NOT CARRY, and it is the whole reason this file has two
 * arguments rather than one. `Offer` has `wantAmount` — what the maker asks for
 * — and no field for what they DEPOSITED. That amount is not a claim the maker
 * makes; it is a fact about the chain, held by the VTXO at `swapPkScript`. So
 * `offerAmount` is observed, never parsed.
 *
 * Reading it from the packet would be the same class of mistake as trusting a
 * quoted funding amount: an offer could advertise a deposit it does not hold,
 * pass `offer_unfunded`, and be filled for nothing. The signature makes that
 * impossible to write by accident.
 *
 * ONLY THE NAMED ASSET COUNTS on the deposit side: an offer depositing a large
 * amount of some OTHER asset holds none of what it promised, and a naive "does
 * it carry assets" read would wave it through for the price of minting
 * something worthless. The lockup funding gate has to make the same distinction
 * for the same reason — a lockup with the right sats carrier and the wrong
 * asset reads as funded — and lands with the asset corridors.
 */

import type { Offer } from '@arkade-os/swap'
import type { OfferFillInput } from '@arkade-os/solver-core/core/assetOffer.js'

/**
 * What the chain says is sitting at the offer's own script.
 *
 * Sats AND assets, because they ride on the same output — a reader that saw
 * only one of them would be blind to half of what it is deciding about. Every
 * funding gate in this repo that meets an asset needs the same pair.
 */
export interface OfferDeposit {
  /** Sats across every output at the offer's script. */
  sats: bigint
  /**
   * The assets those outputs carry, when they carry any.
   *
   * `assetId` is the canonical 68-hex serialization — the same spelling
   * `AssetId.toString()` produces, which is what `offerFillInputFrom` compares
   * it against below. That agreement is a CONTRACT rather than a coincidence,
   * and it fails silently: a different spelling makes `heldOf` find nothing, the
   * offer reads as unfunded, and a fillable offer is refused with no error
   * anywhere. @see arkade/offerInventory.ts, which carries the same requirement
   * on the other side of the decision.
   */
  assets?: readonly { assetId: string; amount: bigint }[]
}

/**
 * The canonical 68-hex id, or null for BTC.
 *
 * Null rather than a sentinel string because that is the distinction the packet
 * itself draws — `wantAsset` and `offerAsset` are OMITTED for BTC, not set to
 * some BTC id — and `evaluateOfferFill` keys its markets and inventory the same
 * way.
 *
 * TYPED STRUCTURALLY, not as the SDK's `asset.AssetId`, and that is not
 * fastidiousness: the only thing this function depends on is the serialization
 * `toString()` produces, never the class. Naming exactly that keeps the adapter
 * honest about its dependency — a serialization, nothing more.
 *
 * It also survives a version split, which is worth knowing but is NOT the
 * reason. When this repo pinned `@arkade-os/sdk@0.4.62` while
 * `@arkade-os/swap@0.0.7` required `0.4.64`, pnpm installed both and the two
 * `AssetId` classes were nominally distinct — identical shape, incompatible
 * types. It recurred on the 0.0.10 bump, which needs `0.4.67`, and surfaced as
 * `Argument of type 'Wallet' is not assignable to parameter of type 'IWallet'`.
 * The fix both times was to pin the SAME sdk the swap package asks for, so keep
 * them in step rather than relying on this being structural.
 */
const idOf = (id: { toString(): string } | undefined): string | null => (id === undefined ? null : id.toString())

/** How much of `assetId` the deposit holds — or its sats, when the leg is BTC. */
const heldOf = (deposit: OfferDeposit, assetId: string | null): bigint => {
  if (assetId === null) return deposit.sats
  // Summed rather than found: nothing says one output holds the whole balance,
  // and an offer funded by two payments is still an offer.
  let held = 0n
  for (const entry of deposit.assets ?? []) {
    if (entry.assetId === assetId) held += entry.amount
  }
  return held
}

/**
 * The decision's input, from a decoded offer and an observed deposit.
 *
 * Pure: it does no reading of its own, so whoever calls it owns the freshness of
 * `deposit`. That is deliberate — the read is an indexer round trip with its own
 * failure modes, and burying it here would make this untestable without one.
 */
export const offerFillInputFrom = (offer: Offer, deposit: OfferDeposit): OfferFillInput => {
  const wantAssetId = idOf(offer.wantAsset)
  const offerAssetId = idOf(offer.offerAsset)
  return {
    wantAssetId,
    wantAmount: offer.wantAmount,
    offerAssetId,
    // OBSERVED, not parsed. @see the header.
    offerAmount: heldOf(deposit, offerAssetId),
  }
}
