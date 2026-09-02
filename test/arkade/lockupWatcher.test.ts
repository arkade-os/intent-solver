/**
 * Funding detection over the SDK's contract stream.
 *
 * This class used to hold its own indexer subscription — subscribe, stream,
 * reconnect, back off — on the stated grounds that the SDK's `ContractWatcher`
 * could not work for a swap lockup. That was true when written and stopped
 * being true a day later, when `registerLiveLockups` began registering every
 * live lockup as a contract. The SDK's watcher has been running in this process
 * ever since (`getContractManager()` -> `create` -> `initialize` ->
 * `startWatching`), so the hand-rolled stream was a SECOND subscription over
 * the same scripts.
 *
 * The twelve tests this file replaces covered that machinery: posting the
 * script set, extending a subscription, recreating a forgotten one, reconnect
 * backoff, aborting cleanly. None of it exists any more — the SDK owns it —
 * so they are gone rather than adapted. What replaces them is the behaviour
 * that is now ours to get right: which events become a nudge, what a connection
 * reset means, and the coverage gap being loud instead of silent.
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
  registered: string[] = []
  /** Registered but `watch: 'retained'`: off the stream, and the coverage read must say so. */
  retained: string[] = []
  failNextGetContracts: Error | null = null
  /** How many times the coverage read has actually asked. */
  reads = 0
  /** The filter the last coverage read passed, so the narrowing is asserted rather than assumed. */
  lastFilter?: { watch?: ('watched' | 'retained')[] }
  /** Set while {@link hold} is in force; every read waits on it. */
  private gate: Promise<void> | null = null
  private openGate: (() => void) | null = null

  onContractEvent(callback: (event: ContractEvent) => void): () => void {
    this.listeners.push(callback)
    return () => {
      this.unsubscribes += 1
      this.listeners = this.listeners.filter((l) => l !== callback)
    }
  }

  async getContracts(filter?: { watch?: ('watched' | 'retained')[] }): Promise<{ script: string }[]> {
    this.reads += 1
    this.lastFilter = filter
    const failure = this.failNextGetContracts
    if (failure) {
      this.failNextGetContracts = null
      throw failure
    }
    if (this.gate) await this.gate
    const scripts = filter === undefined ? [...this.registered, ...this.retained] : this.registered
    return scripts.map((script) => ({ script }))
  }

  /** Hold every read open — a manager mid-reconciliation, answering nothing. */
  hold(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve
    })
  }

  /** Let the held reads answer, and stop holding the next one. */
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

const event = (type: ScriptEvent['type'], contractScript: string, vtxos: unknown[] = []): ScriptEvent => ({
  type,
  contractScript,
  vtxos,
  contract: { script: contractScript },
  timestamp: 1,
})

const received = (contractScript: string): ScriptEvent => event('vtxo_received', contractScript)

const build = (over: Partial<ConstructorParameters<typeof LockupWatcher>[0]> = {}) => {
  const contracts = new FakeContracts()
  const onScripts = vi.fn()
  const onError = vi.fn()
  const onUnwatched = vi.fn()
  const watcher = new LockupWatcher({ contracts, onScripts, onError, onUnwatched, ...over })
  return { contracts, onScripts, onError, onUnwatched, watcher }
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
    // A spend of our lockup is the client claiming or refunding it. That moves
    // the swap just as much as the funding did, and waiting for the sweep to
    // notice is the latency this class exists to remove.
    const { contracts, onScripts, watcher } = build()
    watcher.start()
    watcher.sync(['aa'])
    contracts.emit(event('vtxo_spent', 'aa'))
    expect(onScripts).toHaveBeenCalledWith(['aa'])
  })

  it('ignores a script no swap is waiting on', () => {
    // The manager watches every registered contract in the wallet, including
    // the offer scripts `offerDeposit` registers. Passing those through would
    // wake the caller for something that is not a swap at all.
    const { contracts, onScripts, watcher } = build()
    watcher.start()
    watcher.sync(['aa'])
    contracts.emit(received('zz'))
    expect(onScripts).not.toHaveBeenCalled()
  })

  it('nudges EVERY watched swap when the connection resets', () => {
    // `connection_reset` carries no script, and that is the point: it says the
    // stream was down, so an arrival during the gap was never delivered.
    // Nudging nothing would leave those swaps to the sweep with no sign that
    // the fast path had missed them.
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
    // The property the whole design rests on. The SDK's events carry virtual
    // outputs; handing those to the caller is what would turn a stream outage
    // into a correctness bug instead of a latency one.
    const { contracts, onScripts, watcher } = build()
    watcher.start()
    watcher.sync(['aa'])
    contracts.emit(event('vtxo_received', 'aa', [{ txid: 'deadbeef', vout: 0, value: 999 }]))
    expect(onScripts).toHaveBeenCalledWith(['aa'])
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

describe('LockupWatcher — the coverage gap, out loud', () => {
  it('reports a watched script the manager has no contract for', async () => {
    // Registration is a separate pass, so a script can be watched before — or
    // without ever — becoming a contract, and this stream can only mention the
    // ones that are. Silently watching less than asked is the one failure this
    // migration could introduce, so it is reported rather than shrugged off.
    const { contracts, onUnwatched, watcher } = build()
    contracts.registered = ['aa']
    watcher.start()
    watcher.sync(['aa', 'bb'])
    await watcher.checkCoverage()
    watcher.sync(['aa', 'bb'])
    await watcher.checkCoverage()
    expect(onUnwatched).toHaveBeenCalledWith(['bb'])
  })

  it('says nothing about a lockup the sweep has only just adopted', async () => {
    // The regression this guards. The sweep adopts a script and registers it
    // as a contract on the SAME pass, so the coverage read routinely lands in
    // between — and a report on first sighting would print this line for every
    // swap the service quotes, which is how a log stops being read.
    const { contracts, onUnwatched, watcher } = build()
    watcher.start()
    watcher.sync(['aa'])
    await watcher.checkCoverage()
    expect(onUnwatched).not.toHaveBeenCalled()
    // Registration lands, as it does within the same sweep in `cli.ts`.
    contracts.registered = ['aa']
    watcher.sync(['aa'])
    await watcher.checkCoverage()
    expect(onUnwatched).not.toHaveBeenCalled()
  })

  it('says nothing when every watched script is registered', async () => {
    const { contracts, onUnwatched, watcher } = build()
    contracts.registered = ['aa', 'bb']
    watcher.start()
    watcher.sync(['aa', 'bb'])
    await watcher.checkCoverage()
    expect(onUnwatched).not.toHaveBeenCalled()
  })

  /**
   * A contract retired to `watch: 'retained'` is OUT of the subscription and
   * the failsafe poll — `getWatchedContracts()` filters on it — but the
   * unfiltered coverage read still answered it as known, so the two states
   * this alarm most needs to distinguish (registered-and-watched versus
   * registered-and-retained) were indistinguishable to it, and the retained
   * one was silent by construction. The read is narrowed to watched rows, so
   * a retained contract is reported uncovered like any other.
   */
  it('reports a contract the lifecycle has retained as uncovered', async () => {
    const { contracts, onUnwatched, watcher } = build()
    contracts.registered = ['aa']
    contracts.retained = ['bb']
    watcher.start()
    watcher.sync(['aa', 'bb'])
    await watcher.checkCoverage()
    watcher.sync(['aa', 'bb'])
    await watcher.checkCoverage()
    expect(contracts.lastFilter).toEqual({ watch: ['watched'] })
    expect(onUnwatched).toHaveBeenLastCalledWith(['bb'])
  })

  it('does not repeat itself for a gap it has already reported', async () => {
    // The sweep calls `sync` every few seconds. A gap that logged on each pass
    // would bury the log the way the last incident's did.
    //
    // Each read is awaited before the next sweep, so this is the suppression
    // being tested and not the in-flight join below standing in for it.
    const { contracts, onUnwatched, watcher } = build()
    contracts.registered = ['aa']
    watcher.start()
    watcher.sync(['aa', 'bb'])
    await watcher.checkCoverage()
    watcher.sync(['aa', 'bb'])
    await watcher.checkCoverage()
    watcher.sync(['aa', 'bb'])
    await watcher.checkCoverage()
    expect(contracts.reads).toBe(3)
    expect(onUnwatched).toHaveBeenCalledTimes(1)
  })

  it('reports again once a NEW script turns up uncovered', async () => {
    const { contracts, onUnwatched, watcher } = build()
    contracts.registered = ['aa']
    watcher.start()
    watcher.sync(['aa', 'bb'])
    await watcher.checkCoverage()
    watcher.sync(['aa', 'bb', 'cc'])
    await watcher.checkCoverage()
    watcher.sync(['aa', 'bb', 'cc'])
    await watcher.checkCoverage()
    expect(onUnwatched).toHaveBeenLastCalledWith(['cc'])
  })

  it('does not make the caller wait for a manager that never answers', async () => {
    // The reason `sync` returns nothing to await. It runs on the sweep, in the
    // same loop as the hot tick, and `getContracts()` reaches
    // `getContractManager()` — an indexer reconciliation with no timeout. A
    // diagnostic that can hold that loop open is worse than no diagnostic.
    const { contracts, onScripts, watcher } = build()
    contracts.registered = ['aa']
    contracts.hold()
    watcher.start()
    watcher.sync(['aa'])
    // Nothing was awaited, and the stream is live while the read hangs.
    contracts.emit(received('aa'))
    expect(onScripts).toHaveBeenCalledWith(['aa'])
    contracts.release()
    await watcher.checkCoverage()
  })

  it('joins the read in flight rather than starting one per sweep', async () => {
    // A wedged manager costs ONE pending read for as long as it stays wedged.
    // Without this, a sweep every three seconds would stack a read every three
    // seconds, each holding its own reference to a connection going nowhere.
    const { contracts, watcher } = build()
    contracts.registered = ['aa']
    contracts.hold()
    watcher.start()
    watcher.sync(['aa', 'bb'])
    watcher.sync(['aa', 'bb'])
    watcher.sync(['aa', 'bb'])
    expect(contracts.reads).toBe(1)
    contracts.release()
    await watcher.checkCoverage()
    expect(contracts.reads).toBe(1)
  })

  it('judges a late answer against the set that is current when it lands', async () => {
    // The read resolves against `watched` at ARRIVAL, not at call time. A swap
    // the sweep retired while the manager was thinking must not be reported as
    // uncovered — it is not watched any more.
    const { contracts, onUnwatched, watcher } = build()
    contracts.registered = ['aa']
    watcher.start()
    // 'bb' uncovered once, so the next read is the one that would report it.
    watcher.sync(['aa', 'bb'])
    await watcher.checkCoverage()
    contracts.hold()
    watcher.sync(['aa', 'bb'])
    watcher.sync(['aa'])
    contracts.release()
    await watcher.checkCoverage()
    expect(onUnwatched).not.toHaveBeenCalled()
  })

  it('reports a coverage read that failed, and keeps watching', async () => {
    // The gap check is diagnostics. A manager that cannot answer must not stop
    // events being delivered.
    const { contracts, onScripts, onError, watcher } = build()
    contracts.failNextGetContracts = new Error('repository closed')
    watcher.start()
    watcher.sync(['aa'])
    await watcher.checkCoverage()
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
