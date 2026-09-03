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

/** What {@link networkFeePricing} needs to price one corridor's execution cost. */
export interface NetworkFeeInputs {
  /** The spread, and the flat used when no estimate is available. */
  base: Fee
  /**
   * What executing THIS swap is expected to cost the solver, in sats, or null
   * when unknown.
   *
   * A COST, not a rate, and that is the whole generality. Chain cost is
   * `vsize x sats/vbyte` and is the same for every amount; a Lightning routing
   * fee depends on the amount and the destination and is not expressible as a
   * rate at all. Both backends can answer "what will this one cost me" — LND
   * already answers it, though only by REFUSING with `maxFeeSats does not
   * cover fee estimate [value: 10, expected: 11 sats]` — so that is the
   * question to ask. See {@link onchainCostSats} for the chain shape.
   *
   * SYNCHRONOUS, which does NOT mean the number has to come from a cache.
   * It means the asking happens BEFORE pricing is consulted, and that the
   * corridor owns it rather than this.
   *
   * Two shapes both fit, and they are quite different:
   *
   *  - A REFRESHED value. Chain cost is `vsize x sats/vbyte`; the rate moves
   *    slowly, is the same for every swap, and is worth sampling on a schedule
   *    rather than per quote. `onchainCostSats` closes over such a value.
   *  - A PREPARED one. Some backends split a send into prepare-then-execute:
   *    the first call returns the fee for THIS payment, the second spends
   *    against it. A corridor that awaits the prepare at quote time can close
   *    over the exact figure it was quoted — no rate, no modelling, no
   *    sampling — and this reads it synchronously because by then it is just a
   *    number.
   *
   * What it must not become is an upstream call made from inside pricing, on
   * the hot path, once per quote request, by anything a taker can trigger.
   *
   * A prepared fee is still not a promise. A quote is followed by the client
   * funding a lockup, which takes as long as it takes, so the fee can move
   * before the corridor executes. That gap is what `maxFeeSats` guards at
   * payment time; this only makes the QUOTE honest.
   */
  costSats: (input: { pair: string; giveSats: number }) => number | null
  /**
   * The most this may charge for execution, whatever the estimate says.
   *
   * Not a safety rail so much as the number worth publishing: a signed
   * registry card cannot carry a live estimate, so a taker's only durable
   * guarantee is a ceiling the solver undertakes not to exceed. It also bounds
   * the damage from a bad reading — a source returning a spike, or the wrong
   * units, otherwise quotes an absurd price rather than a refusal.
   */
  capSats: number
  /**
   * The least this will charge flat, however cheap execution turns out to be.
   * Defaults to 0, which is the behaviour of not setting it.
   *
   * A SEPARATE NUMBER FROM `base.flatSats`, and the distinction is the point.
   * `base.flatSats` answers "what do I think this costs" and is the fallback
   * when nothing better is known; this answers "what is the least I will do
   * this for". Reusing one field for both would over-collect exactly when the
   * estimate is good: an operator who configured 300 as a guess at chain cost
   * would keep charging 300 on a quiet mempool that actually cost 50.
   *
   * It exists because network cost is not the solver's only cost. A swap ties
   * up float, carries the risk of a refund, and takes operational attention,
   * none of which fall to zero because fees did. `bps` covers what scales with
   * size; this covers what does not.
   *
   * A floor above the ceiling is rejected at construction, which is what makes
   * the two safe to combine — and makes the order they are applied in
   * unobservable, since they can only ever disagree on a pair that never gets
   * built. Do not read significance into it; the guard is the thing.
   */
  minSats?: number
}

/**
 * The chain shape of {@link NetworkFeeInputs.costSats}: a transaction of a
 * known size at the current rate.
 *
 * `vsize` is per CORRIDOR, not per market, because the two onchain directions
 * do not pay the same cost. On receive the solver claims the taker's HTLC and
 * pays for that spend, which `solver-rails`' claim sizing measures exactly. On
 * send the solver funds the HTLC and the TAKER pays to claim it, so charging a
 * claim's worth on a send quote bills for a transaction the solver never
 * broadcasts.
 *
 * Ignores `giveSats`: a transaction's size does not depend on the amount it
 * carries. A Lightning estimator's does, which is why the general form takes
 * the swap and this one throws it away.
 */
export const onchainCostSats = (vsize: number, feeRate: () => number | null) => (): number | null => {
  const rate = feeRate()
  return rate === null ? null : rate * vsize
}

/**
 * The corridor's spread, plus the cost it will actually pay to execute,
 * priced now.
 *
 * `fixedFeePricing`'s flat is a number an operator guessed at boot against a
 * cost that moves: a fee spike and the solver eats the difference, a quiet
 * network and the taker is overcharged for an execution that cost less.
 *
 * NOT ONLY ONCHAIN. A Lightning routing fee moves the same way and is just as
 * knowable in advance — a real backend already computes one, and today the
 * solver only ever learns it by being refused for budgeting too little. Any
 * corridor whose backend can answer "what will this cost me" can use this;
 * `onchainCostSats` is one shape of that answer, not the only one.
 *
 * The flat is REPLACED rather than added to. `Fee.flatSats` already means "the
 * fixed cost this corridor pays" — adding a live estimate on top would charge
 * it twice — so the configured number becomes the fallback for when no
 * estimate is available, which is the one case where a guess still beats
 * nothing. Never zero on a missing estimate: quoting no execution cost is how
 * the solver ends up paying it.
 *
 * The bps component is untouched. It covers proportional risk — capital tied
 * up, inventory — and that does not move with a fee market.
 */
export const networkFeePricing = ({ base, costSats, capSats, minSats = 0 }: NetworkFeeInputs): PricingStrategy => {
  // At construction, where it is loud and once, rather than per quote. A floor
  // above the ceiling is not a preference to resolve — it is two settings that
  // cannot both be honoured, and picking a winner silently would leave an
  // operator believing in whichever one this chose.
  if (minSats > capSats) {
    throw new Error(`networkFeePricing: minSats ${minSats} exceeds capSats ${capSats}, so the cap can never hold`)
  }
  const feeNow = (input: { pair: string; giveSats: number }): Fee => {
    const cost = costSats(input)
    // The floor applies to the fallback too: not knowing the cost is not a
    // reason to work for less than the minimum.
    const known = cost === null || !Number.isFinite(cost) || cost < 0 ? base.flatSats : Math.ceil(cost)
    return { bps: base.bps, flatSats: Math.max(minSats, Math.min(known, capSats)) }
  }
  // Read ONCE per call and shared by both directions of that call, so a
  // refresh landing mid-quote cannot make `payoutFor` and `giveFor` disagree
  // about the same swap — which is exactly the drift `giveFor` exists to stop.
  return {
    payoutFor: ({ pair, giveSats }) => payoutSatsFor(giveSats, feeNow({ pair, giveSats })),
    // Priced against the GIVE, which `giveFor` is solving for and does not yet
    // have. A Lightning estimate varies with the amount, so this is the one
    // place the two directions can disagree: the payout is the closest known
    // proxy, and it understates the give by exactly the fee. Corridors whose
    // cost is amount-independent — every onchain one — are unaffected.
    giveFor: ({ pair, payoutSats }) => giveSatsFor(payoutSats, feeNow({ pair, giveSats: payoutSats })),
  }
}
