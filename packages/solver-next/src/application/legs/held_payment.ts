import { RuleViolated } from '../../domain/shared/error.js'
import { UnixSeconds } from '../../domain/shared/time.js'
import type { Hashlock } from '../../domain/swap/hashlock.js'
import { Reference, type Side } from '../../domain/swap/leg.js'
import { NOT_SEEN, type LegStatus } from '../../domain/swap/observation.js'
import type { Swap } from '../../domain/swap/swap.js'
import { HoldStatus, type HeldPayments } from '../../ports/lightning.js'
import { SendStatus, type RailService, type SendResult } from '../rail_service.js'

const NOT_SENT: SendResult = { status: SendStatus.NotSent }
const UNKNOWN: SendResult = { status: SendStatus.Unknown }

const hashOf = (swap: Swap): Hashlock => {
  if (swap.hashlock === null) throw new RuleViolated(`swap ${swap.id}: a held payment needs a payment hash`)
  return swap.hashlock
}

/** The client's side of a swap they pay over Lightning: a payment our node holds until we settle it. */
export class HeldPayment implements RailService {
  constructor(private readonly node: HeldPayments) {}

  async status(swap: Swap): Promise<LegStatus> {
    const hash = hashOf(swap)
    const paidOut = swap.to.state !== 'pending'
    const hold = await this.node.getHoldState(hash).catch((error: unknown) => {
      // Before the payout this read is what the payout is decided on, so its failure is the caller's.
      // After it the node may have dropped the invoice; the rules then go by the timeout saved with the lock.
      if (!paidOut) throw error
      return null
    })
    switch (hold?.status) {
      case HoldStatus.Armed:
        return {
          ...NOT_SEEN,
          funding: 'exact',
          matured: true,
          expiresAt: hold.expiresAt === null ? null : UnixSeconds.of(hold.expiresAt),
          lockReference: Reference.of(hash),
        }
      case HoldStatus.Settled:
        // Not funded: a settled payment is no longer held, and only a held one may be paid out against.
        return { ...NOT_SEEN, claim: 'landed' }
      case HoldStatus.Cancelled:
        // Before the payout a payment that went back is simply not held any more.
        return paidOut ? { ...NOT_SEEN, spent: { by: 'refund' }, refund: 'landed' } : { ...NOT_SEEN, refund: 'landed' }
      default:
        return NOT_SEEN
    }
  }

  async lock(swap: Swap, side: Side): Promise<SendResult> {
    throw new RuleViolated(`swap ${swap.id}: the ${side} leg is the client's payment; we never lock it`)
  }

  async claim(swap: Swap): Promise<SendResult> {
    const hash = hashOf(swap)
    if (swap.preimage === null) throw new RuleViolated(`swap ${swap.id}: no preimage to settle with`)
    try {
      await this.node.settleHold(swap.preimage)
      return { status: SendStatus.Sent, reference: Reference.of(hash) }
    } catch {
      // The node may have settled before it failed to answer. Its status says which.
      return UNKNOWN
    }
  }

  /** A held payment cannot be handed back. It times out on its own. */
  async refund(): Promise<SendResult> {
    return NOT_SENT
  }

  /** Cancels an invoice nobody paid, so it does not sit on the node until its own expiry. A held one is left alone. */
  async retire(swap: Swap): Promise<void> {
    const hash = hashOf(swap)
    if (!this.node.cancelHold) return
    if ((await this.node.getHoldState(hash)).status === HoldStatus.Pending) await this.node.cancelHold(hash)
  }
}
