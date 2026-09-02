/**
 * Getting onto the contract stream, and staying on it.
 *
 * This wrapper is the reason `cli.ts` can hand `LockupWatcher` a contract
 * source without first awaiting `getContractManager()` — an indexer
 * reconciliation the money path must never wait on. What it owes in exchange is
 * that attaching actually happens: `LockupWatcher.start()` stores the
 * unsubscribe this returns whether or not anything is attached behind it, so a
 * failure that gives up is a fast path silently off until the daemon restarts.
 */

import { describe, it, expect, vi } from 'vitest'
import { lazyContractSource, type ContractManagerLike } from '@arkade-os/solver-arkade/arkade/lazyContractSource.js'
import type { ContractEvent } from '@arkade-os/solver-arkade/arkade/lockupWatcher.js'

class FakeManager implements ContractManagerLike {
  listeners: ((event: ContractEvent) => void)[] = []
  unsubscribes = 0
  contracts: { script: string }[] = []

  onContractEvent(callback: (event: ContractEvent) => void): () => void {
    this.listeners.push(callback)
    return () => {
      this.unsubscribes += 1
      this.listeners = this.listeners.filter((l) => l !== callback)
    }
  }

  async getContracts(): Promise<{ script: string }[]> {
    return this.contracts
  }

  emit(event: ContractEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

const arrival = (contractScript: string): ContractEvent => ({
  type: 'vtxo_received',
  contractScript,
  vtxos: [],
  contract: { script: contractScript },
  timestamp: 1,
})

/**
 * A source whose manager fails `failures` times before it can be had.
 *
 * `sleep` is injected and returns immediately, recording what the backoff WOULD
 * have been: the schedule is worth asserting, waiting it out is not.
 */
const build = (failures: number, over: { maxRetryMs?: number } = {}) => {
  const manager = new FakeManager()
  const waits: number[] = []
  const errors: { error: unknown; retryInMs: number }[] = []
  let attempts = 0
  const source = lazyContractSource({
    getContractManager: async () => {
      attempts += 1
      if (attempts <= failures) throw new Error(`indexer down (${attempts})`)
      return manager
    },
    onError: (error, retryInMs) => errors.push({ error, retryInMs }),
    // Recorded, not waited out — but still a real turn of the event loop, or
    // a retry loop would starve the timers the assertions run on.
    sleep: async (ms) => {
      waits.push(ms)
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    ...over,
  })
  return { manager, source, waits, errors, attempts: () => attempts }
}

describe('lazyContractSource — attaching', () => {
  it('resolves the manager on first use, not before', async () => {
    const { manager, source } = build(0)
    // Building it touches nothing: the money path must not wait on this.
    expect(manager.listeners).toHaveLength(0)
    const events: string[] = []
    source.onContractEvent((event) => {
      if (event.type !== 'connection_reset') events.push(event.contractScript)
    })
    await vi.waitFor(() => expect(manager.listeners).toHaveLength(1))
    manager.emit(arrival('aa'))
    expect(events).toEqual(['aa'])
  })

  it('keeps trying until the manager can be had', async () => {
    // The regression. One transient failure at boot used to mean no fast path
    // at all until someone noticed the latency and restarted the daemon.
    const { manager, source, errors, attempts } = build(2)
    source.onContractEvent(() => {})
    await vi.waitFor(() => expect(manager.listeners).toHaveLength(1))
    expect(attempts()).toBe(3)
    expect(errors).toHaveLength(2)
  })

  it('doubles the wait, and stops doubling at the ceiling', async () => {
    // The thing that failed is the indexer reconciliation, so a tight retry
    // hammers a service that is already struggling.
    const { manager, source, waits } = build(5, { maxRetryMs: 4000 })
    source.onContractEvent(() => {})
    await vi.waitFor(() => expect(manager.listeners).toHaveLength(1))
    expect(waits).toEqual([1000, 2000, 4000, 4000, 4000])
  })

  it('reports every failed attempt, with when it will try again', async () => {
    const { manager, source, errors } = build(1)
    source.onContractEvent(() => {})
    await vi.waitFor(() => expect(manager.listeners).toHaveLength(1))
    expect(errors[0]?.retryInMs).toBe(1000)
    expect((errors[0]?.error as Error).message).toBe('indexer down (1)')
  })
})

describe('lazyContractSource — letting go', () => {
  it('detaches the listener it attached', async () => {
    const { manager, source } = build(0)
    const unsubscribe = source.onContractEvent(() => {})
    await vi.waitFor(() => expect(manager.listeners).toHaveLength(1))
    unsubscribe()
    expect(manager.unsubscribes).toBe(1)
    expect(manager.listeners).toHaveLength(0)
  })

  it('never attaches when it is cancelled while the manager is still resolving', async () => {
    // The race the `cancelled` flag exists for: an unsubscribe arriving before
    // there is anything to unsubscribe. Registering the listener afterwards
    // would leave a stopped watcher receiving events forever.
    const manager = new FakeManager()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const source = lazyContractSource({
      getContractManager: async () => {
        await gate
        return manager
      },
      onError: () => {},
    })
    const unsubscribe = source.onContractEvent(() => {})
    unsubscribe()
    release?.()
    await vi.waitFor(() => expect(manager.listeners).toHaveLength(0))
    expect(manager.unsubscribes).toBe(0)
  })

  it('stops retrying once it is cancelled', async () => {
    // Otherwise a stopped daemon keeps a retry loop alive against an indexer
    // nothing is waiting on any more.
    const manager = new FakeManager()
    let attempts = 0
    const source = lazyContractSource({
      getContractManager: async () => {
        attempts += 1
        throw new Error('indexer down')
      },
      onError: () => {},
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
    })
    const unsubscribe = source.onContractEvent(() => {})
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(1))
    unsubscribe()
    const stopped = attempts
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(attempts).toBe(stopped)
    expect(manager.listeners).toHaveLength(0)
  })
})

describe('lazyContractSource — the coverage read', () => {
  it('asks the manager every time, so a late-arriving one is still used', async () => {
    const { manager, source } = build(0)
    manager.contracts = [{ script: 'aa' }]
    expect(await source.getContracts()).toEqual([{ script: 'aa' }])
    manager.contracts = [{ script: 'aa' }, { script: 'bb' }]
    expect(await source.getContracts()).toEqual([{ script: 'aa' }, { script: 'bb' }])
  })

  it('rejects rather than retrying, because its caller already treats it as diagnostics', async () => {
    // `LockupWatcher.checkCoverage` catches this and reports it. Retrying here
    // would hold that read open across sweeps for a diagnostic.
    const source = lazyContractSource({
      getContractManager: async () => {
        throw new Error('repository closed')
      },
      onError: () => {},
    })
    await expect(source.getContracts()).rejects.toThrow('repository closed')
  })
})
