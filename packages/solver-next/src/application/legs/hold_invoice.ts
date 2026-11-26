import { RuleViolated } from '../../domain/shared/error.js'
import { UnixSeconds } from '../../domain/shared/time.js'
import type { Hashlock } from '../../domain/swap/hashlock.js'
import type { Swap } from '../../domain/swap/swap.js'
import { HoldStatus, type HoldInvoiceNode } from '../../ports/lightning.js'

export interface Hold {
  readonly status: HoldStatus
  /** When the held HTLC fails back to its payer. Null when the node gives no usable time: then it must not be filled against. */
  readonly htlcExpiresAt: UnixSeconds | null
}

const hold = (status: HoldStatus, htlcExpiresAt: UnixSeconds | null = null): Hold => ({ status, htlcExpiresAt })

const timeFrom = (seconds: number | null): UnixSeconds | null => {
  const whole = seconds === null ? null : Math.floor(seconds)
  return whole !== null && Number.isSafeInteger(whole) && whole >= 0 ? UnixSeconds.of(whole) : null
}

const hashOf = (swap: Swap): Hashlock => {
  if (swap.hashlock === null) throw new RuleViolated(`swap ${swap.id}: a hold invoice needs a hashlock`)
  return swap.hashlock
}

/** The `from` leg of a Lightning receive: our node holds the payer's payment until we settle it with the preimage. */
export class HoldInvoice {
  constructor(private readonly node: HoldInvoiceNode) {}

  /** Only `armed` may be filled against. */
  async state(swap: Swap): Promise<Hold> {
    const hash = hashOf(swap)
    const fillStarted = swap.to.state !== 'pending'
    let seen
    try {
      seen = await this.node.getHoldState(hash)
    } catch (error) {
      // Before the fill this answer decides the fill, so a failed read is the caller's to handle.
      // After it the node may have dropped the invoice, and the swap goes by the expiry saved on the leg.
      if (!fillStarted) throw error
      return hold(HoldStatus.Unknown)
    }
    switch (seen.status) {
      case HoldStatus.Armed:
        return hold(HoldStatus.Armed, timeFrom(seen.expiresAt))
      case HoldStatus.Pending:
        // A hold we filled against was armed once. A node that now calls it pending has forgotten it.
        return hold(fillStarted ? HoldStatus.Unknown : HoldStatus.Pending)
      case HoldStatus.Settled:
      case HoldStatus.Cancelled:
        return hold(seen.status)
      default:
        return hold(HoldStatus.Unknown)
    }
  }

  /** A throw does not mean the hold was not settled: the node may have done it and failed to answer. Read the state again. */
  async settle(swap: Swap): Promise<void> {
    hashOf(swap)
    if (swap.preimage === null) throw new RuleViolated(`swap ${swap.id}: no preimage to settle the hold with`)
    await this.node.settleHold(swap.preimage)
  }

  // Tidying up, never a money step: it must not be able to stop the swap from ending, so a failure is dropped.
  async closeIfNotPaid(swap: Swap): Promise<void> {
    const hash = hashOf(swap)
    if (swap.to.state !== 'pending' || !this.node.cancelHold) return
    try {
      if ((await this.node.getHoldState(hash)).status === HoldStatus.Pending) await this.node.cancelHold(hash)
    } catch {
      return
    }
  }
}
