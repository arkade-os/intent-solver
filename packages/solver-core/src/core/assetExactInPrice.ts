import type { Price } from './priceFeed.js'

const BPS = 10_000n
const pow10 = (n: number): bigint => 10n ** BigInt(n)

/**
 * Exact-in payout: ONE floor over the conceded value, with optional feed tolerance.
 * Not a floored mid minus a ceiled fee, which paid an atomic unit under what the
 * published client's `computeWantAmount` predicts from the same card.
 */
export const assetExactInPayout = (args: {
  netInput: bigint
  givesBase: boolean
  baseDecimals: number
  quoteDecimals: number
  feeBps: number
  toleranceBps?: number
  feed: Price
}): bigint => {
  const { netInput, givesBase, baseDecimals, quoteDecimals, feeBps, toleranceBps = 0, feed } = args
  const scale = pow10(feed.scale)
  const baseUnit = pow10(baseDecimals)
  const quoteUnit = pow10(quoteDecimals)
  const tolerance = BigInt(toleranceBps)
  const net = BPS - BigInt(feeBps)
  return givesBase
    ? (netInput * feed.mantissa * (BPS + tolerance) * quoteUnit * net) / (baseUnit * scale * BPS * BPS)
    : (netInput * baseUnit * scale * net) / (quoteUnit * feed.mantissa * (BPS - tolerance))
}

/**
 * The least `netInput` whose `assetExactInPayout` reaches `payout`, or null when none
 * does. Searched, not inverted, so exact-out adds no second rounding convention
 * (§ 7.1.5); sound because the forward function is monotonic in `netInput`.
 */
export const assetExactOutInput = (args: {
  payout: bigint
  givesBase: boolean
  baseDecimals: number
  quoteDecimals: number
  feeBps: number
  toleranceBps?: number
  feed: Price
}): bigint | null => {
  const { payout, ...rate } = args
  if (payout <= 0n) return null
  const reaches = (netInput: bigint): boolean => assetExactInPayout({ ...rate, netInput }) >= payout

  let hi = 1n
  for (let i = 0; i < 256 && !reaches(hi); i++) hi *= 2n
  if (!reaches(hi)) return null

  let lo = 1n
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    if (reaches(mid)) hi = mid
    else lo = mid + 1n
  }
  return lo
}
