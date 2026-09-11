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
