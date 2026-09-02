import type { ContractEvent, ContractSource, ContractWatchFilter } from './lockupWatcher.js'

/** The manager as this file uses it — the same slice {@link ContractSource} exposes. */
export interface ContractManagerLike {
  onContractEvent(callback: (event: ContractEvent) => void): () => void
  getContracts(filter?: { watch?: ContractWatchFilter[] }): Promise<{ script: string }[]>
}

export interface LazyContractSourceDeps {
  /**
   * The wallet's own accessor, called on every attempt rather than once.
   *
   * That is deliberate: it is the call that reconciles, so re-calling it is
   * what a retry has to do. The SDK clears its in-flight promise when
   * initialization throws (checked against 0.4.66), so a later call re-runs
   * initialization instead of handing back the failure it already produced.
   */
  getContractManager: () => Promise<ContractManagerLike>
  /** A failed attach, with how long until the next attempt. */
  onError: (error: unknown, retryInMs: number) => void
  /** First retry wait, doubling to {@link maxRetryMs}. */
  retryMs?: number
  maxRetryMs?: number
  /** Overridable so a test is not paced by the real backoff. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_RETRY_MS = 1000
const DEFAULT_MAX_RETRY_MS = 30_000

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A {@link ContractSource} that resolves the contract manager on first use, and
 * keeps trying until it has one.
 *
 * **Lazy, because the manager is not free to obtain.**
 * `getContractManager()` is what starts the SDK's own watcher — `create` ->
 * `initialize` -> `startWatching` — and `initialize` reconciles against the
 * indexer. Awaiting that before the watch loop would let a wedged indexer delay
 * the first tick of the money path, which is the veto the whole design of
 * `LockupWatcher` is built to avoid. The sweep is the failsafe for anything the
 * stream misses in the meantime, so attaching late costs latency and nothing
 * else.
 *
 * **Retrying, because a failure here used to be permanent.**
 * `LockupWatcher.start()` is called once, is idempotent, and stores whatever
 * unsubscribe this returns whether or not anything is attached behind it. So a
 * single transient failure — an indexer down for a moment at boot — disabled
 * the fast path for the lifetime of the process, silently, with the sweep
 * carrying every swap at sweep latency until someone restarted the daemon.
 *
 * The backoff exists because the thing that failed is the indexer
 * reconciliation, so a tight retry loop would hammer a service that is already
 * struggling. The ceiling stays well under the lifecycle cadence so that a
 * recovering stream is never something an operator waits minutes to see come
 * back.
 */
export const lazyContractSource = (deps: LazyContractSourceDeps): ContractSource => {
  const sleep = deps.sleep ?? wait
  const first = deps.retryMs ?? DEFAULT_RETRY_MS
  const ceiling = deps.maxRetryMs ?? DEFAULT_MAX_RETRY_MS
  return {
    onContractEvent: (callback: (event: ContractEvent) => void): (() => void) => {
      let detach: (() => void) | undefined
      let cancelled = false
      const attach = async (): Promise<void> => {
        for (let retryIn = first; !cancelled; retryIn = Math.min(retryIn * 2, ceiling)) {
          try {
            const manager = await deps.getContractManager()
            // Checked AFTER the await: an unsubscribe that arrived while the
            // manager was resolving has nothing to cancel yet, so the only way
            // it can be honoured is for the attach to notice it here.
            if (cancelled) return
            detach = manager.onContractEvent(callback)
            return
          } catch (error) {
            deps.onError(error, retryIn)
            await sleep(retryIn)
          }
        }
      }
      void attach()
      return () => {
        cancelled = true
        detach?.()
      }
    },
    getContracts: async (filter?: { watch?: ContractWatchFilter[] }): Promise<{ script: string }[]> =>
      (await deps.getContractManager()).getContracts(filter),
  }
}
