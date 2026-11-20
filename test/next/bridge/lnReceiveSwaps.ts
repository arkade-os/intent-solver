import type { RfqId } from '@arkade-os/solver-next/domain/shared/ids.js'
import type { Hashlock } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import type { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import type { SwapRepository } from '@arkade-os/solver-next/domain/swap/swap_repo.js'
import { swapFromReceiveRow } from '@arkade-os/solver-next/infrastructure/db/receive_swap_table.js'
import type { ReceiveSwapRow, ReceiveSwapState, ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'

export { swapFromReceiveRow }

type Lived = Exclude<ReceiveSwapState, 'refused' | 'stuck'>
const isFailed = (state: ReceiveSwapState): boolean => state === 'refused' || state === 'stuck'

/** Reads `receive_swap` as swaps. Writes still go through the legacy orchestrator. */
export class LnReceiveSwaps implements Pick<SwapRepository, 'findByRfqId' | 'findByHash'> {
  constructor(private readonly store: ReceiveSwapStore) {}

  async findByRfqId(rfqId: RfqId): Promise<Swap | null> {
    const row = await this.store.findByRfqId(rfqId)
    return row === null ? null : this.load(row)
  }

  async findByHash(hashlock: Hashlock): Promise<readonly Swap[]> {
    const row = await this.store.findLiveByPaymentHash(hashlock)
    return row === null ? [] : [await this.load(row)]
  }

  async load(row: ReceiveSwapRow): Promise<Swap> {
    if (!isFailed(row.state)) return swapFromReceiveRow(row)
    const failure = (await this.store.history(row.id)).findLast((e) => e.to === row.state && e.from !== e.to)
    return swapFromReceiveRow(row, (failure?.from ?? null) as Lived | null)
  }
}
