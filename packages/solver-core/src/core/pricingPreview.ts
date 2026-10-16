/**
 * Decomposes ONE quote by calling back into the resolvers that price it, so a
 * preview can never disagree with a real quote through independent arithmetic.
 */
import type { Price } from './priceFeed.js'
import { assetExactInPayout } from './assetExactInPrice.js'
import {
  assetFlatFeeFor,
  assetQuoteGivesBase,
  carrierLegs,
  resolveAssetQuote,
  type AssetPair,
  type AssetQuoteMarket,
  type AssetQuoteRefusal,
} from './assetRfq.js'
import { offerWithinTolerance, type OfferDirection, type OfferPriceMarket } from './assetOfferPrice.js'
import { feeSatsFor, giveSatsFor, payoutSatsFor, type Fee } from './corridorPolicy.js'

export interface AssetDecomposition {
  ok: true
  fromAmount: bigint
  toAmount: bigint
  /** The payout at a zero spread — the true notional the margin is measured on. TO units. */
  midPayout: bigint
  /** What the spread keeps. TO units. */
  spreadFee: bigint
  /** The market's flat fee for this direction. FROM units. */
  flatFee: bigint
  /** Sats netted off the deposit, and sats added to the payout. At most one is non-zero. */
  carrierCharged: bigint
  carrierReturned: bigint
  /** `spreadFee * 10_000 / midPayout`. Null when there is no notional to divide by. */
  marginBps: number | null
}

export type AssetPreview = AssetDecomposition | { ok: false; reason: AssetQuoteRefusal }

export const decomposeAssetQuote = (args: {
  pair: AssetPair
  amount: bigint
  amountSide: 'from' | 'to'
  market: AssetQuoteMarket
  feed: Price
  carrierSats: bigint
  dustSats: bigint
}): AssetPreview => {
  const outcome = resolveAssetQuote(args)
  if (!outcome.ok) return outcome

  const { pair, market, feed, carrierSats } = args
  const givesBase = assetQuoteGivesBase(pair, market)
  // Never null: `outcome.ok` means resolveAssetQuote already matched this pair to `market`.
  if (givesBase === null) return { ok: false, reason: 'unsupported_pair' }
  const { charged, returned } = carrierLegs(pair, carrierSats)
  const flatFee = assetFlatFeeFor(givesBase, market)

  // The notional, recovered by re-pricing the SAME input at a zero spread.
  const midPayout = assetExactInPayout({
    netInput: outcome.fromAmount - flatFee - charged,
    givesBase,
    baseDecimals: market.baseDecimals,
    quoteDecimals: market.quoteDecimals,
    feeBps: 0,
    feed,
  })
  const payout = outcome.toAmount - returned
  const spreadFee = midPayout - payout
  return {
    ok: true,
    fromAmount: outcome.fromAmount,
    toAmount: outcome.toAmount,
    midPayout,
    spreadFee,
    flatFee,
    carrierCharged: charged,
    carrierReturned: returned,
    marginBps: midPayout > 0n ? Number((spreadFee * 10_000n) / midPayout) : null,
  }
}

export type CorridorRefusal = 'below_min' | 'above_max' | 'fee_consumes_swap'

export interface CorridorDecomposition {
  ok: true
  giveSats: number
  payoutSats: number
  /** The proportional half, through `feeSatsFor` with the flat zeroed — never a second ceil. */
  spreadSats: number
  flatSats: number
  marginBps: number | null
}

export type CorridorPreview = CorridorDecomposition | { ok: false; reason: CorridorRefusal }

export const decomposeCorridorQuote = (args: {
  amountSats: number
  amountSide: 'from' | 'to'
  fee: Fee
  limits: { minSats: number; maxSats: number }
}): CorridorPreview => {
  const { amountSats, amountSide, fee, limits } = args
  if (!Number.isInteger(amountSats) || amountSats <= 0) return { ok: false, reason: 'fee_consumes_swap' }
  const giveSats = amountSide === 'from' ? amountSats : giveSatsFor(amountSats, fee)
  // The GIVE leg, which is what `receive/orchestrator.ts:432` compares.
  if (giveSats < limits.minSats) return { ok: false, reason: 'below_min' }
  if (giveSats > limits.maxSats) return { ok: false, reason: 'above_max' }
  const payoutSats = payoutSatsFor(giveSats, fee)
  if (payoutSats <= 0) return { ok: false, reason: 'fee_consumes_swap' }
  return {
    ok: true,
    giveSats,
    payoutSats,
    spreadSats: feeSatsFor(giveSats, { bps: fee.bps, flatSats: 0 }),
    flatSats: fee.flatSats,
    marginBps: Math.round((feeSatsFor(giveSats, fee) * 10_000) / giveSats),
  }
}

export type BreakEven = { kind: 'none' } | { kind: 'never' } | { kind: 'at'; amountSats: bigint }

/**
 * The deposit at which the spread starts covering an unpriced carrier.
 * `carrierSats` is the DEPLOYMENT's dust, not the quote's — pass `0n` on the
 * priced path, which has no break-even to print.
 */
export const carrierBreakEven = (args: { carrierSats: bigint; flatSats: bigint; feeBps: number }): BreakEven => {
  const { carrierSats, flatSats, feeBps } = args
  if (carrierSats <= 0n || flatSats >= carrierSats) return { kind: 'none' }
  if (feeBps <= 0) return { kind: 'never' }
  const bps = BigInt(feeBps)
  return { kind: 'at', amountSats: flatSats + ((carrierSats - flatSats) * 10_000n + bps - 1n) / bps }
}

/**
 * Largest `wantAmount` accepted against `depositAmount`, or null if none is.
 * Searched over the monotonic `offerWithinTolerance` gate rather than inverted.
 */
export const offerAcceptanceCeiling = (args: {
  depositAmount: bigint
  direction: OfferDirection
  market: OfferPriceMarket
  feed: Price
  carrierCharged?: bigint
  carrierReturned?: bigint
}): bigint | null => {
  const accepts = (wantAmount: bigint): boolean => offerWithinTolerance({ ...args, wantAmount })
  if (!accepts(1n)) return null
  let lo = 1n
  let hi = 2n
  for (let i = 0; i < 256 && accepts(hi); i++) {
    lo = hi
    hi *= 2n
  }
  // A positive feed makes the payout finite so doubling terminates; unbounded
  // reads as "no answer" rather than a number nobody can defend.
  if (accepts(hi)) return null
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n
    if (accepts(mid)) lo = mid
    else hi = mid
  }
  return lo
}
