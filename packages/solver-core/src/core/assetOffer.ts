/**
 * Whether an Arkade asset-swap OFFER is one this solver can fill.
 *
 * These swaps are NOT HTLCs, which is why this file is short: both legs are on Arkade
 * and the maker's covenant forces the fill to pay them, so the settling transaction
 * either confirms or does not. No exposure window, hence no deadline gate, recourse
 * margin or refund reasoning.
 *
 * The solver is the TAKER, never the maker. An offer is a standing commitment with no
 * intrinsic expiry, so publishing one writes a free option: its price sits on-chain
 * while the market moves, and a rational counterparty fills only once it has turned
 * against the solver.
 *
 * Pricing is decided elsewhere. This answers only "could we fill this at all".
 */

/**
 * The subset of a decoded offer this reads.
 *
 * Not `@arkade-os/swap`'s `Offer`, and not structurally compatible with it:
 * `Offer.wantAsset` is an optional `asset.AssetId` class, where this takes a
 * `string | null`. The adapter maps `AssetId -> serializeAssetId(...)` and
 * `undefined -> null` ("no asset" means BTC on that leg).
 *
 * The 68-hex form is worth that mapping: this decision compares assets for equality
 * and looks them up in a `Map`, and a `(Uint8Array, number)` pair does neither.
 */
export interface OfferFillInput {
  /** The asset the maker WANTS, canonical 68-hex, or null for BTC. */
  wantAssetId: string | null
  /** Asset base units, or sats when null. */
  wantAmount: bigint
  /** The asset the maker DEPOSITED, or null for BTC. What the solver collects. */
  offerAssetId: string | null
  /** What the offer's own lockup holds. */
  offerAmount: bigint
}

/** What this solver is willing and able to fill. */
export interface OfferFillPolicy {
  /** Markets served, each an unordered pair with `null` standing for BTC. */
  markets: readonly { readonly a: string | null; readonly b: string | null }[]
  /** Spendable balance per asset id. Only what could be paid out RIGHT NOW. */
  available: ReadonlyMap<string | null, bigint>
  /**
   * Inclusive bounds on the payout, in the want-leg's units.
   *
   * `min > max` is not rejected here — a pure decision function has no channel to
   * report a config error — and refuses every offer `amount_out_of_range`, which reads
   * like a quiet market. Whatever builds this policy should validate the pair.
   */
  minFillAmount: bigint
  maxFillAmount: bigint
}

export type OfferFillRefusal =
  /** Both legs name the same thing. The covenant would still oblige us to pay. */
  | 'degenerate_pair'
  | 'unsupported_pair'
  | 'amount_out_of_range'
  | 'insufficient_inventory'
  /** The offer's own deposit is zero, so filling it collects nothing. */
  | 'offer_unfunded'
  /**
   * Outside the market's tolerance of the price feed. NOT returned by
   * `evaluateOfferFill` — pricing is decided elsewhere (@see assetOfferPrice.ts)
   * — but it is a refusal of the same fill, so it belongs in the same set.
   */
  | 'price_out_of_tolerance'
  /**
   * The offer's script does not encode the terms it states (Swap Protocol V1
   * § 5.1). Decided by the adapter that can reconstruct the script, not here.
   */
  | 'offer_inconsistent'

export type OfferFillDecision = { fill: true } | { fill: false; reason: OfferFillRefusal }

/** Unordered pair equality — a market is a market in both directions. */
const sameMarket = (market: { a: string | null; b: string | null }, x: string | null, y: string | null): boolean =>
  (market.a === x && market.b === y) || (market.a === y && market.b === x)

/**
 * Can this solver fill this offer?
 *
 * Ordered cheapest-and-most-structural first, so a logged reason is the most specific
 * true statement rather than whichever gate ran first.
 */
export const evaluateOfferFill = (offer: OfferFillInput, policy: OfferFillPolicy): OfferFillDecision => {
  if (offer.wantAssetId === offer.offerAssetId) {
    return { fill: false, reason: 'degenerate_pair' }
  }
  // BEFORE market membership: an unfunded offer is malformed for every solver, whereas
  // `unsupported_pair` is only true of this one's config, and reporting that would
  // invite an operator to "fix" it by widening `markets`.
  if (offer.offerAmount <= 0n) {
    return { fill: false, reason: 'offer_unfunded' }
  }

  if (!policy.markets.some((m) => sameMarket(m, offer.wantAssetId, offer.offerAssetId))) {
    return { fill: false, reason: 'unsupported_pair' }
  }

  if (offer.wantAmount < policy.minFillAmount || offer.wantAmount > policy.maxFillAmount) {
    return { fill: false, reason: 'amount_out_of_range' }
  }

  // Inventory last: the only gate whose answer changes minute to minute, so a refusal
  // here is the one worth retrying.
  const held = policy.available.get(offer.wantAssetId) ?? 0n
  if (held < offer.wantAmount) {
    return { fill: false, reason: 'insufficient_inventory' }
  }

  return { fill: true }
}
