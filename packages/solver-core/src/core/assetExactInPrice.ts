import type { Price } from './priceFeed.js'

const BPS = 10_000n
const pow10 = (n: number): bigint => 10n ** BigInt(n)

/** Exact-in payout after conversion, then payout-side bps, with optional feed tolerance. */
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
  const mid = givesBase
    ? (netInput * feed.mantissa * (BPS + tolerance) * quoteUnit) / (baseUnit * scale * BPS)
    : (netInput * baseUnit * scale * BPS) / (quoteUnit * feed.mantissa * (BPS - tolerance))
  const fee = (mid * BigInt(feeBps) + BPS - 1n) / BPS
  return mid - fee
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
  const reaches = (netInput: bigint): boolean => assetExactInPayout({ netInput, ...rate }) >= payout

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
