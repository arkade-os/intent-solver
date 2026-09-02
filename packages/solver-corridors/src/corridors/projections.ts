/**
 * How each corridor renders one of its own rows for the console.
 *
 * This is a CORRIDOR's knowledge, not the console's: only the corridor knows
 * which of its columns is the payout, whether it has one at all, and — see
 * {@link presentedState} — whether the word it stores is the word an operator
 * should read. Keeping it here is what lets `admin/` depend on core alone.
 *
 * The shape and the bucketing rule are core's (`core/swapView.ts`); everything
 * corridor-specific is here.
 */
import { diagnose, phaseOfStates, type AdminSwap } from '@arkade-os/solver-core/core/swapView.js'
import { LN_SEND, LN_RECEIVE, ONCHAIN_SEND, ONCHAIN_RECEIVE } from './index.js'
import type { SendSwapRow } from '../db/swaps.js'
import type { ReceiveSwapRow } from '../db/receiveSwaps.js'
import type { OnchainSendSwapRow } from '../db/onchainSwaps.js'
import type { OnchainReceiveSwapRow } from '../db/onchainReceiveSwaps.js'

/**
 * The one deliberate exception to "state verbatim". The two SEND corridors
 * record a refund as a patch column on a `refused` row rather than as a state
 * of its own (see `db/swaps.ts`), so their real state word for "refunded" IS
 * `refused` — and showing that word hides the refund from the history table.
 * Present it as `refunded`, the word the other two corridors and the
 * client-facing wire already use. `stuck` is NOT rewritten even when a refund
 * landed: on these corridors `stuck` means the solver paid out and was not
 * made whole, and that still needs an operator regardless of the client being
 * refunded (see `send/orchestrator.ts`).
 */
const presentedState = (state: string, refundOutcome: 'pushed' | 'external' | null): string =>
  state === 'refused' && refundOutcome !== null ? 'refunded' : state

export const projectSend = (row: SendSwapRow): AdminSwap => {
  const state = presentedState(row.state, row.refundOutcome)
  return {
    ...diagnose(state, row.failureReason),
    id: row.id,
    corridor: LN_SEND.pair,
    state,
    phase: phaseOfStates(LN_SEND.states, state),
    amountSats: row.amountSats,
    // This corridor quotes the invoice amount directly and has no payout column.
    payoutSats: null,
    paymentHash: row.paymentHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    failureReason: row.failureReason,
  }
}

export const projectReceive = (row: ReceiveSwapRow): AdminSwap => ({
  ...diagnose(row.state, row.failureReason),
  id: row.id,
  corridor: LN_RECEIVE.pair,
  state: row.state,
  phase: phaseOfStates(LN_RECEIVE.states, row.state),
  amountSats: row.amountSats,
  payoutSats: row.payoutSats,
  paymentHash: row.paymentHash,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  failureReason: row.failureReason,
})

export const projectOnchainSend = (row: OnchainSendSwapRow): AdminSwap => {
  const state = presentedState(row.state, row.refundOutcome)
  return {
    ...diagnose(state, row.failureReason),
    id: row.id,
    corridor: ONCHAIN_SEND.pair,
    state,
    phase: phaseOfStates(ONCHAIN_SEND.states, state),
    amountSats: row.amountSats,
    payoutSats: row.payoutSats,
    paymentHash: row.paymentHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    failureReason: row.failureReason,
  }
}

export const projectOnchainReceive = (row: OnchainReceiveSwapRow): AdminSwap => ({
  ...diagnose(row.state, row.failureReason),
  id: row.id,
  corridor: ONCHAIN_RECEIVE.pair,
  state: row.state,
  phase: phaseOfStates(ONCHAIN_RECEIVE.states, row.state),
  amountSats: row.amountSats,
  payoutSats: row.payoutSats,
  paymentHash: row.paymentHash,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  failureReason: row.failureReason,
})
