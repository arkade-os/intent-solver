/**
 * Receive leg: the user is paid over Lightning and the sats land on Arkade.
 *
 * The client sends `sha256(P)`; we mint a hold invoice on it, read `E` (the
 * deadline to settle) once a payer arms the HTLC, fund the Arkade side, and settle
 * with the preimage the claim reveals. Step "fund" is where the provider pays out
 * before being paid, and every gate here guards it. Clock injected; no I/O.
 */

import {
  assertAbsoluteLocktime,
  deriveUnilateralDelays,
  HOUR,
  MINUTE,
  rawDelaySeconds,
  SEQUENCE_GRANULARITY_SECONDS,
} from './timelocks.js'

/**
 * Minimum settle window required between funding and `E`.
 *
 * Subsumed by gate (c) today (135 min > 90), but kept: it is checked first so it
 * owns the `settle_window_too_short` refusal, and it becomes decisive again if
 * `MAX_REFUND_HORIZON` shrinks. Pinned in `test/core/receive.test.ts`.
 */
export const MIN_SETTLE_WINDOW = 90 * MINUTE

/** Gap kept between the refund path opening and `E`. Past `E` the payment is gone. */
export const SETTLE_SAFETY_MARGIN = 15 * MINUTE

/**
 * Gap kept between the solver's own solo recourse opening and `E`.
 *
 * Room to run an on-chain unilateral exit, not to settle a Lightning htlc. Reasoned
 * rather than measured — nothing in `src/` spends the unilateral leaf yet
 * (`TODO(unilateral-exit)` in `src/arkade/covenant.ts`).
 */
export const UNILATERAL_RECOURSE_MARGIN = 30 * MINUTE

/**
 * Ceiling on the final CLTV delta we will ask a payer to honour, blocks. 2016 is
 * LND's default `--max-cltv-expiry`, beyond which a stock payer refuses the route.
 */
export const MAX_FINAL_CLTV_BLOCKS = 2016

/**
 * The largest Arkade exit delay this corridor can serve with gate (d) intact.
 *
 * Searched downward over MULTIPLES of the BIP68 unit because the rounding in
 * `deriveUnilateralDelays` is not invertible; stepping off-grid understates the
 * headroom by up to a whole unit.
 */
export const maxServableExitDelay = (): number => {
  const ceilingSeconds = MAX_FINAL_CLTV_BLOCKS * HTLC_SECONDS_PER_BLOCK
  for (let unit = Math.floor(ceilingSeconds / SEQUENCE_GRANULARITY_SECONDS); unit >= 1; unit--) {
    const delay = unit * SEQUENCE_GRANULARITY_SECONDS
    const { unilateralRefundWithoutReceiverDelay } = deriveUnilateralDelays(delay)
    if (minFinalCltvBlocksFor(unilateralRefundWithoutReceiverDelay, false) <= MAX_FINAL_CLTV_BLOCKS) return delay
  }
  throw new Error("no exit delay is servable — MAX_FINAL_CLTV_BLOCKS is below this corridor's own floor")
}

/**
 * The final CLTV delta an invoice must carry for `E` to land after the solver's own
 * recourse opens. Rounded up at the FAST bound, the conservative direction here.
 */
export const minFinalCltvBlocksFor = (
  unilateralRefundWithoutReceiverDelay: number,
  acceptUnilateralGap: boolean,
): number =>
  Math.ceil(minHtlcWindowFor(unilateralRefundWithoutReceiverDelay, acceptUnilateralGap) / HTLC_SECONDS_PER_BLOCK)

/**
 * Every lower bound `E - now` must clear. The chooser above and
 * {@link evaluateReceiveFunding} read the SAME set, so an invoice minted to it cannot
 * be refused by a gate it forgot about.
 */
export const minHtlcWindowFor = (
  unilateralRefundWithoutReceiverDelay: number,
  /** Drop the gate (d) term. Required, not defaulted, so callers state their position. */
  acceptUnilateralGap: boolean,
): number =>
  Math.max(
    // (b) a real settle window after the htlc arrives
    MIN_SETTLE_WINDOW,
    // (c) the committed Arkade refund deadline must open before `E`
    MAX_REFUND_HORIZON + SETTLE_SAFETY_MARGIN,
    // (d) the solver's own recourse must open before `E`. Zero, not reduced, when the
    // operator accepts the gap: (b) and (c) still bind, so this is "no solo-recourse
    // guarantee", not "no deadline".
    //
    // CONVERTED: every other term here is seconds and this delay may count blocks. Left
    // raw, a 28-block recourse reads as 28 seconds and this gate — the one guaranteeing
    // the solver's own recourse opens before `E` — stops binding at all.
    acceptUnilateralGap ? 0 : rawDelaySeconds(unilateralRefundWithoutReceiverDelay) + UNILATERAL_RECOURSE_MARGIN,
  )

/**
 * Block interval assumed when a backend reports `E` as a timeout HEIGHT, seconds.
 *
 * A FLOOR, not an estimate: assuming blocks are too slow puts `E` later than the
 * truth and invents settle time we do not have. Contrast `SECONDS_PER_BLOCK` in
 * `core/send.ts`, which converts in the opposite safe direction.
 */
export const HTLC_SECONDS_PER_BLOCK = 150

/**
 * `E` in unix seconds for an HTLC timing out at `timeoutHeight`.
 *
 * Takes the CURRENT height, and is deliberately not clamped to `now`: once the chain
 * is past the timeout the deadline genuinely is in the past.
 */
export const htlcDeadlineFromHeight = (timeoutHeight: number, currentHeight: number, now: number): number =>
  now + (timeoutHeight - currentHeight) * HTLC_SECONDS_PER_BLOCK

/** Cap on how long one swap may park provider capital. Applied at QUOTE time. */
export const MAX_REFUND_HORIZON = 2 * HOUR

/** Why a funding attempt was refused. Closed set — callers branch on it. */
export type ReceiveFundingRefusal =
  | 'invoice_expired'
  | 'htlc_not_armed'
  | 'settle_window_too_short'
  /** The committed refund deadline opens too close to `E`. Nothing can move it. */
  | 'refund_deadline_too_late'
  /** The solver's own recourse opens after `E` — the #69 both-sides window. */
  | 'unilateral_recourse_after_htlc'

export interface ReceiveFundingInput {
  /** Absolute expiry of the BOLT11 we handed out, unix seconds. */
  invoiceExpiresAt: number
  /**
   * `E`, read from the backend. Null when the HTLC is not armed yet. Never defaulted:
   * a guess that runs long is where the provider pays out and cannot collect.
   */
  htlcExpiresAt: number | null
  /**
   * The refund deadline the lockup script ALREADY commits to. Checked here, never
   * chosen — recomputing it derives a different script that cannot spend the lockup.
   */
  refundLocktime: number
  /**
   * CSV delay on the leaf the solver can spend ALONE, relative to funding
   * confirmation. The only recourse when the Arkade server is unreachable.
   */
  unilateralRefundWithoutReceiverDelay: number
  /** Whether the operator accepted the #69 window — gate (d) is skipped when true. */
  acceptUnilateralGap: boolean
  /** Current time, unix seconds. Injected — this module owns no clock. */
  now: number
}

export type ReceiveFundingDecision = { fund: true } | { fund: false; reason: ReceiveFundingRefusal }

/**
 * Decide whether the Arkade side may be funded right now.
 *
 * MUST be called immediately before funding, never at arming time: every input is a
 * function of the clock. Returns a yes/no, never a deadline.
 */
export const evaluateReceiveFunding = (input: ReceiveFundingInput): ReceiveFundingDecision => {
  const {
    invoiceExpiresAt,
    htlcExpiresAt,
    refundLocktime,
    unilateralRefundWithoutReceiverDelay,
    acceptUnilateralGap,
    now,
  } = input

  // (a) never fund against an expired BOLT11 — any hop can fail it back.
  if (now >= invoiceExpiresAt) {
    return { fund: false, reason: 'invoice_expired' }
  }

  if (htlcExpiresAt === null) {
    return { fund: false, reason: 'htlc_not_armed' }
  }

  // (b) require a real settle window.
  if (htlcExpiresAt - now < MIN_SETTLE_WINDOW) {
    return { fund: false, reason: 'settle_window_too_short' }
  }

  assertAbsoluteLocktime(refundLocktime)

  // (c) the refund path must open before E. Not implied by (b): (b) bounds E from
  // `now`, while the committed deadline was fixed at QUOTE time.
  if (refundLocktime > htlcExpiresAt - SETTLE_SAFETY_MARGIN) {
    return { fund: false, reason: 'refund_deadline_too_late' }
  }

  // (d) the solver's SOLO recourse must open before `E`. With the Arkade server gone
  // the trader's `unilateralClaim` opens first, so if `E` passes before our own leaf
  // opens they can let the htlc fail back for free and then claim the payout — both
  // sides, one preimage (#69). Checked LAST, so accepting it changes exactly one
  // thing and every gate above still declines.
  if (!acceptUnilateralGap && now + unilateralRefundWithoutReceiverDelay + UNILATERAL_RECOURSE_MARGIN > htlcExpiresAt) {
    return { fund: false, reason: 'unilateral_recourse_after_htlc' }
  }

  return { fund: true }
}
