import type { ValueOf } from '../../domain/shared/brand.js'
import { RuleViolated } from '../../domain/shared/error.js'
import { UnixSeconds } from '../../domain/shared/time.js'
import type { Hashlock } from '../../domain/swap/hashlock.js'
import type { Swap } from '../../domain/swap/swap.js'
import { HoldStatus, type HoldState, type HoldingNode } from '../../ports/lightning.js'

export const PaymentIs = {
  NotPaid: 'not_paid',
  Waiting: 'waiting',
  Collected: 'collected',
  GoneBack: 'gone_back',
  Unknown: 'unknown',
} as const

export type PaymentIs = ValueOf<typeof PaymentIs>

export interface PaymentSeen {
  readonly is: PaymentIs
  /** When a waiting payment returns to its payer on its own. Null when the node does not say: then it must not be paid out against. */
  readonly goesBackAt: UnixSeconds | null
}

const seen = (is: PaymentIs, goesBackAt: UnixSeconds | null = null): PaymentSeen => ({ is, goesBackAt })

const timeFrom = (seconds: number | null): UnixSeconds | null => {
  const whole = seconds === null ? null : Math.floor(seconds)
  return whole !== null && Number.isSafeInteger(whole) && whole >= 0 ? UnixSeconds.of(whole) : null
}

const invoiceOf = (swap: Swap): Hashlock => {
  if (swap.hashlock === null) throw new RuleViolated(`swap ${swap.id}: a payment over Lightning needs a hashlock`)
  return swap.hashlock
}

/** What the client's payer sent over Lightning: our node holds it until we collect it with the secret. */
export class HeldPayment {
  constructor(private readonly node: HoldingNode) {}

  /** Only `waiting` may be paid out against. */
  async look(swap: Swap): Promise<PaymentSeen> {
    const invoice = invoiceOf(swap)
    const payoutStarted = swap.to.state !== 'pending'
    let hold: HoldState
    try {
      hold = await this.node.getHoldState(invoice)
    } catch (error) {
      // Before the payout this answer decides the payout, so a failed read is the caller's to handle.
      // After it the node may have dropped the invoice, and the swap goes by the time saved with the payment.
      if (!payoutStarted) throw error
      return seen(PaymentIs.Unknown)
    }
    switch (hold.status) {
      case HoldStatus.Pending:
        // A payment we paid out against was waiting once. A node that now calls it unpaid has forgotten it.
        return seen(payoutStarted ? PaymentIs.Unknown : PaymentIs.NotPaid)
      case HoldStatus.Armed:
        return seen(PaymentIs.Waiting, timeFrom(hold.expiresAt))
      case HoldStatus.Settled:
        return seen(PaymentIs.Collected)
      case HoldStatus.Cancelled:
        return seen(PaymentIs.GoneBack)
      default:
        return seen(PaymentIs.Unknown)
    }
  }

  /** A throw does not mean the payment was not collected: the node may have done it and failed to answer. Look again. */
  async collect(swap: Swap): Promise<void> {
    invoiceOf(swap)
    if (swap.preimage === null) throw new RuleViolated(`swap ${swap.id}: no secret to collect the payment with`)
    await this.node.settleHold(swap.preimage)
  }

  // Tidying up, never a money step: it must not be able to stop the swap from ending, so a failure is dropped.
  async closeIfNotPaid(swap: Swap): Promise<void> {
    const invoice = invoiceOf(swap)
    if (swap.to.state !== 'pending' || !this.node.cancelHold) return
    try {
      if ((await this.node.getHoldState(invoice)).status === HoldStatus.Pending) await this.node.cancelHold(invoice)
    } catch {
      return
    }
  }
}
