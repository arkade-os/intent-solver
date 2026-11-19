import type { UnixSeconds } from '../shared/time.js'
import type { Transfer, TransferId } from './transfer.js'

export interface TransferRepository {
  add(transfer: Transfer): Promise<void>
  update(id: TransferId, change: (transfer: Transfer) => void | Promise<void>): Promise<Transfer>
  get(id: TransferId): Promise<Transfer | null>
  listUnfinished(): Promise<readonly Transfer[]>
  // Sum of debits charged after `since`, cancelled ones excluded: the rolling daily debit.
  debitedSince(since: UnixSeconds): Promise<bigint>
}
