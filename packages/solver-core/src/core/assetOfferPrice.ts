/**
 * Whether an offer's implied price is one this solver will take.
 *
 * `assetOffer.ts` answers "could we fill this at all" and says pricing is
 * decided elsewhere. This is elsewhere. Without it a solver fills at ANY price
 * a maker names, which is the gate the Arkade Swap Protocol § 5.2 lists third
 * and the reference solver applies before solvency.
 *
 * EXACT, never float. The feed price is a `Price` (`mantissa / 10 ** scale`)
 * and both amounts stay bigint through the same conversion-and-fee helper used
 * by RFQ quotes. The reference implementation uses float64 here; at 6-decimal
 * stablecoin amounts against a sats leg the rounding is real, and it decides
 * money.
 */
import type { Price } from './priceFeed.js'
import { assetExactInPayout } from './assetExactInPrice.js'

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
  /** Atomic units of the base deposit, charged when the maker sells base. */
  sellBaseFeeFlat?: bigint
  /** Atomic units of the quote deposit, charged when the maker buys base. */
  buyBaseFeeFlat?: bigint
}

/**
 * One whole unit, in basis points — and the EXCLUSIVE ceiling on both bps knobs
 * below.
 *
 * Exported so configuration can refuse what this function refuses without
 * copying the number. `assetMarketConfig.ts` validates an operator's spread
 * against this exact constant: a config bound written as its own literal could
 * be widened by one edit while the runtime guard stayed put, which would store
 * a market that validates and is then refused on every offer — or, worse,
 * loosened here alone, which is the fund-loss the guard exists to stop.
 */
export const BPS_DENOMINATOR = 10_000

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
  // Both bounds are checked at BPS. A buy-base tolerance at BPS makes its
  // adjusted feed price zero, so every payout would appear affordable (and the
  // exact formula would divide by zero). That is the gate switched off, not a
  // useful configuration, so it is refused rather than honoured.
  if (market.toleranceBps < 0 || market.toleranceBps >= BPS_DENOMINATOR) return false
  if (market.feeBps < 0 || market.feeBps >= BPS_DENOMINATOR) return false

  const flatFee = (direction === 'sell_base' ? market.sellBaseFeeFlat : market.buyBaseFeeFlat) ?? 0n
  if (flatFee < 0n) return false
  const netDeposit = depositAmount - flatFee
  if (netDeposit <= 0n) return false

  const payout = assetExactInPayout({
    netInput: netDeposit,
    givesBase: direction === 'sell_base',
    baseDecimals: market.baseDecimals,
    quoteDecimals: market.quoteDecimals,
    feeBps: market.feeBps,
    toleranceBps: market.toleranceBps,
    feed,
  })
  return wantAmount <= payout
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
