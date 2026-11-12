import type { SendSwapRow, SendSwapRepository } from '@arkade-os/solver-corridors/db/swaps.js'
import type { ReceiveSwapRow, ReceiveSwapRepository } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import type { OnchainSendSwapRow, OnchainSendSwapRepository } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import type { AssetRfqSwapRow, AssetRfqSwapRepository } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import type { OfferFillRow, OfferFillRepository } from '@arkade-os/solver-corridors/db/offerFills.js'
import type { EvmSendSwapRow, EvmSendSwapRepository } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import type { EvmReceiveSwapRow, EvmReceiveSwapRepository } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'
import type {
  EvmTransactionAttemptRow,
  EvmTransactionJournal,
  EvmTransactionJournalRow,
} from '@arkade-os/solver-rails-evm/evm/durableSender.js'
import type {
  AdminMigrationRow,
  AdminNotifyStateRow,
  AdminOverrideRow,
  AdminRepository,
  AssetMarketRow,
  AuditRow,
  BalanceCheckpointRow,
  BalanceReportCheckpointRow,
  OperatorWithdrawal,
  SwapApprovalRow,
} from '../admin/db.js'
import type {
  RebalanceClockRow,
  RebalanceRepository,
  RebalanceRfqRepository,
  RebalanceRfqRow,
  RebalanceTransferRow,
} from './rebalanceStore.js'

/** One row of any `<swap>_event` table, as stored. */
export interface SwapEventRow {
  id: number
  swap_id: string
  at: number
  from_state: string | null
  to_state: string
  detail: string | null
}

export type OfferFillEventRow = Omit<SwapEventRow, 'swap_id'> & { fill_id: string }

/** Every table the solver creates, as the object a row of it is read into. */
export interface SolverTables {
  send_swap: SendSwapRow
  send_swap_event: SwapEventRow
  receive_swap: ReceiveSwapRow
  receive_swap_event: SwapEventRow
  send_onchain_swap: OnchainSendSwapRow
  send_onchain_swap_event: SwapEventRow
  asset_rfq_swap: AssetRfqSwapRow
  asset_rfq_swap_event: SwapEventRow
  offer_fill: OfferFillRow
  offer_fill_event: OfferFillEventRow
  send_evm_swap: EvmSendSwapRow
  send_evm_swap_event: SwapEventRow
  receive_evm_swap: EvmReceiveSwapRow
  receive_evm_swap_event: SwapEventRow
  evm_transaction_journal: EvmTransactionJournalRow
  evm_transaction_attempts: EvmTransactionAttemptRow
  admin_action: AuditRow
  admin_market: AssetMarketRow
  admin_migration: AdminMigrationRow
  admin_notify_state: AdminNotifyStateRow
  admin_override: AdminOverrideRow
  admin_swap_approval: SwapApprovalRow
  balance_checkpoint: BalanceCheckpointRow
  balance_report_checkpoint: BalanceReportCheckpointRow
  operator_withdrawal: OperatorWithdrawal
  rebalance_clock: RebalanceClockRow
  rebalance_rfq: RebalanceRfqRow
  rebalance_transfer: RebalanceTransferRow
}

/** The repository that reads and writes each table; an event table belongs to its swap's repository. */
export interface SolverRepositories {
  send_swap: SendSwapRepository
  receive_swap: ReceiveSwapRepository
  send_onchain_swap: OnchainSendSwapRepository
  asset_rfq_swap: AssetRfqSwapRepository
  offer_fill: OfferFillRepository
  send_evm_swap: EvmSendSwapRepository
  receive_evm_swap: EvmReceiveSwapRepository
  evm_transaction_journal: EvmTransactionJournal
  admin: AdminRepository
  rebalance: RebalanceRepository
  rebalance_rfq: RebalanceRfqRepository
}

/** Where each table's statements live, keyed like {@link SolverTables}. */
export const SCHEMA_CATALOG = {
  send_swap: 'packages/solver-corridors/src/db/swaps.sql.ts',
  send_swap_event: 'packages/solver-corridors/src/db/swaps.sql.ts',
  receive_swap: 'packages/solver-corridors/src/db/receiveSwaps.sql.ts',
  receive_swap_event: 'packages/solver-corridors/src/db/receiveSwaps.sql.ts',
  send_onchain_swap: 'packages/solver-corridors/src/db/onchainSwaps.sql.ts',
  send_onchain_swap_event: 'packages/solver-corridors/src/db/onchainSwaps.sql.ts',
  asset_rfq_swap: 'packages/solver-corridors/src/db/assetRfqSwaps.sql.ts',
  asset_rfq_swap_event: 'packages/solver-corridors/src/db/assetRfqSwaps.sql.ts',
  offer_fill: 'packages/solver-corridors/src/db/offerFills.sql.ts',
  offer_fill_event: 'packages/solver-corridors/src/db/offerFills.sql.ts',
  send_evm_swap: 'packages/solver-corridors-evm/src/db/evmSendSwaps.sql.ts',
  send_evm_swap_event: 'packages/solver-corridors-evm/src/db/evmSendSwaps.sql.ts',
  receive_evm_swap: 'packages/solver-corridors-evm/src/db/evmReceiveSwaps.sql.ts',
  receive_evm_swap_event: 'packages/solver-corridors-evm/src/db/evmReceiveSwaps.sql.ts',
  evm_transaction_journal: 'packages/solver-rails-evm/src/evm/durableSender.sql.ts',
  evm_transaction_attempts: 'packages/solver-rails-evm/src/evm/durableSender.sql.ts',
  admin_action: 'packages/solver-app/src/admin/db.sql.ts',
  admin_market: 'packages/solver-app/src/admin/db.sql.ts',
  admin_migration: 'packages/solver-app/src/admin/db.sql.ts',
  admin_notify_state: 'packages/solver-app/src/admin/db.sql.ts',
  admin_override: 'packages/solver-app/src/admin/db.sql.ts',
  admin_swap_approval: 'packages/solver-app/src/admin/db.sql.ts',
  balance_checkpoint: 'packages/solver-app/src/admin/db.sql.ts',
  balance_report_checkpoint: 'packages/solver-app/src/admin/db.sql.ts',
  operator_withdrawal: 'packages/solver-app/src/admin/db.sql.ts',
  rebalance_clock: 'packages/solver-app/src/ops/rebalanceStore.sql.ts',
  rebalance_rfq: 'packages/solver-app/src/ops/rebalanceStore.sql.ts',
  rebalance_transfer: 'packages/solver-app/src/ops/rebalanceStore.sql.ts',
} as const satisfies Record<keyof SolverTables, string>
