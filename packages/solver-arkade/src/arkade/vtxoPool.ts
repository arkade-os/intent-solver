/**
 * How many coins the solver's float should be cut into, and what is missing.
 *
 * **Why a pool at all: reservations serialise an unshaped float.** Funding a
 * lockup pins the coins it spends (`reservations.ts`) so the renewal settle
 * cannot take them mid-send. With ONE coin that pin is the whole float, so the
 * second concurrent swap finds nothing unreserved and is refused — not queued,
 * refused. The reservation ledger is what makes concurrent funding SAFE; a pool
 * is what makes it POSSIBLE. Neither is much use without the other.
 *
 * ArkLabsHQ/coinflip shapes its house bankroll the same way and for the same
 * reason, and two of its conclusions are taken directly:
 *
 * - **Lean small.** A small coin is usable by every swap, a large one only by
 *   large swaps, so the same float supports more concurrent swaps when it
 *   leans small. Multi-input funding already exists here
 *   ({@link selectLockupFunding} accumulates), so big swaps compose.
 * - **Ask what you are SHORT of, per size** — not "how many pieces can I
 *   afford?", which both starves a small float and keeps re-minting a size the
 *   pool already has plenty of.
 *
 * Pure: no wallet, no clock, no I/O. The awkward cases — a float too small for
 * even one piece, the count ceiling, dust — are table tests rather than
 * something only a live regtest can reach.
 */

/** One rung of the target shape. */
export interface PoolRung {
  /** Piece size in sats. */
  size: number
  /** How many pieces of this size the pool wants. */
  want: number
}

/** What the pool is short of, and why it is not being fixed when it is not. */
export interface PoolPlan {
  /** Piece sizes to mint, in the order they should be created. Empty when nothing is needed. */
  outputs: readonly number[]
  /** Always populated, including when `outputs` is empty — see below. */
  reason: string
}

/**
 * The target shape, derived from settings that already exist.
 *
 * `maxExposedSats / maxSats` is how many max-size swaps the exposure cap
 * already permits in flight, so it is exactly the concurrency the pool has to
 * serve — deriving from it means the pool tracks the cap instead of drifting
 * from it, and adds no knob an operator has to keep in step.
 *
 * Two rungs, not three: this service's swap range is far narrower than a
 * casino's bet range (500..1000 sats on bitcoin), so a third rung would be
 * three names for the same size. `maxSats` pieces fund any swap alone;
 * quarter-size pieces let small swaps lock little and compose for large ones.
 *
 * `+1` on the large rung is deliberate slack: with exactly as many pieces as
 * the cap permits, one in-flight swap leaves the next unable to find a whole
 * piece and forced to compose from the small rung.
 */
export const poolTarget = (maxSats: number, maxExposedSats: number): PoolRung[] => {
  const concurrent = Math.max(1, Math.floor(maxExposedSats / Math.max(1, maxSats)))
  const small = Math.max(1, Math.floor(maxSats / 4))
  return [
    { size: small, want: concurrent * 2 },
    { size: maxSats, want: concurrent + 1 },
  ]
}

/** Which rung a coin counts toward: the largest rung it can fully serve. */
const rungOf = (value: number, target: readonly PoolRung[]): number => {
  let index = -1
  for (let i = 0; i < target.length; i++) {
    const rung = target[i]
    if (rung !== undefined && value >= rung.size) index = i
  }
  return index
}

/**
 * What to mint so the float matches {@link poolTarget}.
 *
 * `reason` is populated even when `outputs` is empty, because "already
 * matches", "nothing spendable", and "float too small for even one piece" are
 * three different states calling for three different operator responses, and
 * an empty plan with no explanation reads as healthy in all three.
 */
export const planPool = (args: {
  /**
   * Values of the coins available to split — already filtered of reserved.
   * Near-expiry coins are deliberately IN; {@link poolPlan} says why.
   */
  spendable: readonly number[]
  target: readonly PoolRung[]
  /** Ceiling on total pieces, so a large float is not shredded without bound. */
  maxCount: number
  /** Outputs one split transaction may create. */
  maxOutputs: number
  dust: number
}): PoolPlan => {
  const { spendable, target, maxCount, maxOutputs, dust } = args
  if (target.length === 0) return { outputs: [], reason: 'no pool target configured' }

  const headroom = maxCount - spendable.length
  if (headroom < 1) {
    return { outputs: [], reason: `pool at its ceiling — ${spendable.length}/${maxCount} pieces` }
  }

  const bankroll = spendable.reduce((sum, value) => sum + value, 0)
  if (bankroll <= dust) return { outputs: [], reason: `nothing spendable to split — ${bankroll} sat` }

  const have = target.map(() => 0)
  for (const value of spendable) {
    const rung = rungOf(value, target)
    if (rung >= 0) {
      const count = have[rung]
      if (count !== undefined) have[rung] = count + 1
    }
  }

  const smallest = target[0]
  if (smallest !== undefined && bankroll < smallest.size + dust) {
    return {
      outputs: [],
      reason: `float ${bankroll} sat is below one ${smallest.size} sat piece plus dust — fund the solver`,
    }
  }

  const short = target
    .map((rung, i) => ({ size: rung.size, missing: rung.want - (have[i] ?? 0) }))
    .filter((rung) => rung.missing > 0)

  if (short.length === 0) {
    const shape = target.map((rung, i) => `${have[i] ?? 0}x${rung.size}`).join(' ')
    return { outputs: [], reason: `pool already matches its target — ${shape}` }
  }

  // Round-robin from the smallest rung, so one expensive rung cannot consume a
  // whole transaction's output budget and starve the others.
  const outputs: number[] = []
  const remaining = short.map((rung) => ({ ...rung }))
  let budget = bankroll - dust
  let progress = true
  while (progress && outputs.length < Math.min(headroom, maxOutputs)) {
    progress = false
    for (const rung of remaining) {
      if (outputs.length >= Math.min(headroom, maxOutputs)) break
      if (rung.missing <= 0 || budget < rung.size) continue
      outputs.push(rung.size)
      budget -= rung.size
      rung.missing--
      progress = true
    }
  }

  if (outputs.length === 0) {
    return { outputs: [], reason: `float ${bankroll} sat cannot afford any missing piece` }
  }
  const shape = target.map((rung, i) => `${have[i] ?? 0}/${rung.want}x${rung.size}`).join(' ')
  return { outputs, reason: `minting ${outputs.length} piece(s) toward ${shape}` }
}

/**
 * Carve one renewal's proceeds into the pool's target shape.
 *
 * WHY THIS EXISTS RATHER THAN A SECOND TRANSACTION. A renewal settles the float
 * and, given one output, hands it all back as a single coin — which is what makes
 * the float unable to fund more than one swap at a time until something splits it
 * again. `settle` takes an ARRAY of outputs, so the split can happen inside the
 * renewal: one batch instead of two, no window where the whole float sits on one
 * coin, and one intent-fee round rather than two.
 *
 * WHY THE FEE IS INJECTED AND EVALUATED PER PIECE. An operator's intent fee is a
 * CEL expression, not a constant: a live regtest server answers
 * `offchainOutput: "0.0"` while `offchainInput` is `"amount * 0.01"`, and either
 * could be flat, proportional, or neither. So `gross - n * fee` is wrong for a
 * flat fee and wrong again for a proportional one. Every piece is costed at its
 * OWN size through {@link SplitRenewalArgs.outputFeeOn}, and nothing here assumes
 * a shape.
 *
 * The allocation is greedy, largest rung first, and deliberately conservative: a
 * piece is only taken when the remainder can pay for it AND its fee, so the sum
 * of `amount + fee` over the result can never exceed `gross`. Whatever is left
 * becomes a final piece if it can pay for itself, and is otherwise abandoned into
 * the last piece rather thancreating an output below dust.
 *
 * Returns a single whole-`gross` output when no rung fits, so a deployment with no
 * target renews as it did — unless `gross` is past `maxAmount`, which is cut (#27).
 */
export interface SplitRenewalArgs {
  /** Input value minus input fees — what there is to divide, before output fees. */
  gross: bigint
  target: readonly PoolRung[]
  dust: bigint
  /** The server's own cost for one offchain output of this size. */
  outputFeeOn: (amount: bigint) => bigint
  /** Outputs one settlement may create. */
  maxOutputs: number
  /** Per-output ceiling; `-1n` means none. Required: forgetting it burns the tail. */
  maxAmount: bigint
}

export const splitRenewalOutputs = (args: SplitRenewalArgs): bigint[] => {
  const { gross, target, dust, outputFeeOn, maxOutputs, maxAmount } = args
  if (gross <= 0n || maxOutputs < 1) return []

  const capped = (amount: bigint): bigint => (maxAmount >= 0n && amount > maxAmount ? maxAmount : amount)
  const tailSlots = (value: bigint): number => {
    const unit = maxAmount + outputFeeOn(maxAmount)
    return unit <= 0n ? 1 : Number((value + unit - 1n) / unit)
  }

  /** The largest piece that still leaves room for its own fee out of `budget`. */
  const fitWithin = (budget: bigint): bigint => {
    // Converges immediately for a flat fee and in a step or two for a
    // proportional one; bounded so a pathological expression cannot spin.
    let amount = budget - outputFeeOn(budget)
    for (let i = 0; i < 8 && amount > 0n && amount + outputFeeOn(amount) > budget; i++) {
      amount = budget - outputFeeOn(amount)
    }
    return amount
  }

  const pieces: bigint[] = []
  let remaining = gross
  // Largest first: the float is shaped into the pieces that can fund the biggest
  // swaps before it is spent down on small ones.
  for (const rung of [...target].sort((a, b) => b.size - a.size)) {
    const size = BigInt(rung.size)
    if (size < dust) continue
    if (maxAmount >= 0n && size > maxAmount) continue
    for (let taken = 0; taken < rung.want && pieces.length < maxOutputs - 1; taken++) {
      const cost = size + outputFeeOn(size)
      // STRICTLY GREATER, not >=: the remainder still has to become an output,
      // and one that cannot pay its own fee is not an output.
      if (remaining - cost < dust) break
      // Leave the remainder the outputs it needs: unplaced value is burnt.
      if (maxAmount >= 0n && pieces.length + 1 + tailSlots(remaining - cost) > maxOutputs) break
      pieces.push(size)
      remaining -= cost
    }
  }

  // `>= dust`, not `>= 0n`: a ceiling under dust admits no compliant output.
  while (maxAmount >= dust && pieces.length < maxOutputs - 1 && fitWithin(remaining) > maxAmount) {
    pieces.push(maxAmount)
    remaining -= maxAmount + outputFeeOn(maxAmount)
  }

  const last = capped(fitWithin(remaining))
  if (last >= dust) {
    pieces.push(last)
  } else if (pieces.length > 0) {
    // Too little to stand alone: fold it into the last piece rather than emit a
    // sub-dust output the server would refuse. The fee is re-evaluated because
    // the piece just grew, and it stays affordable because `remaining` was
    // already reserved for an output of its own.
    const grown = capped(fitWithin(remaining + pieces[pieces.length - 1]! + outputFeeOn(pieces[pieces.length - 1]!)))
    pieces[pieces.length - 1] = grown
  }
  return pieces
}
