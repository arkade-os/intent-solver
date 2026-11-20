import { Conflict } from '@arkade-os/solver-next/domain/shared/error.js'
import type { SwapId } from '@arkade-os/solver-next/domain/shared/ids.js'
import { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import type { SwapEvent } from '@arkade-os/solver-next/domain/swap/swap_event.js'
import type { SwapRepository } from '@arkade-os/solver-next/domain/swap/swap_repo.js'

/** A repository for tests. A write fails when the swap changed since it was loaded, as a real one must. */
export class MemorySwaps implements Pick<SwapRepository, 'add' | 'get' | 'update'> {
  private readonly changes = new Map<SwapId, SwapEvent[]>()

  async add(swap: Swap): Promise<void> {
    if (this.changes.has(swap.id)) throw new Conflict(`swap ${swap.id} is already stored`)
    this.changes.set(swap.id, [...swap.changes])
  }

  async get(id: SwapId): Promise<Swap | null> {
    const stored = this.changes.get(id)
    return stored === undefined ? null : Swap.fromEvents(stored)
  }

  async update(id: SwapId, change: (swap: Swap) => void | Promise<void>): Promise<Swap> {
    const stored = this.changes.get(id)
    if (stored === undefined) throw new Conflict(`swap ${id} does not exist`)
    const swap = Swap.fromEvents(stored)
    await change(swap)
    if (stored.length !== swap.version) throw new Conflict(`swap ${id} was changed by another writer`)
    stored.push(...swap.changes)
    return Swap.fromEvents(stored)
  }
}
