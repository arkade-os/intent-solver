/**
 * Converting between an EVM block height and wall-clock seconds.
 *
 * Boltz's `ERC20Swap` denominates its timelock in `block.number`, and every
 * deadline this service reasons about is in unix seconds. Something has to
 * bridge the two, and the bridge is an assumption about how fast blocks arrive
 * — which is exactly the kind of assumption that costs money when it is made
 * once and reused in both directions.
 *
 * So, as `core/receive.ts` and `core/send.ts` already do for Bitcoin: **two
 * conversions, opposite safe directions, and neither may stand in for the
 * other.**
 *
 * - Reading someone's timelock ("this expires at block N — how long have I
 *   got?") must assume blocks arrive **fast**. Underestimating the remaining
 *   time makes us act early, which is free. Overestimating makes us believe we
 *   have time we do not.
 * - Setting our own timelock ("I want at least T seconds — how many blocks?")
 *   must assume blocks arrive **slow**. Fewer blocks means the lock expires no
 *   later than intended, so our own recourse opens on time. Assuming fast
 *   blocks here computes too many, and the lock outlives the deadline it was
 *   sized against.
 *
 * WHY THIS IS PER-CHAIN CONFIGURATION AND NOT A CONSTANT. Block intervals
 * across EVM chains differ by more than an order of magnitude — roughly 12s on
 * Ethereum, ~2s on Base and Polygon, sub-second on Arbitrum. A compiled-in
 * number would be wrong nearly everywhere, and wrong in the dangerous direction
 * on the fast chains. The corridor is required to work on any EVM-compatible
 * chain, so the interval arrives with the chain.
 */

/**
 * A chain's block cadence, as the two bounds the conversions actually need.
 *
 * Not an average: an average is the one value that is wrong for both
 * directions at once. These are the pessimistic ends, and a chain whose
 * cadence is genuinely stable simply has them close together.
 */
export interface EvmBlockCadence {
  /**
   * The FASTEST blocks are expected to arrive, in seconds. Used when reading a
   * deadline, where believing time is short is the safe error.
   */
  fastestSecondsPerBlock: number
  /**
   * The SLOWEST blocks are expected to arrive, in seconds. Used when sizing our
   * own lock, where a shorter lock is the safe error.
   */
  slowestSecondsPerBlock: number
}

/** Rejects a cadence that cannot be used safely, rather than silently inverting the bounds. */
export const assertCadence = (cadence: EvmBlockCadence): void => {
  const { fastestSecondsPerBlock: fast, slowestSecondsPerBlock: slow } = cadence
  for (const [name, value] of [
    ['fastestSecondsPerBlock', fast],
    ['slowestSecondsPerBlock', slow],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got ${value}`)
  }
  // Swapped bounds would not throw anywhere downstream — both conversions would
  // simply return the unsafe answer, on every swap, silently.
  if (fast > slow) {
    throw new Error(`fastestSecondsPerBlock (${fast}) must be <= slowestSecondsPerBlock (${slow})`)
  }
}

/**
 * When `timeoutBlock` arrives, in unix seconds — the EVM analogue of
 * `core/receive.ts`'s `htlcDeadlineSeconds`.
 *
 * Takes the CURRENT height rather than the height the lock was seen at, so the
 * answer tracks the chain's real progress: as blocks arrive the remaining span
 * shrinks, and with it the amount this conversion can still be wrong by.
 *
 * Not clamped to `now`. Once the chain is past `timeoutBlock` the deadline
 * genuinely is in the past, and a caller reading that as "too late" is correct.
 * Flooring it at the present would be a lie in the direction that costs money.
 */
export const deadlineSecondsForBlock = (args: {
  timeoutBlock: bigint
  currentBlock: bigint
  nowSeconds: number
  cadence: EvmBlockCadence
}): number => {
  assertCadence(args.cadence)
  const remaining = args.timeoutBlock - args.currentBlock
  // `Number(bigint)` loses precision above 2^53. `remaining` is a block span,
  // and at any real cadence 2^53 blocks is longer than the universe has run —
  // so this is safe by the domain, not by a check. Stated because the
  // conversion looks unguarded otherwise.
  return args.nowSeconds + Number(remaining) * args.cadence.fastestSecondsPerBlock
}

/**
 * How many blocks a lock of at least `seconds` should run for.
 *
 * Floors rather than rounds: a block fewer expires sooner, which is the safe
 * side when this sizes our own recourse. Returns at least 1, because a
 * zero-block timelock is already expired and would be refundable in the same
 * block it was created.
 */
export const blocksForDuration = (seconds: number, cadence: EvmBlockCadence): bigint => {
  assertCadence(cadence)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`duration must be positive seconds, got ${seconds}`)
  const blocks = Math.floor(seconds / cadence.slowestSecondsPerBlock)
  return BigInt(Math.max(1, blocks))
}
