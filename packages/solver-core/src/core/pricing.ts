/**
 * What the solver keeps from a swap, as a DECISION rather than a number.
 *
 * `corridorPolicy.ts`'s {@link Fee} is a static bps + flat pair fixed at
 * startup, so pricing cannot vary with size, with inventory, or with how much
 * float is left. That is the right default and a poor ceiling: it is exactly
 * the knob an operator running a real book wants to own, and owning it should
 * not require forking the corridor.
 *
 * `Fee` and `Config.corridorFees` are NOT going away — they are how the default
 * is configured. This is how the default is overridden.
 */
import { giveSatsFor, payoutSatsFor, type Fee } from './corridorPolicy.js'

export interface PricingStrategy {
  /**
   * Given what the client brings, what the solver delivers.
   *
   * MAY return zero or a negative number when a flat fee exceeds a small
   * amount. Callers must treat that as UNQUOTABLE rather than as a free swap,
   * and a strategy must not clamp it: "the fee ate the swap" and "the amount is
   * below the minimum" are different refusals with different reasons, and a
   * clamp to zero silently turns the first into a payout of nothing. Same
   * contract `payoutSatsFor` already states.
   */
  payoutFor(input: { pair: string; giveSats: number }): number

  /**
   * Given the payout a client asked for, what they must bring.
   *
   * Both directions are here because a quote can be requested from either end —
   * `amount_side: 'to'` asks "what must I give to receive X". Answering that by
   * inverting a one-way function is how a quote and its fill come to disagree
   * by a rounding step: `feeSatsFor` rounds UP, so the algebraic inverse lands
   * a sat low about as often as not.
   */
  giveFor(input: { pair: string; payoutSats: number }): number
}

/**
 * The default: one static {@link Fee} for the corridor, priced exactly as
 * `corridorPolicy.ts` has always priced it.
 *
 * Delegates rather than re-deriving. The rounding behaviour on both sides is
 * subtle enough that a second implementation would drift, and drift here moves
 * a quoted number for every deployment at once.
 */
export const fixedFeePricing = (fee: Fee): PricingStrategy => ({
  payoutFor: ({ giveSats }) => payoutSatsFor(giveSats, fee),
  giveFor: ({ payoutSats }) => giveSatsFor(payoutSats, fee),
})
