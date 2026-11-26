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
