/**
 * Timelock arithmetic for swap scripts. Pure — no I/O, no clock of its own.
 *
 * Two encodings, not interchangeable: `refundLocktime` is BIP65 (absolute), the
 * unilateral delays are BIP68 (relative to funding confirmation). Each may count
 * SECONDS or BLOCKS, and BOTH ARE SELF-DESCRIBING — the unit rides on the value's own
 * magnitude, so nothing here carries a unit tag beside a number:
 *
 *   BIP68 relative   `>= 512` is seconds, below it a block count   `@arkade-os/sdk`'s `toTimelock`
 *   BIP65 absolute   `>= 500_000_000` is unix seconds, below a height   Bitcoin consensus
 *
 * Neither threshold is ours, and that is what lets a block-typed deployment run with
 * NO schema change: a `claim_delay` of 20 on disk unambiguously means twenty blocks, a
 * row written before block mode reads back byte-identically, and the two shapes coexist
 * in one database.
 *
 * WHY BLOCKS EXIST AT ALL. Not on mainnet: block-interval variance over the ~12 blocks
 * of a two-hour window is far too wide to hold an HTLC deadline against, and the SDK's
 * own default policies (`defaultBatchExpiryPolicy`, `defaultCheckpointExitDelayPolicy`)
 * set `requireSeconds: true` on every network but regtest. Blocks
 * are a REGTEST capability, for two reasons. An arkd configured with block delays is
 * the only one that can also serve VHTLC chain swaps, which need a block-typed
 * `vtxoTreeExpiry` — a seconds-only solver forces a second arkd beside it. And a
 * block-typed timelock matures by MINING: `generatetoaddress` advances it immediately,
 * where a seconds-typed one waits on median-time-past, which regtest does not
 * fast-forward just because blocks were produced.
 *
 * {@link NOMINAL_BLOCK_SECONDS} bridges the two wherever a block delay meets a wall
 * clock.
 */

/** BIP65: at or above this, a locktime is a unix timestamp rather than a height. */
export const LOCKTIME_THRESHOLD = 500_000_000

/** BIP68 encodes relative time in units of 512 seconds. */
export const SEQUENCE_GRANULARITY_SECONDS = 512

/**
 * What one block is worth in seconds when a block delay meets a wall-clock deadline.
 *
 * 600, because that is the SDK's own `NOMINAL_BLOCK_SECONDS` and this number's whole
 * job is to agree with whoever derives the same script. Nominal, not measured — on
 * regtest a block is worth whatever the harness mines, which is why block mode is a
 * regtest capability.
 *
 * CONTRAST `SECONDS_PER_BLOCK` in `core/send.ts` (also 600) and `HTLC_SECONDS_PER_BLOCK`
 * in `core/receive.ts` (150): those convert LIGHTNING's CLTV deltas, a different
 * quantity answering to a different counterparty, and are free to move without this one.
 */
export const NOMINAL_BLOCK_SECONDS = 600

export const MINUTE = 60
export const HOUR = 60 * MINUTE

/** Which clock a timelock counts on. */
export type TimelockUnit = 'seconds' | 'blocks'

/** A BIP68 relative delay, with the unit its raw value implies. */
export interface RelativeDelay {
  unit: TimelockUnit
  value: number
}

/**
 * Read a raw BIP68 delay's unit off its own magnitude.
 *
 * The SDK's `toTimelock` rule, restated rather than imported: it is applied to values
 * that never pass through the SDK — an operator's `ARK_UNILATERAL_EXIT_DELAY`, a
 * `claim_delay` column — and a silent change to the SDK's threshold must break a test
 * here, not a lockup in production.
 */
export const relativeDelayFrom = (raw: number): RelativeDelay => ({
  unit: raw >= SEQUENCE_GRANULARITY_SECONDS ? 'seconds' : 'blocks',
  value: raw,
})

/**
 * A relative delay as seconds, for arithmetic against a wall clock.
 *
 * ONLY for deadline reasoning, never for building a script: a block delay put through
 * here and then written to a leaf encodes the converted SECONDS, a different timelock
 * from the blocks that were meant.
 */
export const relativeDelaySeconds = (delay: RelativeDelay): number =>
  delay.unit === 'seconds' ? delay.value : delay.value * NOMINAL_BLOCK_SECONDS

/** As {@link relativeDelaySeconds}, from a raw value. */
export const rawDelaySeconds = (raw: number): number => relativeDelaySeconds(relativeDelayFrom(raw))

/** True when the value is a whole number of BIP68 512-second units. */
export const isEncodableRelativeDelay = (seconds: number): boolean =>
  Number.isInteger(seconds) && seconds > 0 && seconds % SEQUENCE_GRANULARITY_SECONDS === 0

/**
 * True when the value is an encodable BIP68 delay in EITHER unit.
 *
 * A block count need only be a positive integer below the seconds threshold; a seconds
 * value must additionally land on a 512-second boundary.
 */
export const isEncodableDelay = (raw: number): boolean =>
  relativeDelayFrom(raw).unit === 'blocks' ? Number.isInteger(raw) && raw > 0 : isEncodableRelativeDelay(raw)

export interface UnilateralDelays {
  unilateralClaimDelay: number
  unilateralRefundDelay: number
  unilateralRefundWithoutReceiverDelay: number
}

/**
 * How long after the claimant's claim the funder's SOLO refund opens.
 *
 * The window a claimant holding the preimage needs to finish, which with the Arkade
 * Service gone is a full unilateral exit. REASONED, not measured — the exit exists
 * (`arkade/unilateralExit.ts`) but nothing has driven one to completion on any network,
 * so there is still no observed duration behind this number. A multiple of the
 * granularity, or BIP68 would round it away from the number written here.
 */
export const SOLO_REFUND_HEADROOM_SECONDS = 8 * SEQUENCE_GRANULARITY_SECONDS

/**
 * The same headroom in blocks, for a block-typed ladder.
 *
 * Eight blocks rather than the seconds figure converted (4096/600 ≈ 7), rounded UP for
 * the reason the seconds figure was: this is the one window whose shortfall lets a
 * funder take money from a claimant who did nothing wrong, so it is sized generously in
 * whichever unit it is expressed. On regtest eight blocks is eight `generatetoaddress`
 * calls, which is the point.
 */
export const SOLO_REFUND_HEADROOM_BLOCKS = 8

/**
 * The longest relative timelock BIP68 can encode. Named because
 * `deriveUnilateralDelays` and `ARK_UNILATERAL_EXIT_DELAY`'s parser both enforce it,
 * and two spellings of `0xffff * 512` is how they stop agreeing.
 */
export const MAX_BIP68_SECONDS = 0xffff * SEQUENCE_GRANULARITY_SECONDS

/**
 * The largest block-typed BASE delay this service will build, blocks.
 *
 * NOT BIP68's own 0xffff: the binding limit is far lower and comes from the encoding
 * being self-describing. At 512 a value stops meaning blocks and starts meaning
 * seconds, so a ladder whose TOP rung reaches 512 has silently re-typed itself — a base
 * of 505 puts the solo refund at 513, encoding 513 SECONDS where 513 blocks were meant,
 * an ~85-minute window in place of a ~3.5-day one.
 *
 * Expressed on the top rung, leaving room for the headroom stacked above the base —
 * the same shape `MAX_BIP68_SECONDS` takes on the seconds side, for the same reason.
 */
export const MAX_BIP68_BLOCKS = SEQUENCE_GRANULARITY_SECONDS - SOLO_REFUND_HEADROOM_BLOCKS - 1

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
 * steal, and it opens last by {@link SOLO_REFUND_HEADROOM_SECONDS} — or, on a
 * block-typed ladder, {@link SOLO_REFUND_HEADROOM_BLOCKS}. Claim and the two-signature
 * refund sit level — separating them buys nothing and costs headroom.
 *
 * The unit is read off the value and the whole ladder is built in it, so a block-typed
 * server yields block-typed leaves. Callers reasoning about these against a wall clock
 * go through {@link rawDelaySeconds} rather than using the numbers directly.
 */
export const deriveUnilateralDelays = (serverExitDelay: number): UnilateralDelays => {
  if (!Number.isFinite(serverExitDelay) || serverExitDelay <= 0) {
    throw new Error(`server exit delay must be a positive number, got ${serverExitDelay}`)
  }
  // Matters on the BLOCK side, where nothing rounds: a fractional block count would go
  // straight into a leaf. The seconds side climbs to a 512 boundary anyway.
  if (!Number.isInteger(serverExitDelay)) {
    throw new Error(`server exit delay must be a whole number, got ${serverExitDelay}`)
  }

  if (relativeDelayFrom(serverExitDelay).unit === 'blocks') {
    // The ladder's TOP rung is what must stay under the threshold, not the base: a base
    // of 505 puts the solo refund at 513, which stops being 513 blocks and becomes 513
    // SECONDS the moment anything reads it back.
    if (serverExitDelay > MAX_BIP68_BLOCKS) {
      throw new Error(
        `server exit delay ${serverExitDelay} blocks exceeds ${MAX_BIP68_BLOCKS}: stacking ` +
          `${SOLO_REFUND_HEADROOM_BLOCKS} blocks of solo-refund headroom on top would reach ` +
          `${SEQUENCE_GRANULARITY_SECONDS}, where a relative timelock stops meaning blocks and starts meaning seconds`,
      )
    }
    // No rounding: BIP68 encodes a block count exactly, so unlike the seconds side there
    // is no granularity to climb to.
    return {
      unilateralClaimDelay: serverExitDelay,
      unilateralRefundDelay: serverExitDelay,
      unilateralRefundWithoutReceiverDelay: serverExitDelay + SOLO_REFUND_HEADROOM_BLOCKS,
    }
  }

  if (serverExitDelay > MAX_BIP68_SECONDS) {
    throw new Error(`server exit delay ${serverExitDelay}s exceeds what BIP68 can encode`)
  }
  const base = ceilToGranularity(serverExitDelay)
  return {
    unilateralClaimDelay: base,
    unilateralRefundDelay: base,
    unilateralRefundWithoutReceiverDelay: base + SOLO_REFUND_HEADROOM_SECONDS,
  }
}

/**
 * Which unit a stored absolute locktime is in. The same BIP65 rule as
 * {@link assertAbsoluteLocktime}, without the throw, for callers that must DISPATCH on
 * a value rather than validate a fresh one.
 */
export const absoluteLocktimeUnit = (locktime: number): TimelockUnit =>
  locktime >= LOCKTIME_THRESHOLD ? 'seconds' : 'blocks'

/**
 * Reject a locktime a verifier would read in a different unit than intended.
 *
 * `expected` says which unit this caller builds — seconds unless block mode is on. The
 * check is SYMMETRIC: a height where seconds were meant is the classic mistake, and
 * seconds where a height was meant is the one block mode introduces, equally capable of
 * writing an unspendable deadline. Both directions are named separately, because a
 * reader must not have to work out which case they are in.
 *
 * `label` names the field and nothing else: the EVM corridors carry two
 * absolute-seconds deadlines through one evaluator, one converted from a height a few
 * frames earlier, so a hardcoded name would point at the wrong value.
 */
export const assertAbsoluteLocktime = (
  locktime: number,
  label = 'refundLocktime',
  expected: TimelockUnit = 'seconds',
): void => {
  if (!Number.isInteger(locktime)) {
    throw new Error(`${label} must be an integer, got ${locktime}`)
  }
  // Below the threshold a non-positive value reads as a "height" and would otherwise
  // pass the block-typed branch, so it is refused before the unit question is asked.
  if (locktime <= 0) {
    throw new Error(`${label} must be positive, got ${locktime}`)
  }
  const actual = absoluteLocktimeUnit(locktime)
  if (actual === expected) return
  if (expected === 'seconds') {
    throw new Error(
      `${label} ${locktime} is below LOCKTIME_THRESHOLD (${LOCKTIME_THRESHOLD}) and would be interpreted as a block height`,
    )
  }
  throw new Error(
    `${label} ${locktime} is at or above LOCKTIME_THRESHOLD (${LOCKTIME_THRESHOLD}) and would be interpreted as unix ` +
      'seconds, but this deployment builds block-height locktimes',
  )
}

/**
 * Where the chain is, for resolving a block-height locktime against a wall clock.
 *
 * Both figures together and read at the same moment: a height paired with a stale `now`
 * (or the reverse) shifts every deadline derived from the pair by the gap between them.
 */
export interface ChainMoment {
  /** Unix seconds. */
  now: number
  /** The chain tip's height. */
  tipHeight: number
}

/**
 * A stored absolute locktime as a unix-seconds deadline, for DURATION questions.
 *
 * The deadline model is entirely in seconds (`docs/deadlines.md`), so "how long until
 * the client's refund opens" and "does the HTLC fit inside it" are asked of this rather
 * than of the raw value. A seconds locktime IS the answer and is returned untouched,
 * which is what lets rows written before block mode flow through unchanged.
 *
 * THE PROJECTION IS AN ESTIMATE and moves as blocks arrive — not a defect: the script
 * matures on HEIGHT, so height is the truth, and this exists only to answer
 * seconds-shaped questions about it. "Has it opened yet" must go to
 * {@link absoluteLocktimeReached}, which compares in the locktime's own unit and cannot
 * drift.
 */
export const absoluteLocktimeSeconds = (locktime: number, at: ChainMoment): number =>
  absoluteLocktimeUnit(locktime) === 'seconds' ? locktime : at.now + (locktime - at.tipHeight) * NOMINAL_BLOCK_SECONDS

/**
 * Has this locktime opened?
 *
 * Compared in the locktime's OWN unit, never through a projection: a height against the
 * tip, seconds against the clock. On regtest the two disagree wildly and deliberately —
 * a hundred mined blocks mature a height instantly while the clock has not moved — and
 * the chain's answer is the one that decides whether a spend is accepted.
 */
export const absoluteLocktimeReached = (locktime: number, at: ChainMoment): boolean =>
  absoluteLocktimeUnit(locktime) === 'seconds' ? at.now >= locktime : at.tipHeight >= locktime

/**
 * Express a unix-seconds deadline as a locktime in the given unit. The inverse of
 * {@link absoluteLocktimeSeconds}, used once per swap: a deadline is always REASONED
 * about in seconds and converted at the moment it is written into a script.
 *
 * Rounds UP, so the converted height never opens earlier than the seconds deadline it
 * stands for. Every one of these deadlines is a floor beneath somebody's recourse, and
 * rounding down shaves the margin that floor exists to guarantee.
 */
export const absoluteLocktimeIn = (deadlineSeconds: number, unit: TimelockUnit, at: ChainMoment): number => {
  if (unit === 'seconds') return deadlineSeconds
  const height = at.tipHeight + Math.ceil((deadlineSeconds - at.now) / NOMINAL_BLOCK_SECONDS)
  // Unreachable on any real chain — half a billion blocks — but the check costs nothing
  // and the failure it prevents is a locktime that silently means the year 1985.
  if (height >= LOCKTIME_THRESHOLD) {
    throw new Error(
      `refund height ${height} is at or above LOCKTIME_THRESHOLD (${LOCKTIME_THRESHOLD}) and would read as unix seconds`,
    )
  }
  return height
}
