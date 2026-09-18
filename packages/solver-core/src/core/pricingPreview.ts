/**
 * Decomposes ONE quote by calling back into the resolvers that price it, so a
 * preview can never disagree with a real quote through independent arithmetic.
 */
import type { Price } from './priceFeed.js'
import { assetExactInPayout } from './assetExactInPrice.js'
import {
  carrierLegs,
  resolveAssetQuote,
  type AssetPair,
  type AssetQuoteMarket,
  type AssetQuoteRefusal,
} from './assetRfq.js'
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
  // The orchestrator's own selection (assetRfqOrchestrator.ts:252).
  const givesBase = pair.from === market.base
  const { charged, returned } = carrierLegs(pair, carrierSats)
  const flatFee = (givesBase ? market.sellBaseFeeFlat : market.buyBaseFeeFlat) ?? 0n

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
