import type { ValueOf } from '../../domain/shared/brand.js'
import { RuleViolated } from '../../domain/shared/error.js'
import { Preimage, type Hashlock } from '../../domain/swap/hashlock.js'
import { Reference } from '../../domain/swap/leg.js'
import type { Swap } from '../../domain/swap/swap.js'
import {
  PaymentResultStatus,
  SendHtlcStatus,
  type PayInvoiceParams,
  type PayingNode,
  type PaymentResult,
} from '../../ports/lightning.js'

export const PaymentStatus = {
  /** Certain: the node holds nothing against the hash. */
  NotSent: 'not_sent',
  InFlight: 'in_flight',
  Paid: 'paid',
  /** Over, and nothing was delivered. */
  Failed: 'failed',
  /** No payment id is on record and the node cannot be asked by hash. */
  Unknown: 'unknown',
} as const

export type PaymentStatus = ValueOf<typeof PaymentStatus>

export interface Payment {
  readonly status: PaymentStatus
  /** A paid payment can be without one for a while. Nothing can be collected until it is here. */
  readonly preimage: Preimage | null
  readonly feePaidSats: number | null
  /** The node says it failed because it never heard of it. Right after sending, wait before believing that. */
  readonly noRecord: boolean
}

export type PayOrder = Omit<PayInvoiceParams, 'idempotencyKey'>

const payment = (status: PaymentStatus, known: Partial<Payment> = {}): Payment => ({
  status,
  preimage: null,
  feePaidSats: null,
  noRecord: false,
  ...known,
})

const hashOf = (swap: Swap): Hashlock => {
  if (swap.hashlock === null) throw new RuleViolated(`swap ${swap.id}: a Lightning payment needs a hashlock`)
  return swap.hashlock
}

const wellFormed = (revealed: string): Preimage | null => {
  try {
    return Preimage.of(revealed.toLowerCase())
  } catch {
    return null
  }
}

/** The `to` leg of a Lightning send: our node pays the client's invoice and learns the preimage. */
export class ToLightning {
  constructor(private readonly node: PayingNode) {}

  async state(swap: Swap): Promise<Payment> {
    const hash = hashOf(swap)
    const id = swap.to.fact('funding')
    if (id !== null) return this.read(swap, await this.node.getPayment(id))
    // A crash between paying and recording the id leaves only the hash to ask by.
    if (!this.node.getSendHtlcState) return payment(PaymentStatus.Unknown)
    const htlc = await this.node.getSendHtlcState(hash)
    switch (htlc?.status) {
      case undefined:
        return payment(PaymentStatus.NotSent)
      case SendHtlcStatus.Committed:
        return payment(PaymentStatus.InFlight)
      case SendHtlcStatus.Settled:
        return payment(PaymentStatus.Paid, { preimage: this.verified(swap, htlc.preimage) })
      case SendHtlcStatus.Returned:
        return payment(PaymentStatus.Failed)
      default:
        return payment(PaymentStatus.Unknown)
    }
  }

  /** A throw does not mean nothing was sent: read the state again. Record the id before anything else. */
  async pay(swap: Swap, order: PayOrder): Promise<{ id: Reference; payment: Payment }> {
    // The key production already sends, so a payment started by today's code is not paid again.
    const result = await this.node.payInvoice({ ...order, idempotencyKey: `swap-${hashOf(swap)}` })
    return { id: Reference.of(result.id), payment: this.read(swap, result) }
  }

  private read(swap: Swap, seen: PaymentResult): Payment {
    switch (seen.status) {
      case PaymentResultStatus.Succeeded:
        return payment(PaymentStatus.Paid, {
          preimage: this.verified(swap, seen.preimage),
          feePaidSats: seen.feePaidSats ?? null,
        })
      case PaymentResultStatus.Pending:
        return payment(PaymentStatus.InFlight)
      case PaymentResultStatus.Failed:
        return payment(PaymentStatus.Failed, { noRecord: seen.evidence === 'no_record' })
      default:
        return payment(PaymentStatus.Unknown)
    }
  }

  // A preimage that does not open this swap's hashlock collects nothing: nothing may act on it.
  private verified(swap: Swap, revealed: string | undefined): Preimage | null {
    if (!revealed) return null
    const preimage = wellFormed(revealed)
    if (preimage === null || !Preimage.opens(preimage, hashOf(swap))) {
      throw new RuleViolated(`swap ${swap.id}: the node reported a preimage that does not open the hashlock`)
    }
    return preimage
  }
}
