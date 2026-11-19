import type { Amount } from '../shared/amount.js'
import type { Asset } from '../shared/asset.js'
import type { UnixSeconds } from '../shared/time.js'
import type { Transfer, TransferId } from './transfer.js'

export interface TransferRepository {
  add(transfer: Transfer): Promise<void>
  update(id: TransferId, change: (transfer: Transfer) => void | Promise<void>): Promise<Transfer>
  get(id: TransferId): Promise<Transfer | null>
  listUnfinished(): Promise<readonly Transfer[]>
  // Sum of debits in `asset` charged after `since`, cancelled ones excluded: the rolling daily debit.
  debitedSince(asset: Asset, since: UnixSeconds): Promise<Amount>
}
