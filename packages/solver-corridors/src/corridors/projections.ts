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
import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
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
 *
 * Exported for `economics.ts`, which buckets the same rows into the same
 * phases: a second copy of this rule would let the P&L screen and the swap
 * list disagree about whether a refunded row failed.
 */
export const presentedState = (state: string, refundOutcome: 'pushed' | 'external' | null): string =>
  state === 'refused' && refundOutcome !== null ? 'refunded' : state

type ProjectedRow = Pick<SendSwapRow, 'id' | 'amountSats' | 'paymentHash' | 'createdAt' | 'updatedAt' | 'failureReason'>

const project = (
  descriptor: CorridorDescriptor,
  row: ProjectedRow,
  state: string,
  payoutSats: number | null,
): AdminSwap => ({
  ...diagnose(state, row.failureReason),
  id: row.id,
  corridor: descriptor.pair,
  state,
  phase: phaseOfStates(descriptor.states, state),
  amountSats: row.amountSats,
  payoutSats,
  paymentHash: row.paymentHash,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  failureReason: row.failureReason,
})

// This corridor quotes the invoice amount directly and has no payout column.
export const projectSend = (row: SendSwapRow): AdminSwap =>
  project(LN_SEND, row, presentedState(row.state, row.refundOutcome), null)

export const projectReceive = (row: ReceiveSwapRow): AdminSwap => project(LN_RECEIVE, row, row.state, row.payoutSats)

export const projectOnchainSend = (row: OnchainSendSwapRow): AdminSwap =>
  project(ONCHAIN_SEND, row, presentedState(row.state, row.refundOutcome), row.payoutSats)

export const projectOnchainReceive = (row: OnchainReceiveSwapRow): AdminSwap =>
  project(ONCHAIN_RECEIVE, row, row.state, row.payoutSats)
