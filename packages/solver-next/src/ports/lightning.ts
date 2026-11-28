import type { ValueOf } from '../domain/shared/brand.js'

export const HoldStatus = {
  Pending: 'pending',
  Armed: 'armed',
  Settled: 'settled',
  Cancelled: 'cancelled',
  Unknown: 'unknown',
} as const

export type HoldStatus = ValueOf<typeof HoldStatus>

export interface HoldState {
  readonly status: HoldStatus
  /** Unix seconds. A node may leave it out even while it holds a payment. */
  readonly expiresAt: number | null
}

// The method names are the ones the node adapters already have.
export interface HoldInvoiceNode {
  getHoldState(paymentHash: string): Promise<HoldState>
  settleHold(preimage: string): Promise<void>
  /** Only for an invoice nobody paid. A node cannot promise to hand a held payment back. */
  cancelHold?(paymentHash: string): Promise<void>
}

export const PaymentResultStatus = {
  Pending: 'pending',
  Succeeded: 'succeeded',
  Failed: 'failed',
} as const

export type PaymentResultStatus = ValueOf<typeof PaymentResultStatus>

export interface PaymentResult {
  readonly id: string
  readonly status: PaymentResultStatus
  /** `no_record`: the node never heard of the payment. Right after sending, that can be lag. */
  readonly evidence?: 'no_record' | 'in_flight' | 'terminal'
  /** Often missing on the first answer, even for a payment that succeeds. */
  readonly preimage?: string
  readonly feePaidSats?: number
}

export const SendHtlcStatus = {
  Committed: 'committed',
  Settled: 'settled',
  Returned: 'returned',
} as const

export type SendHtlcStatus = ValueOf<typeof SendHtlcStatus>

export interface SendHtlcState {
  readonly status: SendHtlcStatus
  readonly preimage?: string
}

export interface PayInvoiceParams {
  readonly invoice: string
  readonly maxFeeSats: number
  /** The same key on every call for one swap, so a repeated call cannot pay twice. */
  readonly idempotencyKey: string
  /** Blocks from now. The payment must not outlive the client's refund deadline. */
  readonly maxCltvBlocks: number
}

export interface PayingNode {
  payInvoice(params: PayInvoiceParams): Promise<PaymentResult>
  getPayment(id: string): Promise<PaymentResult>
  /** Null when nothing is committed against the hash. A node that cannot say must throw, not answer null. */
  getSendHtlcState?(paymentHash: string): Promise<SendHtlcState | null>
}
