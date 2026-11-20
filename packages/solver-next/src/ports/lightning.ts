import type { ValueOf } from '../domain/shared/brand.js'

export const HoldStatus = {
  /** The invoice exists and nobody has paid it. */
  Pending: 'pending',
  /** A payer's payment is held and waits for us to settle it. */
  Armed: 'armed',
  Settled: 'settled',
  /** Cancelled by us while unpaid, or timed out. */
  Cancelled: 'cancelled',
  /** The node answered with a status this build does not know. Only `armed` may be acted on. */
  Unknown: 'unknown',
} as const

export type HoldStatus = ValueOf<typeof HoldStatus>

export interface HoldState {
  readonly status: HoldStatus
  /** When a held payment times out, in unix seconds. Null unless one is held. */
  readonly expiresAt: number | null
}

/** A Lightning node that can hold a payment until we reveal the preimage. */
export interface HeldPayments {
  getHoldState(paymentHash: string): Promise<HoldState>
  settleHold(preimage: string): Promise<void>
  /** Only for an invoice nobody paid. A node cannot promise to hand a held payment back. */
  cancelHold?(paymentHash: string): Promise<void>
}
