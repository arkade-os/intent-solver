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

/** One coin, as the planner sees it. */
export interface PoolCoin {
  /** `txid:vout`. */
  key: string
  value: number
  /** `usableSatsOf`: zero for a coin that is all asset dust. */
  usable: number
  expiresAtMs?: number
  hasAssets: boolean
  /** Renewal takes it this pass, so it is never a reshape input. */
  renewalDue: boolean
}

/** What to spend and pay back to the solver: rung pieces first, then the remainder. */
export interface PoolPlan {
  /** Empty exactly when `outputs` is. */
  inputs: readonly string[]
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
 * casino's bet range (500..50,000 sats on bitcoin by default), so a third rung would be
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
const rungOf = (value: number, target: readonly PoolRung[]): number =>
  target.findLastIndex((rung) => value >= rung.size)

const none = (reason: string): PoolPlan => ({ inputs: [], outputs: [], reason })

const byExpiry =
  (latestFirst: boolean) =>
  (a: PoolCoin, b: PoolCoin): number => {
    if (a.expiresAtMs === b.expiresAtMs) return 0
    if (a.expiresAtMs === undefined) return 1
    if (b.expiresAtMs === undefined) return -1
    return latestFirst ? b.expiresAtMs - a.expiresAtMs : a.expiresAtMs - b.expiresAtMs
  }

const evenly = (sum: number, parts: number): number[] =>
  Array.from({ length: parts }, (_, i) => Math.floor(sum / parts) + (i < sum % parts ? 1 : 0))

/**
 * What to spend so the float matches {@link poolTarget}, in either direction.
 *
 * Below the coin ceiling it splits loose coins into the pieces the target is short
 * of; at the ceiling it merges loose coins into those pieces plus one remainder,
 * kept whole because cutting it would refill the count the merge just drained.
 * Keepers — the latest-expiring coins worth about one piece — are what funding
 * picks first, so a reshape never pins them.
 *
 * `reason` is populated even when `outputs` is empty, because "already
 * matches", "nothing spendable", and "float too small for even one piece" are
 * three different states calling for three different operator responses, and
 * an empty plan with no explanation reads as healthy in all three.
 */
export const planPool = (args: {
  /** Already filtered of reserved coins. */
  coins: readonly PoolCoin[]
  target: readonly PoolRung[]
  /** Coin count at which the pool stops splitting and starts merging. */
  maxCount: number
  maxInputs: number
  /** Outputs one transaction may create, an asset carrier included. */
  maxOutputs: number
  /** The larger of dust and the operator's `vtxoMinAmount`. */
  minOutput: number
  /** Per-output ceiling; negative means none. */
  maxAmount: number
}): PoolPlan => {
  const { coins, target, maxCount, maxInputs, maxOutputs, minOutput, maxAmount } = args
  if (target.length === 0) return none('no pool target configured')
  if (maxAmount >= 0 && maxAmount < minOutput) {
    return none(`the operator's ${maxAmount} sat per-output ceiling is below its ${minOutput} sat floor`)
  }
  const total = coins.reduce((sum, coin) => sum + coin.value, 0)
  if (total <= 0) return none(`nothing spendable — ${total} sat`)

  const ceiling = Math.max(
    maxCount,
    target.reduce((sum, rung) => sum + rung.want, 0),
  )
  const largest = Math.max(...target.map((rung) => rung.size))
  const smallest = Math.min(...target.map((rung) => rung.size))

  const kept = new Set<PoolCoin>()
  const have = target.map(() => 0)
  for (const coin of [...coins].sort(byExpiry(true))) {
    const rung = rungOf(coin.usable, target)
    if (rung < 0 || coin.usable >= 2 * largest || have[rung]! >= target[rung]!.want) continue
    have[rung]!++
    kept.add(coin)
  }
  const shape = target.map((rung, i) => `${have[i]}/${rung.want}x${rung.size}`).join(' ')
  const eligible = coins.filter((coin) => !kept.has(coin) && !coin.renewalDue)

  const consolidating = coins.length >= ceiling
  const inputs: PoolCoin[] = []
  let gross = 0
  if (consolidating) {
    // Soonest expiry first: a merged coin inherits the earliest of its inputs'.
    const capacity = maxAmount >= 0 ? (maxOutputs - 1) * maxAmount : Infinity
    for (const coin of [...eligible].sort((a, b) => byExpiry(false)(a, b) || a.value - b.value)) {
      if (inputs.length >= maxInputs) break
      if (gross + coin.value > capacity) continue
      inputs.push(coin)
      gross += coin.value
    }
    if (inputs.length < 2) {
      const due = coins.filter((coin) => !kept.has(coin) && coin.renewalDue).length
      return none(
        `pool at its ceiling — ${coins.length}/${ceiling} coins, ${eligible.length} loose, ${due} due for renewal`,
      )
    }
  } else if (have.some((count, i) => count < target[i]!.want)) {
    const need = target.reduce((sum, rung, i) => sum + (rung.want - have[i]!) * rung.size, minOutput)
    for (const coin of [...eligible].sort((a, b) => b.value - a.value)) {
      if (inputs.length >= maxInputs || gross >= need) break
      inputs.push(coin)
      gross += coin.value
    }
    if (inputs.length === 0) {
      const due = coins.filter((coin) => !kept.has(coin) && coin.renewalDue).length
      return none(
        due > 0
          ? `pool short toward ${shape}; its ${due} loose coin(s) are due for renewal, which reshapes them`
          : `pool short toward ${shape} with nothing loose to cut — fund the solver`,
      )
    }
  } else {
    return none(`pool already matches its target — ${shape}`)
  }

  const carrier = inputs.some((coin) => coin.hasAssets) ? minOutput : 0
  const extra = carrier > 0 ? 1 : 0
  const slots = consolidating
    ? maxOutputs - extra
    : Math.min(maxOutputs - extra, ceiling - (coins.length - inputs.length) - extra)
  if (slots < 2) return none(`pool at its ceiling — ${coins.length}/${ceiling} coins`)

  // Round-robin from the smallest rung, so one expensive rung cannot consume a
  // whole transaction's output budget and starve the others.
  const short = target
    .map((rung, i) => ({ size: rung.size, missing: rung.want - have[i]! }))
    .filter((rung) => rung.missing > 0 && rung.size >= minOutput && (maxAmount < 0 || rung.size <= maxAmount))
  const pieces: number[] = []
  let left = gross - carrier
  let progress = true
  while (progress && pieces.length < slots - 1) {
    progress = false
    for (const rung of short) {
      if (pieces.length >= slots - 1) break
      if (rung.missing <= 0 || left < rung.size) continue
      pieces.push(rung.size)
      left -= rung.size
      rung.missing--
      progress = true
    }
  }
  while (left > 0 && left < minOutput && pieces.length > 0) left += pieces.pop()!
  let chunks = left > 0 ? 1 : 0
  if (maxAmount >= 0 && left > maxAmount) {
    while (pieces.length > 0 && pieces.length + Math.ceil(left / maxAmount) > slots) left += pieces.pop()!
    chunks = Math.ceil(left / maxAmount)
  }

  const outputs = [...pieces, ...evenly(left, chunks)]
  const keys = inputs.map((coin) => coin.key)
  const assets = carrier > 0 ? `; assets ride a ${carrier} sat change` : ''
  const bounded = outputs.every((amount) => amount >= minOutput && (maxAmount < 0 || amount <= maxAmount))
  if (consolidating) {
    const remain = coins.length - inputs.length + outputs.length + extra
    const fits = left >= 0 && bounded && outputs.length <= slots
    if (!fits || remain >= coins.length) {
      const why = fits ? 'would not shrink it' : "would leave an output outside the operator's bounds"
      return none(`pool at its ceiling — ${coins.length}/${ceiling} coins, and merging ${inputs.length} ${why}`)
    }
    return {
      inputs: keys,
      outputs,
      reason: `consolidating ${inputs.length} of ${coins.length} coins into ${outputs.length} output(s), ceiling ${ceiling}; ${remain} remain${assets}`,
    }
  }
  if (outputs.length > slots || (pieces.length > 0 && !bounded)) {
    return none(
      `${gross} sat cannot be cut into ${slots} outputs under the operator's ${maxAmount} sat per-output ceiling`,
    )
  }
  if (pieces.length === 0) {
    return none(
      total < smallest + minOutput
        ? `float ${total} sat is below one ${smallest} sat piece plus ${minOutput} — fund the solver`
        : `float ${total} sat cannot afford any piece toward ${shape}`,
    )
  }
  return {
    inputs: keys,
    outputs,
    reason: `minting ${pieces.length} piece(s) from ${inputs.length} coin(s) toward ${shape}${assets}`,
  }
}

/**
 * Outputs one split settlement may create — a renewal's, or a boarding's.
 *
 * The same figure `mintPool` uses for a split transaction, and for the same
 * reason: a float shredded into hundreds of pieces costs a fee per piece to
 * renew forever after. Eight covers the pool target's rungs while leaving the
 * shape legible.
 *
 * WHAT THE SERVER ACTUALLY BOUNDS is transaction WEIGHT, not an output count -
 * arkd's `/v1/info` publishes `maxTxWeight` (40000 on the regtest build) and no
 * max-outputs field at all, so there is nothing to read this constant off. A
 * taproot output is ~43 vbytes, so eight of them is ~1400 weight units against
 * that 40000: roughly three percent, and the inputs dominate long before the
 * outputs do.
 *
 * So this is a SHAPE bound, not a protocol one, and it is safe by a wide margin
 * rather than by a check. If it ever grows materially - or if a settlement
 * starts carrying many more inputs - the figure that matters is `maxTxWeight`
 * and it should be estimated rather than assumed.
 */
export const MAX_SPLIT_OUTPUTS = 8

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
