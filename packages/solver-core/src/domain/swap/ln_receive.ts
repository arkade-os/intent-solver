import type { Observation } from './observation.js'
import { OnFailure, type CheckResult, type Policies } from './plan.js'
import type { Swap } from './swap.js'

const MINUTE = 60

/** The least time we need between paying out and the Lightning payment timing out. */
export const MIN_SETTLE_WINDOW = 90 * MINUTE
/** Our refund must open at least this long before the Lightning payment times out. */
export const SETTLE_SAFETY_MARGIN = 15 * MINUTE
/** Our refund without the server must open at least this long before the Lightning payment times out. */
export const REFUND_ALONE_MARGIN = 30 * MINUTE
/** How long a failing refund is retried before an operator is called. */
export const REFUND_RETRY_WINDOW = 6 * 60 * MINUTE

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
  acceptsOverfunding: false,
  // Nothing left our side, so the swap goes back to `funded` and every check runs again.
  onLockFailed: () => OnFailure.Retry,
  // Never send again: the first payout may still show up. Wait until our refund opens, then call an operator.
  onLockMissing: (_swap, seen) =>
    seen.to.refundOpensAt !== null && seen.now >= seen.to.refundOpensAt ? OnFailure.Stuck : OnFailure.Wait,
  canCollect: () => ({ ok: true }),
  onClaimFailed: (_swap, seen) =>
    seen.from.expiresAt !== null && seen.now < seen.from.expiresAt ? OnFailure.Retry : OnFailure.Stuck,
  onRefundFailed: (swap, seen) => (seen.now - swap.to.since < REFUND_RETRY_WINDOW ? OnFailure.Retry : OnFailure.Stuck),
  canRelease: () => true,
})
