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

/** What {@link networkFeePricing} needs to price one corridor's chain cost. */
export interface NetworkFeeInputs {
  /** The spread, and the flat used when no rate is available. */
  base: Fee
  /**
   * Current sats/vbyte, or null when unknown.
   *
   * SYNCHRONOUS, and that is the design rather than a limitation.
   * `PricingStrategy` is synchronous because quoting is on the hot path: an
   * upstream call per quote adds its latency to every request and hands a
   * taker a way to amplify load onto the fee source. The caller is expected to
   * hand over a value it refreshes on its own schedule, and to return null
   * rather than a stale one it no longer trusts.
   */
  feeRate: () => number | null
  /**
   * vbytes of the transaction THIS corridor's solver must broadcast — and only
   * that one.
   *
   * The two onchain directions do not pay the same chain cost, which is why
   * this is per corridor and not per market. On receive the solver claims the
   * taker's HTLC and pays for that spend, which `solver-rails`' claim sizing
   * measures exactly. On send the solver funds the HTLC and the TAKER pays to
   * claim it, so charging a claim's worth on a send quote bills the taker for
   * a transaction the solver never broadcasts.
   */
  vsize: number
  /**
   * The most this may charge for chain cost, whatever the mempool says.
   *
   * Not a safety rail so much as the number worth publishing: a signed
   * registry card cannot carry a live rate, so a taker's only durable
   * guarantee is a ceiling the solver undertakes not to exceed. It also caps
   * the damage from a bad reading — a fee source returning a spike, or the
   * wrong units, otherwise quotes an absurd price rather than a refusal.
   */
  capSats: number
}

/**
 * The corridor's spread, plus the chain cost it will actually pay, priced now.
 *
 * `fixedFeePricing`'s flat is a number an operator guessed at boot against a
 * cost that moves: a spike and the solver eats the difference, a calm mempool
 * and the taker is overcharged for a transaction that cost less.
 *
 * The flat is REPLACED rather than added to. `Fee.flatSats` already means "the
 * fixed chain cost this corridor pays" — adding a live estimate on top would
 * charge it twice — so the configured number becomes the fallback for when no
 * rate is available, which is the one case where a guess still beats nothing.
 * Never zero on a missing rate: quoting no chain cost is how the solver ends
 * up paying it.
 *
 * The bps component is untouched. It covers proportional risk — capital tied
 * up, a routing fee that scales — and none of that varies with the mempool.
 */
export const networkFeePricing = ({ base, feeRate, vsize, capSats }: NetworkFeeInputs): PricingStrategy => {
  const feeNow = (): Fee => {
    const rate = feeRate()
    if (rate === null || !Number.isFinite(rate) || rate < 0) return base
    return { bps: base.bps, flatSats: Math.min(Math.ceil(rate * vsize), capSats) }
  }
  // Read ONCE per call and shared by both directions of that call, so a
  // refresh landing mid-quote cannot make `payoutFor` and `giveFor` disagree
  // about the same swap — which is exactly the drift `giveFor` exists to stop.
  return {
    payoutFor: ({ giveSats }) => payoutSatsFor(giveSats, feeNow()),
    giveFor: ({ payoutSats }) => giveSatsFor(payoutSats, feeNow()),
  }
}
