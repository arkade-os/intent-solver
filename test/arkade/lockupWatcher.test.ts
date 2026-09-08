/**
 * Funding detection over the SDK's contract stream.
 *
 * The coverage-gap suite this file used to carry is gone with the gap: watching
 * a lockup no longer depends on a separate pass having registered it.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  LockupWatcher,
  type ContractEvent,
  type ContractSource,
} from '@arkade-os/solver-arkade/arkade/lockupWatcher.js'

/** A stand-in for `ContractManager`, narrowed to what the watcher uses. */
class FakeContracts implements ContractSource {
  listeners: ((event: ContractEvent) => void)[] = []
  unsubscribes = 0
  watchCalls: string[] = []
  unwatchCalls: string[] = []
  failNextWatch: Error | null = null
  private gate: Promise<void> | null = null
  private openGate: (() => void) | null = null

  onContractEvent(callback: (event: ContractEvent) => void): () => void {
    this.listeners.push(callback)
    return () => {
      this.unsubscribes += 1
      this.listeners = this.listeners.filter((l) => l !== callback)
    }
  }

  async watchScript(script: string): Promise<void> {
    this.watchCalls.push(script)
    const failure = this.failNextWatch
    if (failure) {
      this.failNextWatch = null
      throw failure
    }
    if (this.gate) await this.gate
  }

  async unwatchScript(script: string): Promise<void> {
    this.unwatchCalls.push(script)
  }

  /** Hold every watch call open — a manager answering nothing. */
  hold(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve
    })
  }

  release(): void {
    this.gate = null
    this.openGate?.()
    this.openGate = null
  }

  emit(event: ContractEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

/** The two event members that name a script; spreading the union does not narrow. */
type ScriptEvent = Extract<ContractEvent, { contractScript: string }>

/** Built with the SDK's extra fields, so what the watcher declines to read is exercised. */
const event = (type: ScriptEvent['type'], contractScript: string, vtxos: unknown[] = []): ScriptEvent =>
  ({ type, contractScript, vtxos, contract: { script: contractScript }, timestamp: 1 }) as ScriptEvent

/** A watch-only arrival: the #857 shape, carrying no `contract` at all. */
const watchOnly = (contractScript: string, vtxos: unknown[] = []): ScriptEvent =>
  ({ type: 'vtxo_received', contractScript, vtxos, timestamp: 1 }) as ScriptEvent

const received = (contractScript: string): ScriptEvent => event('vtxo_received', contractScript)

const build = (over: Partial<ConstructorParameters<typeof LockupWatcher>[0]> = {}) => {
  const contracts = new FakeContracts()
  const onScripts = vi.fn()
  const onError = vi.fn()
  const watcher = new LockupWatcher({ contracts, onScripts, onError, ...over })
  return { contracts, onScripts, onError, watcher }
}

describe('LockupWatcher — events into nudges', () => {
  it('nudges the swap whose script an arrival names', () => {
    const { contracts, onScripts, watcher } = build()
    watcher.start()
    watcher.sync(['aa'])
    contracts.emit(received('aa'))
    expect(onScripts).toHaveBeenCalledWith(['aa'])
  })

  it('nudges on a SPEND too, not only an arrival', () => {
    const { contracts, onScripts, watcher } = build()
    watcher.start()
    watcher.sync(['aa'])
    contracts.emit(event('vtxo_spent', 'aa'))
    expect(onScripts).toHaveBeenCalledWith(['aa'])
  })

  it('nudges on a watch-only event, which carries no contract', () => {
    const { contracts, onScripts, watcher } = build()
    watcher.start()
    watcher.sync(['aa'])
    contracts.emit(watchOnly('aa'))
    expect(onScripts).toHaveBeenCalledWith(['aa'])
  })

  it('ignores a script no swap is waiting on', () => {
    // The manager also watches offer scripts, which are not ours to tick.
    const { contracts, onScripts, watcher } = build()
    watcher.start()
    watcher.sync(['aa'])
    contracts.emit(received('zz'))
    expect(onScripts).not.toHaveBeenCalled()
  })

  it('nudges EVERY watched swap when the connection resets', () => {
    const { contracts, onScripts, watcher } = build()
    watcher.start()
    watcher.sync(['aa', 'bb'])
    contracts.emit({ type: 'connection_reset', timestamp: 2 })
    expect(onScripts).toHaveBeenCalledWith(['aa', 'bb'])
  })

  it('does not nudge on a reset when nothing is watched', () => {
    const { contracts, onScripts, watcher } = build()
    watcher.start()
    contracts.emit({ type: 'connection_reset', timestamp: 2 })
    expect(onScripts).not.toHaveBeenCalled()
  })

  it('passes scripts and nothing else, so an event can never be believed', () => {
    const { contracts, onScripts, watcher } = build()
    watcher.start()
    watcher.sync(['aa'])
    contracts.emit(event('vtxo_received', 'aa', [{ txid: 'deadbeef', vout: 0, value: 999 }]))
    expect(onScripts).toHaveBeenCalledWith(['aa'])
    expect(onScripts.mock.calls[0]?.[0]).toEqual(['aa'])
  })

  it('passes nothing but scripts from a watch-only event either', () => {
    const { contracts, onScripts, watcher } = build()
    watcher.start()
    watcher.sync(['aa'])
    contracts.emit(watchOnly('aa', [{ txid: 'deadbeef', vout: 0, value: 999 }]))
    expect(onScripts.mock.calls[0]?.[0]).toEqual(['aa'])
  })

  it('survives a caller that throws, because the next event still matters', () => {
    const { contracts, onScripts, onError, watcher } = build()
    onScripts.mockImplementationOnce(() => {
      throw new Error('tick blew up')
    })
    watcher.start()
    watcher.sync(['aa'])
    expect(() => contracts.emit(received('aa'))).not.toThrow()
    expect(onError).toHaveBeenCalled()
    contracts.emit(received('aa'))
    expect(onScripts).toHaveBeenCalledTimes(2)
  })
})

describe('LockupWatcher — asking is watching', () => {
  it('asks the manager to watch every script the sweep names', async () => {
    const { contracts, watcher } = build()
    watcher.sync(['aa', 'bb'])
    await watcher.reconcile()
    expect(contracts.watchCalls).toEqual(['aa', 'bb'])
  })

  it('does not re-ask for a script it has already watched', async () => {
    const { contracts, watcher } = build()
    watcher.sync(['aa'])
    await watcher.reconcile()
    watcher.sync(['aa'])
    await watcher.reconcile()
    expect(contracts.watchCalls).toEqual(['aa'])
  })

  it('unwatches a script the sweep has dropped', async () => {
    const { contracts, watcher } = build()
    watcher.sync(['aa', 'bb'])
    await watcher.reconcile()
    watcher.sync(['aa'])
    await watcher.reconcile()
    expect(contracts.unwatchCalls).toEqual(['bb'])
  })

  it('re-asks for a script that comes back after being dropped', async () => {
    const { contracts, watcher } = build()
    watcher.sync(['aa'])
    await watcher.reconcile()
    watcher.sync([])
    await watcher.reconcile()
    watcher.sync(['aa'])
    await watcher.reconcile()
    expect(contracts.watchCalls).toEqual(['aa', 'aa'])
  })

  it('reports a failed watch and retries it on the next sweep', async () => {
    const { contracts, onError, watcher } = build()
    contracts.failNextWatch = new Error('manager unavailable')
    watcher.sync(['aa'])
    await watcher.reconcile()
    expect(onError).toHaveBeenCalled()
    watcher.sync(['aa'])
    await watcher.reconcile()
    expect(contracts.watchCalls).toEqual(['aa', 'aa'])
  })

  it('does not make the sweep wait for a manager that never answers', () => {
    const { contracts, onScripts, watcher } = build()
    contracts.hold()
    watcher.start()
    watcher.sync(['aa'])
    // Nothing was awaited, and the stream is live while the watch call hangs.
    contracts.emit(received('aa'))
    expect(onScripts).toHaveBeenCalledWith(['aa'])
    contracts.release()
  })

  it('does not stack a reconcile per sweep while one is in flight', async () => {
    const { contracts, watcher } = build()
    contracts.hold()
    watcher.sync(['aa'])
    watcher.sync(['aa'])
    watcher.sync(['aa'])
    expect(contracts.watchCalls).toEqual(['aa'])
    contracts.release()
    await watcher.reconcile()
  })

  it('keeps delivering events when the watch call fails', async () => {
    const { contracts, onScripts, onError, watcher } = build()
    contracts.failNextWatch = new Error('repository closed')
    watcher.start()
    watcher.sync(['aa'])
    await watcher.reconcile()
    expect(onError).toHaveBeenCalled()
    contracts.emit(received('aa'))
    expect(onScripts).toHaveBeenCalledWith(['aa'])
  })
})

describe('LockupWatcher — lifecycle', () => {
  it('subscribes once however many times it is started', () => {
    const { contracts, watcher } = build()
    watcher.start()
    watcher.start()
    expect(contracts.listeners).toHaveLength(1)
  })

  it('unsubscribes on stop, and is safe to stop twice', async () => {
    const { contracts, watcher } = build()
    watcher.start()
    await watcher.stop()
    await watcher.stop()
    expect(contracts.unsubscribes).toBe(1)
    expect(contracts.listeners).toHaveLength(0)
  })

  it('delivers nothing after stop', async () => {
    const { contracts, onScripts, watcher } = build()
    watcher.start()
    watcher.sync(['aa'])
    await watcher.stop()
    contracts.emit(received('aa'))
    expect(onScripts).not.toHaveBeenCalled()
  })

  it('can be started again after stopping', async () => {
    const { contracts, onScripts, watcher } = build()
    watcher.start()
    watcher.sync(['aa'])
    await watcher.stop()
    watcher.start()
    contracts.emit(received('aa'))
    expect(onScripts).toHaveBeenCalledWith(['aa'])
  })

  it('tolerates sync before start, so the sweep never has to order them', () => {
    const { contracts, onScripts, watcher } = build()
    watcher.sync(['aa'])
    watcher.start()
    contracts.emit(received('aa'))
    expect(onScripts).toHaveBeenCalledWith(['aa'])
  })
})
