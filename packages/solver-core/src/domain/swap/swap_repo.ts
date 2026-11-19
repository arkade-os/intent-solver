import type { RfqId, SwapId } from '../shared/ids.js'
import type { Hashlock } from './hashlock.js'
import type { Swap } from './swap.js'

export interface Page {
  readonly after: SwapId | null
  readonly limit: number
}

export interface SwapRepository {
  // Throws when the rfqId exists or a live swap already holds the same script.
  add(swap: Swap): Promise<void>
  // Loads, applies `change` and saves in one transaction; throws when another writer got there first.
  update(id: SwapId, change: (swap: Swap) => void | Promise<void>): Promise<Swap>

  get(id: SwapId): Promise<Swap | null>
  findByRfqId(rfqId: RfqId): Promise<Swap | null>
  // A list: one payment between two of our clients is two live swaps on one hash.
  findLiveByHash(hashlock: Hashlock): Promise<readonly Swap[]>
  findLiveByScript(script: string): Promise<Swap | null>
  // A list: one transaction can fund several swaps.
  findByFundingTx(txid: string): Promise<readonly Swap[]>
  listOpen(page: Page): Promise<readonly Swap[]>
}
