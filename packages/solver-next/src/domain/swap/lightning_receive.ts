import type { ValueOf } from '../shared/brand.js'
import type { UnixSeconds } from '../shared/time.js'

const MINUTE = 60
const HOUR = 60 * MINUTE

export const TIME_TO_SETTLE = 90 * MINUTE
export const SPARE_TIME_AFTER_REFUND_OPENS = 15 * MINUTE
export const SPARE_TIME_AFTER_REFUND_ALONE = 30 * MINUTE
export const LONGEST_A_FILL_STAYS_LOCKED = 2 * HOUR

// The words are what clients and logs already see.
export const FillRefusal = {
  InvoiceExpired: 'invoice_expired',
  HoldNotArmed: 'htlc_not_armed',
  TooLittleTimeToSettle: 'settle_window_too_short',
  RefundOpensTooLate: 'refund_deadline_too_late',
  RefundAloneOpensTooLate: 'unilateral_recourse_after_htlc',
} as const

export type FillRefusal = ValueOf<typeof FillRefusal>

/** How long until our refund of the `to` leg opens, in seconds. */
interface RefundTimes {
  readonly untilRefundOpens: number
  /** With the Arkade server gone. Null when the operator accepts having no such refund in time. */
  readonly untilRefundAlone: number | null
}

// The held HTLC must not expire before each of these has passed. Checked in this order.
const TIME_THE_HTLC_MUST_STILL_LAST: readonly [FillRefusal, (refund: RefundTimes) => number][] = [
  [FillRefusal.TooLittleTimeToSettle, () => TIME_TO_SETTLE],
  [FillRefusal.RefundOpensTooLate, (refund) => refund.untilRefundOpens + SPARE_TIME_AFTER_REFUND_OPENS],
  [
    FillRefusal.RefundAloneOpensTooLate,
    (refund) => (refund.untilRefundAlone === null ? 0 : refund.untilRefundAlone + SPARE_TIME_AFTER_REFUND_ALONE),
  ],
]

export interface ReceiveTerms {
  readonly invoiceExpiresAt: UnixSeconds
  /** Null while the hold is not armed. */
  readonly htlcExpiresAt: UnixSeconds | null
  readonly refundOpensAt: UnixSeconds
  readonly secondsToRefundAlone: number
  readonly acceptsNoRefundAlone: boolean
}

/** Why the `to` leg must not be filled right now. Null when it may. Ask right before filling: the answer depends on the clock. */
export const whatStopsTheFill = (terms: ReceiveTerms, now: UnixSeconds): FillRefusal | null => {
  if (now >= terms.invoiceExpiresAt) return FillRefusal.InvoiceExpired
  if (terms.htlcExpiresAt === null) return FillRefusal.HoldNotArmed
  const htlcStillLasts = terms.htlcExpiresAt - now
  const refund: RefundTimes = {
    untilRefundOpens: terms.refundOpensAt - now,
    untilRefundAlone: terms.acceptsNoRefundAlone ? null : terms.secondsToRefundAlone,
  }
  const broken = TIME_THE_HTLC_MUST_STILL_LAST.find(([, needed]) => htlcStillLasts < needed(refund))
  return broken ? broken[0] : null
}

/** How long a held HTLC must last, so that an invoice asking for this much is never refused later. */
export const timeTheHtlcMustLast = (secondsToRefundAlone: number, acceptsNoRefundAlone: boolean): number => {
  const refund: RefundTimes = {
    untilRefundOpens: LONGEST_A_FILL_STAYS_LOCKED,
    untilRefundAlone: acceptsNoRefundAlone ? null : secondsToRefundAlone,
  }
  return Math.max(...TIME_THE_HTLC_MUST_STILL_LAST.map(([, needed]) => needed(refund)))
}
