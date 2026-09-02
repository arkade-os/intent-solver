/**
 * Pricing an EVM transaction the corridor cannot afford to have stall.
 *
 * Most fee estimation optimises for cost. This one optimises for CONFIRMING
 * BEFORE A DEADLINE, because on this corridor a transaction that lingers is not
 * slow — it is a loss. The claim is the case: once the counterparty reveals a
 * preimage, the solver has until the other side's refund opens to get its own
 * claim mined. Miss that and the counterparty takes both legs.
 *
 * THE MECHANIC THAT MAKES THIS NON-OBVIOUS. Under EIP-1559 a transaction is
 * only includable while `maxFeePerGas >= baseFeePerGas`, and the base fee is
 * not static: it rises by up to **12.5% per block** when blocks are full. A fee
 * priced against the base fee observed at broadcast is therefore correct only
 * for the first block. Fourteen consecutive full blocks roughly quintuple it,
 * and a transaction whose `maxFeePerGas` was set at the market rate becomes
 * unincludable — silently, and precisely during the congestion where the
 * deadline is most at risk.
 *
 * So the ceiling is sized for the WHOLE window the transaction may need, by
 * compounding the worst-case rise across it.
 *
 * WHY OVERPAYING IS THE SAFE ERROR, and why this asymmetry justifies the whole
 * approach: `maxFeePerGas` is a CAP, not a price. The sender pays
 * `baseFeePerGas + priority` at inclusion time, so a ceiling far above the
 * market costs nothing when the market is calm. It only costs when the base fee
 * genuinely rises — which is exactly the case we sized it for. Underpricing
 * risks the swap; overpricing risks some gas.
 */

/**
 * EIP-1559 lets the base fee rise by at most an eighth per block — and never by
 * less than one wei, which is a floor in the protocol rather than a rounding
 * convenience. See {@link worstCaseBaseFee} for why that floor is load-bearing.
 */
const MAX_RISE_DENOMINATOR = 8n
const MIN_RISE = 1n

export interface FeeQuote {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

export interface FeeInputs {
  /** `baseFeePerGas` of the latest block. */
  baseFeePerGas: bigint
  /** What the chain currently wants as a tip — `eth_maxPriorityFeePerGas`. */
  tipPerGas: bigint
  /**
   * How many blocks this transaction may need to survive unmined.
   *
   * Derived by the caller from the time it actually has — the margin in
   * `core/evmSend.ts` — and the chain's cadence, rather than guessed. That is
   * the whole input that makes this deadline-aware rather than market-aware.
   */
  blocksOfHeadroom: number
  /**
   * A hard ceiling on `maxFeePerGas`, in wei.
   *
   * Not a safety bound — it is an affordability one. Compounding is
   * exponential, so a long window produces a number that would let a genuine
   * fee spike drain the account faster than an operator could react. Where it
   * binds, the transaction is priced as high as policy allows and the caller is
   * told, rather than silently priced under the window it needs.
   */
  maxFeeCeilingPerGas: bigint
}

/**
 * The highest the base fee can reach in `blocks`, from `baseFeePerGas`.
 *
 * This is EIP-1559's own step rather than an approximation of it: a maximally
 * full block raises the base fee by `max(parent / 8, 1)`. Integer arithmetic
 * throughout, because floats lose precision at wei scale.
 *
 * WHY NOT `parent * 9 / 8`. It agrees with the protocol for every base fee of
 * 8 wei or more — the two are the same expression once `parent / 8` is at
 * least one. Below that the division floors to zero and the fee becomes a FIXED
 * POINT: the function would report that a base fee of 7 can never rise, however
 * many blocks it is given. That is the unsafe direction the ceiling exists to
 * avoid, and it is not hypothetical for a corridor that targets ANY EVM chain —
 * a base fee decays by an eighth per empty block, so any chain quiet enough for
 * long enough arrives there and has no floor to stop it.
 *
 * WHY NOT ROUND THE MULTIPLY UP either, which fixes the fixed point by
 * accident: `ceil(parent * 9 / 8)` overshoots the protocol wherever `parent` is
 * not a multiple of 8 — 15 would give 17 where the chain can only reach 16 —
 * and compounds that error every block of the window.
 */
export const worstCaseBaseFee = (baseFeePerGas: bigint, blocks: number): bigint => {
  if (baseFeePerGas < 0n) throw new Error(`baseFeePerGas must not be negative, got ${baseFeePerGas}`)
  if (!Number.isInteger(blocks) || blocks < 0) throw new Error(`blocks must be a non-negative integer, got ${blocks}`)
  let fee = baseFeePerGas
  for (let i = 0; i < blocks; i++) {
    const rise = fee / MAX_RISE_DENOMINATOR
    fee += rise > MIN_RISE ? rise : MIN_RISE
  }
  return fee
}

export interface PricedFee extends FeeQuote {
  /**
   * True when {@link FeeInputs.maxFeeCeilingPerGas} bound the answer, so the
   * transaction is NOT priced for its full window.
   *
   * The caller must decide what that means — for a claim it is a reason to act
   * early or raise the ceiling, not something to log and proceed past.
   */
  cappedByPolicy: boolean
}

export const priceTransaction = (inputs: FeeInputs): PricedFee => {
  const { baseFeePerGas, tipPerGas, blocksOfHeadroom, maxFeeCeilingPerGas } = inputs
  if (tipPerGas < 0n) throw new Error(`tipPerGas must not be negative, got ${tipPerGas}`)
  if (maxFeeCeilingPerGas <= 0n) throw new Error(`maxFeeCeilingPerGas must be positive, got ${maxFeeCeilingPerGas}`)

  const wanted = worstCaseBaseFee(baseFeePerGas, blocksOfHeadroom) + tipPerGas
  const capped = wanted > maxFeeCeilingPerGas
  const maxFeePerGas = capped ? maxFeeCeilingPerGas : wanted

  return {
    maxFeePerGas,
    // The tip cannot exceed the cap: a node rejects `maxPriorityFeePerGas >
    // maxFeePerGas` outright, so a low ceiling must reduce the tip rather than
    // produce a transaction that cannot be submitted at all.
    maxPriorityFeePerGas: tipPerGas > maxFeePerGas ? maxFeePerGas : tipPerGas,
    cappedByPolicy: capped,
  }
}

/**
 * How many blocks fit in a deadline, for {@link FeeInputs.blocksOfHeadroom}.
 *
 * Uses the FASTEST cadence, the same direction `blockTime.ts` reads a deadline
 * with and for the same reason: more blocks means a higher ceiling, and being
 * wrong towards a higher ceiling costs gas, while being wrong towards a lower
 * one costs the swap.
 */
export const blocksBefore = (seconds: number, fastestSecondsPerBlock: number): number => {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`seconds must be positive, got ${seconds}`)
  if (!Number.isFinite(fastestSecondsPerBlock) || fastestSecondsPerBlock <= 0) {
    throw new Error(`fastestSecondsPerBlock must be positive, got ${fastestSecondsPerBlock}`)
  }
  return Math.ceil(seconds / fastestSecondsPerBlock)
}
