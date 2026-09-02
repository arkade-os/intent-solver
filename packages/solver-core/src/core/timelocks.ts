/**
 * Timelock arithmetic for swap scripts. Pure — no I/O, no clock of its own.
 *
 * Two encodings, not interchangeable: `refundLocktime` is BIP65 (absolute; below
 * LOCKTIME_THRESHOLD it reads as a block height, so we always emit seconds), and the
 * unilateral delays are BIP68 (relative to funding confirmation, in units of 512s —
 * anything not a whole multiple cannot be expressed).
 *
 * Block heights are never used: a two-hour window is ~12 blocks, and block-interval
 * variance over 12 blocks is far too wide to hold an HTLC deadline against.
 */

/** BIP65: at or above this, a locktime is a unix timestamp rather than a height. */
export const LOCKTIME_THRESHOLD = 500_000_000

/** BIP68 encodes relative time in units of 512 seconds. */
export const SEQUENCE_GRANULARITY_SECONDS = 512

export const MINUTE = 60
export const HOUR = 60 * MINUTE

/** True when the value is a whole number of BIP68 512-second units. */
export const isEncodableRelativeDelay = (seconds: number): boolean =>
  Number.isInteger(seconds) && seconds > 0 && seconds % SEQUENCE_GRANULARITY_SECONDS === 0

export interface UnilateralDelays {
  unilateralClaimDelay: number
  unilateralRefundDelay: number
  unilateralRefundWithoutReceiverDelay: number
}

/**
 * How long after the claimant's claim the funder's SOLO refund opens.
 *
 * The window a claimant holding the preimage needs to finish, which with the server
 * gone is a full unilateral exit. REASONED, not measured — nothing has driven one to
 * completion yet (`TODO(unilateral-exit)`). A multiple of the granularity, or BIP68
 * would round it away from the number written here.
 */
export const SOLO_REFUND_HEADROOM_SECONDS = 8 * SEQUENCE_GRANULARITY_SECONDS

/**
 * The longest relative timelock BIP68 can encode. Named because
 * `deriveUnilateralDelays` and `ARK_UNILATERAL_EXIT_DELAY`'s parser both enforce it,
 * and two spellings of `0xffff * 512` is how they stop agreeing.
 */
export const MAX_BIP68_SECONDS = 0xffff * SEQUENCE_GRANULARITY_SECONDS

/** Round up to the next whole BIP68 512-second unit. */
export const ceilToGranularity = (seconds: number): number =>
  Math.ceil(seconds / SEQUENCE_GRANULARITY_SECONDS) * SEQUENCE_GRANULARITY_SECONDS

/**
 * Derive unilateral delays from the Arkade server's own minimum exit delay.
 *
 * Cannot be hardcoded: the minimum differs by orders of magnitude between deployments,
 * and a constant that works on one network yields `INVALID_VTXO_SCRIPT: exit delay is
 * too short` on another — only at SPEND, once there is already money in the script.
 *
 * What the three leaves time, because the names do not say it and getting it backwards
 * moves money:
 *
 *   unilateralClaim                  receiver alone, holding the preimage
 *   unilateralRefund                 client AND receiver — needs both
 *   unilateralRefundWithoutReceiver  client alone, needing nobody
 *
 * Only the last is a solo path for the FUNDER, so it is the only one whose timing can
 * steal, and it opens last by {@link SOLO_REFUND_HEADROOM_SECONDS}. Claim and the
 * two-signature refund sit level — separating them buys nothing and costs headroom.
 */
export const deriveUnilateralDelays = (serverExitDelaySeconds: number): UnilateralDelays => {
  if (!Number.isFinite(serverExitDelaySeconds) || serverExitDelaySeconds <= 0) {
    throw new Error(`server exit delay must be a positive number of seconds, got ${serverExitDelaySeconds}`)
  }
  // Below 512 the value is a BLOCK count by the SDK's convention. Treating 144 blocks
  // (~24h) as 144 seconds rounds to a 512s timelock against a day-long requirement --
  // accepted at funding, rejected at spend, money already locked.
  if (serverExitDelaySeconds < SEQUENCE_GRANULARITY_SECONDS) {
    throw new Error(
      `server exit delay ${serverExitDelaySeconds} is below ${SEQUENCE_GRANULARITY_SECONDS}s and is a block count, not seconds`,
    )
  }
  if (serverExitDelaySeconds > MAX_BIP68_SECONDS) {
    throw new Error(`server exit delay ${serverExitDelaySeconds}s exceeds what BIP68 can encode`)
  }
  const base = ceilToGranularity(serverExitDelaySeconds)
  return {
    unilateralClaimDelay: base,
    unilateralRefundDelay: base,
    unilateralRefundWithoutReceiverDelay: base + SOLO_REFUND_HEADROOM_SECONDS,
  }
}

/**
 * Reject a locktime a verifier would read as a block height.
 *
 * `label` names the field and nothing else: the EVM corridors carry two
 * absolute-seconds deadlines through one evaluator, one converted from a height a few
 * frames earlier, so a hardcoded name would point at the wrong value.
 */
export const assertAbsoluteLocktime = (locktime: number, label = 'refundLocktime'): void => {
  if (!Number.isInteger(locktime)) {
    throw new Error(`${label} must be an integer, got ${locktime}`)
  }
  if (locktime < LOCKTIME_THRESHOLD) {
    throw new Error(
      `${label} ${locktime} is below LOCKTIME_THRESHOLD (${LOCKTIME_THRESHOLD}) and would be interpreted as a block height`,
    )
  }
}
