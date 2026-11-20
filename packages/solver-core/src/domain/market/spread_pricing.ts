import type { Fee } from './fee.js'
import type { Limits } from './limits.js'
import { PricedQuote, QuoteRefusal, QuoteSide } from './quote_terms.js'

/** One asset on both sides: the client gives an amount and receives it minus the fee. */
export class SpreadPricing {
  readonly kind = 'spread'

  private constructor(
    readonly fee: Fee,
    /** Limits on the amount the client gives. */
    readonly limits: Limits,
  ) {}

  static of(fee: Fee, limits: Limits): SpreadPricing {
    return new SpreadPricing(fee, limits)
  }

  // The range is checked before the fee: an amount in range that the fee eats is `fee_consumes_swap`, not out of range.
  // `minOutput` is the smallest output the destination can hold; zero where it has no such floor.
  quote(amount: bigint, side: QuoteSide, minOutput = 0n): PricedQuote {
    const give = side === QuoteSide.To ? this.fee.giveFor(amount) : amount
    if (this.limits.breach(give) !== null) return PricedQuote.refused(QuoteRefusal.AmountOutOfRange)
    const payout = side === QuoteSide.To ? amount : this.fee.payoutFor(give)
    if (payout <= 0n) return PricedQuote.refused(QuoteRefusal.FeeConsumesSwap)
    return payout < minOutput ? PricedQuote.refused(QuoteRefusal.PayoutBelowDust) : { ok: true, give, payout }
  }
}
