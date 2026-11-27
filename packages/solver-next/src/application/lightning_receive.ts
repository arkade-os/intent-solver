import type { ValueOf } from '../domain/shared/brand.js'
import { RuleViolated } from '../domain/shared/error.js'
import type { UnixSeconds } from '../domain/shared/time.js'
import type { Preimage } from '../domain/swap/hashlock.js'
import type { Reference } from '../domain/swap/leg.js'
import { whatStopsTheFill } from '../domain/swap/lightning_receive.js'
import type { Swap } from '../domain/swap/swap.js'
import { HoldStatus } from '../ports/lightning.js'
import type { HoldInvoice } from './legs/hold_invoice.js'
import { LockupStatus, type SolverLockup } from './legs/solver_lockup.js'

/** How long a lockup may read as gone before that is believed: its claim is readable a little after the spend. */
export const EMPTY_LOCKUP_GRACE = 120

export const RECEIVE_INVOICE_NEVER_ARMED = 'invoice expired before it was ever armed'
export const RECEIVE_FUNDING_LOST =
  'funding response lost; refund deadline reached with no lockup adopted — review for a stray lockup'
export const RECEIVE_LOCKUP_GONE = 'funded output gone during refunding with no matching claim found; needs review'

export const Do = {
  Wait: 'wait',
  Arm: 'arm',
  Adopt: 'adopt',
  Fund: 'fund',
  RecordClaim: 'record_claim',
  Settle: 'settle',
  StartRefund: 'start_refund',
  Refund: 'refund',
  RefundUnrolled: 'refund_unrolled',
  RecordRefund: 'record_refund',
  /** Ends the swap: refused while nothing of ours is out, stuck otherwise. */
  Fail: 'fail',
  Stuck: 'stuck',
} as const

export type Do = ValueOf<typeof Do>

export interface ReceiveStep {
  readonly do: Do
  readonly reason?: string
  readonly htlcExpiresAt?: UnixSeconds | null
  readonly outpoint?: Reference
  readonly preimage?: Preimage
  readonly refundTx?: Reference
  readonly closeInvoice?: true
}

export interface ReceiveSettings {
  readonly acceptsNoRefundAlone: boolean
}

const WAIT: ReceiveStep = { do: Do.Wait }
const fail = (reason: string): ReceiveStep => ({ do: Do.Fail, reason })

export class LightningReceive {
  constructor(
    private readonly invoice: HoldInvoice,
    private readonly lockup: SolverLockup,
    private readonly now: () => UnixSeconds,
    private readonly settings: ReceiveSettings,
  ) {}

  /** Reads, decides, changes nothing. */
  next(swap: Swap): Promise<ReceiveStep> {
    switch (swap.state) {
      case 'quoted':
        return this.whenQuoted(swap)
      case 'funded':
        return this.whenFunded(swap)
      case 'filling':
        return this.whenFilling(swap)
      case 'awaiting_claim':
        return this.whenAwaitingClaim(swap)
      case 'filled':
      case 'settling':
        return Promise.resolve({ do: Do.Settle })
      case 'refunding':
        return this.whenRefunding(swap)
      default:
        return Promise.resolve(WAIT)
    }
  }

  private async whenQuoted(swap: Swap): Promise<ReceiveStep> {
    const hold = await this.invoice.state(swap)
    if (hold.status === HoldStatus.Armed) return { do: Do.Arm, htlcExpiresAt: hold.htlcExpiresAt }
    return this.now() >= this.invoiceExpiresAt(swap)
      ? { do: Do.Fail, reason: RECEIVE_INVOICE_NEVER_ARMED, closeInvoice: true }
      : WAIT
  }

  private async whenFunded(swap: Swap): Promise<ReceiveStep> {
    // Before any rule: a crashed attempt may already have filled, and filling again pays twice for one claim.
    const lockup = await this.lockup.state(swap)
    if (lockup.outpoint !== null) return { do: Do.Adopt, outpoint: lockup.outpoint }

    // Read again here, right before the fill. Only an armed hold gives an expiry that is trusted.
    const hold = await this.invoice.state(swap)
    const refund = await this.lockup.refundTimes(swap)
    const stops = whatStopsTheFill(
      {
        invoiceExpiresAt: this.invoiceExpiresAt(swap),
        htlcExpiresAt: hold.status === HoldStatus.Armed ? hold.htlcExpiresAt : null,
        refundOpensAt: refund.refundOpensAt,
        secondsToRefundAlone: refund.secondsToRefundAlone,
        acceptsNoRefundAlone: this.settings.acceptsNoRefundAlone,
      },
      this.now(),
    )
    return stops === null ? { do: Do.Fund } : fail(`refused to fund: ${stops}`)
  }

  // A fill was started and its answer never recorded. It is never sent again: a lockup may be out there.
  private async whenFilling(swap: Swap): Promise<ReceiveStep> {
    const lockup = await this.lockup.state(swap)
    if (lockup.outpoint !== null) return { do: Do.Adopt, outpoint: lockup.outpoint }
    const { refundOpensAt } = await this.lockup.refundTimes(swap)
    return this.now() >= refundOpensAt ? { do: Do.Stuck, reason: RECEIVE_FUNDING_LOST } : WAIT
  }

  private async whenAwaitingClaim(swap: Swap): Promise<ReceiveStep> {
    if (!this.lockup.hasOutpointOnRecord(swap)) return fail('funded state with no funded outpoint recorded')
    const lockup = await this.lockup.state(swap)
    if (lockup.preimage !== null) return { do: Do.RecordClaim, preimage: lockup.preimage }
    return (await this.lockup.refundTimes(swap)).refundOpen ? { do: Do.StartRefund } : WAIT
  }

  private async whenRefunding(swap: Swap): Promise<ReceiveStep> {
    if (!this.lockup.hasOutpointOnRecord(swap)) return fail('refunding state with no funded outpoint recorded')
    const lockup = await this.lockup.state(swap)
    switch (lockup.status) {
      case LockupStatus.Claimed:
        // A late claim can still land, and a refund pushed against it could only lose.
        return { do: Do.RecordClaim, preimage: lockup.preimage! }
      case LockupStatus.Unrolled:
        return { do: Do.RefundUnrolled }
      case LockupStatus.Funded:
        return { do: Do.Refund }
      case LockupStatus.Refunded:
        return { do: Do.RecordRefund, refundTx: lockup.refundTx! }
      default:
        return this.whenLockupIsGone(swap)
    }
  }

  // Giving up stops the read that could still recover the swap, so it waits while the hold can still be settled.
  private whenLockupIsGone(swap: Swap): ReceiveStep {
    const now = this.now()
    if (now - swap.to.since < EMPTY_LOCKUP_GRACE) return WAIT
    const htlcExpiresAt = swap.from.expiresAt
    return htlcExpiresAt !== null && now < htlcExpiresAt ? WAIT : fail(RECEIVE_LOCKUP_GONE)
  }

  private invoiceExpiresAt(swap: Swap): UnixSeconds {
    const { validUntil } = swap.quote
    if (validUntil === null) throw new RuleViolated(`swap ${swap.id}: a Lightning receive quote must expire`)
    return validUntil
  }
}
