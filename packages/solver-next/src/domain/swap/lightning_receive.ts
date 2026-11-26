import type { ValueOf } from '../shared/brand.js'
import type { UnixSeconds } from '../shared/time.js'

const MINUTE = 60
const HOUR = 60 * MINUTE

export const TIME_TO_COLLECT_THE_PAYMENT = 90 * MINUTE
export const SPARE_TIME_AFTER_PAYOUT_IS_BACK = 15 * MINUTE
export const SPARE_TIME_AFTER_TAKING_IT_BACK_ALONE = 30 * MINUTE
export const LONGEST_A_PAYOUT_STAYS_LOCKED = 2 * HOUR

// The words are what clients and logs already see.
export const PayoutRefusal = {
  InvoiceExpired: 'invoice_expired',
  NobodyPaidYet: 'htlc_not_armed',
  TooLittleTimeToCollect: 'settle_window_too_short',
  PayoutComesBackTooLate: 'refund_deadline_too_late',
  CannotTakeItBackAloneInTime: 'unilateral_recourse_after_htlc',
} as const

export type PayoutRefusal = ValueOf<typeof PayoutRefusal>

/** How long our payout can stay away from us, in seconds. */
interface PayoutAway {
  readonly untilItComesBack: number
  /** With the Arkade server gone. Null when the operator accepts not being covered for that. */
  readonly untilWeTakeItBackAlone: number | null
}

// The payment waiting for us must not expire before each of these has passed. Checked in this order.
const TIME_THE_PAYMENT_MUST_STILL_LAST: readonly [PayoutRefusal, (payout: PayoutAway) => number][] = [
  [PayoutRefusal.TooLittleTimeToCollect, () => TIME_TO_COLLECT_THE_PAYMENT],
  [PayoutRefusal.PayoutComesBackTooLate, (payout) => payout.untilItComesBack + SPARE_TIME_AFTER_PAYOUT_IS_BACK],
  [
    PayoutRefusal.CannotTakeItBackAloneInTime,
    (payout) =>
      payout.untilWeTakeItBackAlone === null
        ? 0
        : payout.untilWeTakeItBackAlone + SPARE_TIME_AFTER_TAKING_IT_BACK_ALONE,
  ],
]

export interface ReceiveTerms {
  readonly invoiceExpiresAt: UnixSeconds
  /** Null while nobody has paid the invoice. */
  readonly paymentExpiresAt: UnixSeconds | null
  readonly payoutComesBackAt: UnixSeconds
  readonly secondsToTakeItBackAlone: number
  readonly acceptsNotBeingCoveredWithoutArkade: boolean
}

/** Why we must not pay the client out right now. Null when we may. Ask right before paying: the answer depends on the clock. */
export const whatStopsThePayout = (terms: ReceiveTerms, now: UnixSeconds): PayoutRefusal | null => {
  if (now >= terms.invoiceExpiresAt) return PayoutRefusal.InvoiceExpired
  if (terms.paymentExpiresAt === null) return PayoutRefusal.NobodyPaidYet
  const paymentStillLasts = terms.paymentExpiresAt - now
  const payout: PayoutAway = {
    untilItComesBack: terms.payoutComesBackAt - now,
    untilWeTakeItBackAlone: terms.acceptsNotBeingCoveredWithoutArkade ? null : terms.secondsToTakeItBackAlone,
  }
  const broken = TIME_THE_PAYMENT_MUST_STILL_LAST.find(([, needed]) => paymentStillLasts < needed(payout))
  return broken ? broken[0] : null
}

/** How long a payment must be able to wait for us, so that an invoice asking for this much is never refused later. */
export const timeAPaymentMustLast = (
  secondsToTakeItBackAlone: number,
  acceptsNotBeingCoveredWithoutArkade: boolean,
): number => {
  const payout: PayoutAway = {
    untilItComesBack: LONGEST_A_PAYOUT_STAYS_LOCKED,
    untilWeTakeItBackAlone: acceptsNotBeingCoveredWithoutArkade ? null : secondsToTakeItBackAlone,
  }
  return Math.max(...TIME_THE_PAYMENT_MUST_STILL_LAST.map(([, needed]) => needed(payout)))
}
