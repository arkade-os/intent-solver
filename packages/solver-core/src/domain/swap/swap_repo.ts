import type { RfqId, SwapId } from '../shared/ids.js'
import type { Hashlock } from './hashlock.js'
import type { Reference } from './leg.js'
import type { Swap } from './swap.js'

export interface Page {
  readonly after: SwapId | null
  readonly limit: number
}

export interface SwapRepository {
  // Throws when the rfqId exists or a live swap already holds the same script.
  add(swap: Swap): Promise<void>
  // Loads, applies `change`, saves. Not a transaction: the save fails when another writer got there first.
  update(id: SwapId, change: (swap: Swap) => void | Promise<void>): Promise<Swap>

  get(id: SwapId): Promise<Swap | null>
  findByRfqId(rfqId: RfqId): Promise<Swap | null>
  // Every swap on the hash that was not refused, finished ones included: a hash whose preimage may be public
  // must never be quoted again. A list, because one payment between two of our clients is two swaps on one hash.
  findByHash(hashlock: Hashlock): Promise<readonly Swap[]>
  findLiveByScript(script: string): Promise<Swap | null>
  // A list: one transaction can fund several swaps.
  findByFundingTx(funding: Reference): Promise<readonly Swap[]>
  listOpen(page: Page): Promise<readonly Swap[]>
}
