import type { ValueOf } from '../shared/brand.js'
import { InvalidValue } from '../shared/error.js'
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

interface Fill {
  readonly at: number
  readonly refundOpensAt: number
  /** With the Arkade server gone. Null when the operator accepts having no such refund in time. */
  readonly secondsToRefundAlone: number | null
}

// The held HTLC must not expire before any of these moments. Checked in this order.
const EARLIEST_THE_HTLC_MAY_EXPIRE: readonly [FillRefusal, (fill: Fill) => number][] = [
  [FillRefusal.TooLittleTimeToSettle, (fill) => fill.at + TIME_TO_SETTLE],
  [FillRefusal.RefundOpensTooLate, (fill) => fill.refundOpensAt + SPARE_TIME_AFTER_REFUND_OPENS],
  [
    FillRefusal.RefundAloneOpensTooLate,
    (fill) =>
      fill.secondsToRefundAlone === null
        ? fill.at
        : fill.at + fill.secondsToRefundAlone + SPARE_TIME_AFTER_REFUND_ALONE,
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

// Below this a locktime is a block height. The rules compare times, so a height must be converted before it gets here.
const FIRST_LOCKTIME_THAT_IS_A_TIME = 500_000_000

const checked = (terms: ReceiveTerms): ReceiveTerms => {
  if (terms.refundOpensAt < FIRST_LOCKTIME_THAT_IS_A_TIME) {
    throw new InvalidValue(`refundOpensAt must be a unix time, not a block height: ${terms.refundOpensAt}`)
  }
  if (!(terms.secondsToRefundAlone >= 0) || !Number.isFinite(terms.secondsToRefundAlone)) {
    throw new InvalidValue(`secondsToRefundAlone must not be negative: ${terms.secondsToRefundAlone}`)
  }
  return terms
}

/** Why the `to` leg must not be filled right now. Null when it may. Ask right before filling: the answer depends on the clock. */
export const whatStopsTheFill = (terms: ReceiveTerms, now: UnixSeconds): FillRefusal | null => {
  const { invoiceExpiresAt, htlcExpiresAt, refundOpensAt, secondsToRefundAlone, acceptsNoRefundAlone } = checked(terms)
  if (now >= invoiceExpiresAt) return FillRefusal.InvoiceExpired
  if (htlcExpiresAt === null) return FillRefusal.HoldNotArmed
  const fill: Fill = {
    at: now,
    refundOpensAt,
    secondsToRefundAlone: acceptsNoRefundAlone ? null : secondsToRefundAlone,
  }
  const broken = EARLIEST_THE_HTLC_MAY_EXPIRE.find(([, earliest]) => htlcExpiresAt < earliest(fill))
  return broken ? broken[0] : null
}

/** How long a held HTLC must last, so that an invoice asking for this much is never refused later. */
export const timeTheHtlcMustLast = (secondsToRefundAlone: number, acceptsNoRefundAlone: boolean): number => {
  // A fill at time zero whose refund opens as late as we allow: every moment below is then a duration.
  const fill: Fill = {
    at: 0,
    refundOpensAt: LONGEST_A_FILL_STAYS_LOCKED,
    secondsToRefundAlone: acceptsNoRefundAlone ? null : secondsToRefundAlone,
  }
  return Math.max(...EARLIEST_THE_HTLC_MAY_EXPIRE.map(([, earliest]) => earliest(fill)))
}
