/**
 * Whether an offer's implied price is one this solver will take.
 *
 * `assetOffer.ts` answers "could we fill this at all" and says pricing is
 * decided elsewhere. This is elsewhere. Without it a solver fills at ANY price
 * a maker names, which is the gate the Arkade Swap Protocol § 5.2 lists third
 * and the reference solver applies before solvency.
 *
 * EXACT, never float. The feed price is a `Price` (`mantissa / 10 ** scale`)
 * and both amounts are integers, so the comparison cross-multiplies into bigint
 * rather than dividing. The reference implementation uses float64 here; at
 * 6-decimal stablecoin amounts against a sats leg the rounding is real, and it
 * decides money.
 */
import type { Price } from './priceFeed.js'

/** Which side of the market the maker is on. */
export type OfferDirection = 'sell_base' | 'buy_base'

export interface OfferPriceMarket {
  /** Decimals of the base and quote legs, for the decimal adjustment. */
  baseDecimals: number
  quoteDecimals: number
  /** Deviation from the feed this solver will accept, basis points. */
  toleranceBps: number
  /** The solver's margin, folded into the offer price against the maker. */
  feeBps: number
}

const BPS = 10_000n
const pow10 = (n: number): bigint => 10n ** BigInt(n)

/**
 * Is the offer within tolerance of the feed?
 *
 * The feed quotes QUOTE PER BASE. The offer's price is the same ratio, decimal
 * adjusted, with `feeBps` nudged in the solver's favour — up when the maker
 * sells base, down when it buys — so an offer must beat the feed by the fee
 * before tolerance is even considered.
 *
 * Refuses a non-positive feed price rather than treating it as free: a zeroed
 * margin makes `buy_base` accept anything.
 */
export const offerWithinTolerance = (args: {
  /** What the maker deposited, in that asset's atomic units. */
  depositAmount: bigint
  /** What the maker asks for, in that asset's atomic units. */
  wantAmount: bigint
  direction: OfferDirection
  market: OfferPriceMarket
  feed: Price
}): boolean => {
  const { depositAmount, wantAmount, direction, market, feed } = args
  if (depositAmount <= 0n || wantAmount <= 0n) return false
  if (feed.mantissa <= 0n) return false
  // Both bounds are checked at BPS, and the tolerance one is not symmetry for
  // its own sake. `buy_base` compares against `feed * (BPS - tolerance)`: at a
  // tolerance of BPS or more that factor goes to zero or negative, `right` with
  // it, and `left >= right` is trivially true — the solver would accept ANY
  // buy_base offer at ANY price. A 100% tolerance is not a configuration, it is
  // the gate switched off, so it is refused rather than honoured.
  if (market.toleranceBps < 0 || market.toleranceBps >= 10_000) return false
  if (market.feeBps < 0 || market.feeBps >= 10_000) return false

  const tolerance = BigInt(market.toleranceBps)
  const fee = BigInt(market.feeBps)
  const scale = pow10(feed.scale)
  const base = pow10(market.baseDecimals)
  const quote = pow10(market.quoteDecimals)

  if (direction === 'sell_base') {
    // offer = (want / 10^qd) / (deposit / 10^bd) * (1 + fee)  <=  feed * (1 + tol)
    const left = wantAmount * base * (BPS + fee) * scale
    const right = feed.mantissa * (BPS + tolerance) * depositAmount * quote
    return left <= right
  }
  // buy_base: offer = (deposit / 10^qd) / (want / 10^bd) * (1 - fee)  >=  feed * (1 - tol)
  const left = depositAmount * base * (BPS - fee) * scale
  const right = feed.mantissa * (BPS - tolerance) * wantAmount * quote
  return left >= right
}

/**
 * The maker's side of `market`, or null when the offer is not on it.
 *
 * `null` is the BTC leg throughout, matching how the offer packet omits the
 * asset field rather than naming a BTC id.
 */
export const offerDirectionOn = (
  market: { base: string | null; quote: string | null },
  depositAssetId: string | null,
  wantAssetId: string | null,
): OfferDirection | null => {
  if (depositAssetId === market.base && wantAssetId === market.quote) return 'sell_base'
  if (depositAssetId === market.quote && wantAssetId === market.base) return 'buy_base'
  return null
}
