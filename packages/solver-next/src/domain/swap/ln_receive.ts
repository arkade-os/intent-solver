import type { Observation } from './observation.js'
import { OnFailure, Reason, type CheckResult, type Policies } from './plan.js'
import type { Swap } from './swap.js'

const MINUTE = 60

/** The longest one swap may keep our payout locked. The refund locktime is set this far ahead when quoting. */
export const MAX_REFUND_HORIZON = 120 * MINUTE
/** The least time we need between paying out and the Lightning payment timing out. */
export const MIN_SETTLE_WINDOW = 90 * MINUTE
/** Our refund must open at least this long before the Lightning payment times out. */
export const SETTLE_SAFETY_MARGIN = 15 * MINUTE
/** Our refund without the server must open at least this long before the Lightning payment times out. */
export const REFUND_ALONE_MARGIN = 30 * MINUTE
/** How long a failing refund is retried before an operator is called. */
export const REFUND_RETRY_WINDOW = 6 * 60 * MINUTE

/** How long a spent payout may show no claim before that counts as missing. */
export const SPEND_READ_GRACE = 2 * MINUTE

export interface LnReceiveConfig {
  /** The operator accepts paying out even when the refund without the server would open too late. */
  readonly acceptRefundAloneGap: boolean
}

const refuse = (reason: string): CheckResult => ({ ok: false, reason: `refused to fund: ${reason}` })

// The client pays a held Lightning payment (`from`), we pay out on Arkade (`to`).
// Once the Lightning payment times out we can no longer collect it, so every check compares against that time.
const canFill =
  (config: LnReceiveConfig) =>
  (swap: Swap, seen: Observation): CheckResult => {
    const { now } = seen
    const timesOutAt = seen.from.expiresAt
    const { refundOpensAt, refundAloneDelay } = seen.to

    if (swap.quote.expiredAt(now)) return refuse('invoice_expired')
    if (timesOutAt === null) return refuse('htlc_not_armed')
    if (timesOutAt - now < MIN_SETTLE_WINDOW) return refuse('settle_window_too_short')
    if (refundOpensAt === null || refundOpensAt > timesOutAt - SETTLE_SAFETY_MARGIN) {
      return refuse('refund_deadline_too_late')
    }
    if (config.acceptRefundAloneGap) return { ok: true }
    if (refundAloneDelay === null || now + refundAloneDelay + REFUND_ALONE_MARGIN > timesOutAt) {
      return refuse('unilateral_recourse_after_htlc')
    }
    return { ok: true }
  }

export const lnReceivePolicies = (config: LnReceiveConfig): Policies => ({
  canFill: canFill(config),
  // The words operators and alerts already know from the legacy corridor.
  reasons: {
    [Reason.QuoteExpired]: 'invoice expired before it was ever armed',
    [Reason.PayoutLost]:
      'funding response lost; refund deadline reached with no lockup adopted — review for a stray lockup',
    [Reason.PayoutSpentUnknown]: 'funded output gone during refunding with no matching claim found; needs review',
    [Reason.PayoutClaimedBlind]: 'funded output gone during refunding with no matching claim found; needs review',
  },
  // A payer may overpay a Lightning invoice. The payout stays as quoted.
  acceptsOverfunding: true,
  // Nothing left our side, so the swap goes back to `funded` and every check runs again.
  onLockFailed: () => OnFailure.Retry,
  // Never send again: the first payout may still show up. Wait until our refund opens, then call an operator.
  onLockMissing: (_swap, seen) =>
    seen.to.refundOpensAt !== null && seen.now >= seen.to.refundOpensAt ? OnFailure.Stuck : OnFailure.Wait,
  canCollect: () => ({ ok: true }),
  // The timeout saved with the lock: once the payment is gone the rail can no longer show it.
  onClaimFailed: (swap, seen) =>
    swap.from.expiresAt !== null && seen.now < swap.from.expiresAt ? OnFailure.Retry : OnFailure.Stuck,
  onRefundFailed: (swap, seen) => (seen.now - swap.to.since < REFUND_RETRY_WINDOW ? OnFailure.Retry : OnFailure.Stuck),
  // Stuck stops the loop, so a claim that shows up later would never be collected. Wait while collecting is possible.
  onSpentUnknown: (swap, seen) => {
    const timesOutAt = swap.from.expiresAt
    if (seen.now - swap.to.since < SPEND_READ_GRACE) return OnFailure.Wait
    return timesOutAt !== null && seen.now < timesOutAt ? OnFailure.Wait : OnFailure.Stuck
  },
  // A held payment cannot be handed back: the Lightning port only promises to cancel an invoice nobody paid.
  // It times out on its own.
  canRelease: () => false,
})
