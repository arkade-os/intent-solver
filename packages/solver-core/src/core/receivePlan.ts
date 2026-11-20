/**
 * What a `lightning:BTC->arkade:BTC` swap should do next. Pure: the orchestrator reads, this decides,
 * the orchestrator acts. The mirror of `evmReceivePlan.ts`, one state at a time; `quoted` is the first.
 *
 * `quoted`, in this order:
 * 1. A held payment always wins, over a coupled send and over an expired invoice.
 * 2. With no held payment, a coupled send decides. Its own rules stay in the orchestrator for now.
 * 3. Otherwise an invoice past its expiry is refused, and one before it waits.
 */

import type { HoldState } from '../ports/lightning.js'

export interface ReceivePlanRow {
  state: string
  invoiceExpiresAt: number
}

export interface ReceiveObservation {
  hold: HoldState
  /** A live send swap of our own client holds the same payment hash. Only looked up when nothing is held. */
  coupled: boolean
  nowSeconds: number
}

export type ReceiveAction =
  { do: 'wait' } | { do: 'arm'; htlcExpiresAt: number | null } | { do: 'couple' } | { do: 'refuse'; reason: string }

export const RECEIVE_INVOICE_NEVER_ARMED = 'invoice expired before it was ever armed'

export const planReceive = (row: ReceivePlanRow, seen: ReceiveObservation): ReceiveAction => {
  if (row.state !== 'quoted') return { do: 'wait' }
  if (seen.hold.status === 'armed') return { do: 'arm', htlcExpiresAt: seen.hold.expiresAt }
  if (seen.coupled) return { do: 'couple' }
  if (seen.nowSeconds >= row.invoiceExpiresAt) return { do: 'refuse', reason: RECEIVE_INVOICE_NEVER_ARMED }
  return { do: 'wait' }
}
