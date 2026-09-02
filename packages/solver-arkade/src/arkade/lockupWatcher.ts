/**
 * Funding detection as a push, with the indexer read still the authority.
 *
 * The sweep finds a lockup by asking the indexer every few seconds, so the mean
 * cost of detecting a funded swap is half that interval — latency the provider
 * pays on every swap for nothing. This turns the SDK's contract stream into the
 * fast path.
 *
 * **It used to hold its own subscription.** The note here said the SDK's
 * `ContractWatcher` could not work for a swap lockup, because its failsafe poll
 * diffs the wallet repository and that repository stays empty for a script this
 * wallet does not own. True on 2026-08-07; false on 2026-08-08, when
 * `registerLiveLockups` began registering every live lockup as a contract, and
 * never revisited. Checked against SDK 0.4.66:
 *
 * - `ContractManager.createContract` calls `fetchContractVxosFromIndexer`, so
 *   registering a lockup hydrates the repository from the indexer.
 * - It then calls `watcher.addContract`, and `getContractManager()` reaches
 *   `create` -> `initialize` -> `watcher.startWatching`.
 *
 * So the SDK's watcher was already running in this process, and the hand-rolled
 * stream here was a SECOND subscription over the same scripts — two connections,
 * two reconnect regimes, and 213 lines of subscribe/backoff to maintain against
 * one upstream copy. This now consumes `onContractEvent` instead.
 *
 * **The one thing that got worse, so it is reported rather than hidden.**
 * This stream can only ever mention a script the manager already holds a
 * contract for, and registering one is a separate, fallible pass
 * (`registerLiveLockups` in `cli.ts`) rather than something watching implies.
 * The old subscription took whatever scripts it was given.
 * {@link LockupWatcher.sync} therefore compares what it was asked to watch
 * against what the manager actually holds and reports the difference — silently
 * watching less than asked is the only way this migration could cost a swap its
 * fast path, and an operator should hear about it rather than infer it from a
 * latency graph.
 *
 * The gap used to have one named cause: the base three-leaf program, which
 * `lockupContractRegistration` refused to register because no handler could
 * re-derive it. That program is gone. What is left is a registration that has
 * not run yet, or one that failed.
 *
 * **This is deliberately not a source of truth.** An event names scripts and
 * nothing more; the caller reacts by ticking the matching swap, which re-reads
 * the lockup through `findLockups` exactly as the sweep does. So a missed,
 * duplicated, reordered or outright forged event can only cost or save latency —
 * it can never change what the money path believes about a lockup. That property
 * matters more now, not less: the SDK's events carry virtual outputs, and this
 * class drops them on the floor on purpose. The moment one is *believed* rather
 * than merely acted on, a stream outage becomes a correctness problem.
 */

/**
 * The SDK's contract event, narrowed to what this reads.
 *
 * `connection_reset` carries no script, and that is the whole reason it is
 * handled separately: it means the stream was down, so an arrival during the
 * gap was never delivered.
 */
export type ContractEvent =
  | { type: 'vtxo_received'; contractScript: string; vtxos: unknown[]; contract: unknown; timestamp: number }
  | { type: 'vtxo_spent'; contractScript: string; vtxos: unknown[]; contract: unknown; timestamp: number }
  | { type: 'connection_reset'; timestamp: number }

/** The `watch` values a coverage read can ask for. Mirrors the SDK's `ContractWatchState`. */
export type ContractWatchFilter = 'watched' | 'retained'

/** The slice of the SDK's `ContractManager` this needs, narrowed for injection. */
export interface ContractSource {
  /** Subscribe to contract events. Returns an unsubscribe function. */
  onContractEvent(callback: (event: ContractEvent) => void): () => void
  /**
   * The contracts the manager holds, for the coverage check in `sync`. The
   * filter narrows the read to contracts still ON the stream — a row disabled
   * to `watch: 'retained'` is out of the subscription and the failsafe poll,
   * and a coverage check that cannot see that reports the two states this
   * alarm most needs to distinguish as identical.
   */
  getContracts(filter?: { watch?: ContractWatchFilter[] }): Promise<{ script: string }[]>
}

export interface LockupWatcherDeps {
  contracts: ContractSource
  /** Called with the scripts an event named. Never awaited; may throw. */
  onScripts: (scripts: string[]) => void
  /** Stream and coverage-read failures, for the host's log. */
  onError?: (error: unknown) => void
  /**
   * Watched scripts the manager has no contract for, so they can never arrive
   * on this stream. Reported once per script; see
   * {@link LockupWatcher.checkCoverage}.
   */
  onUnwatched?: (scripts: string[]) => void
}

export class LockupWatcher {
  private watched: string[] = []
  private unsubscribe?: () => void
  /** Scripts already reported as uncovered, so a per-sweep `sync` cannot spam. */
  private readonly reportedUnwatched = new Set<string>()
  /** The coverage read in flight, if any. @see {@link LockupWatcher.checkCoverage} */
  private coverage?: Promise<void>
  /**
   * Scripts the LAST completed read found uncovered.
   *
   * A single sighting is not evidence. The sweep adopts a lockup and registers
   * it as a contract on the same pass, so a read can easily land in the gap
   * between the two and see a script that is about to be covered. Reporting
   * that would print a warning for every swap this service ever quotes, which
   * is how a log stops being read.
   */
  private seenUncovered = new Set<string>()

  constructor(private readonly deps: LockupWatcherDeps) {}

  /**
   * True between {@link start} and {@link stop}. Diagnostics only.
   *
   * Says nothing about whether the source behind it has actually attached: with
   * a lazy source (`arkade/lazyContractSource.ts`) that resolves the manager on
   * first use, this is true from the moment `start()` returns while the attach
   * is still in flight, or retrying.
   */
  isSubscribed(): boolean {
    return this.unsubscribe !== undefined
  }

  /**
   * Record which scripts a swap is waiting on, and check the manager can see
   * them.
   *
   * Called from the sweep with every live swap's script, so the watched set
   * follows the swap table without anything having to notify this class when a
   * swap is quoted or ends.
   *
   * The set is used for two things: filtering events down to swaps (the manager
   * also watches offer scripts, which are not ours to tick), and knowing what
   * to nudge when the connection resets.
   *
   * **There is nothing here to await, and that is the point.** The watched set
   * is assigned synchronously, because that is the half the money path needs;
   * the coverage check is fired off and left to land on its own. Awaiting it
   * would put `getContracts()` — and behind it `getContractManager()`, which is
   * `create` -> `initialize` -> an indexer reconciliation with no timeout — on
   * the sweep's critical path, in the same loop as the hot tick. That is the
   * exact veto `arkade/lazyContractSource.ts` exists to avoid, and a diagnostic
   * has no business being the thing that reintroduces it.
   *
   * @see {@link LockupWatcher.checkCoverage} to await the check deliberately.
   */
  sync(scripts: readonly string[]): void {
    this.watched = [...new Set(scripts)].sort()
    void this.checkCoverage()
  }

  /**
   * Compare the watched set against the contracts the manager holds, and report
   * the ones it cannot see. Resolves when that read lands; never rejects.
   *
   * At most one read is ever outstanding: a call made while one is in flight
   * joins it rather than starting a second. A manager that has stopped
   * answering therefore costs one pending promise for as long as it stays
   * wedged, not one more per three-second sweep.
   *
   * The comparison reads `watched` when the answer ARRIVES, not when the read
   * was started, so a slow answer is judged against the set that is current by
   * the time it lands rather than one the sweep has already replaced.
   *
   * Public because {@link sync} deliberately does not await it: this is the
   * seam for a caller — or a test — that wants the diagnostic on purpose.
   */
  checkCoverage(): Promise<void> {
    if (this.coverage) return this.coverage
    this.coverage = this.readCoverage().finally(() => {
      this.coverage = undefined
    })
    return this.coverage
  }

  private async readCoverage(): Promise<void> {
    try {
      // Watched rows only: a contract retired to `watch: 'retained'` really is
      // out of the subscription and the failsafe poll, and the unfiltered read
      // still answered it as covered — silent by construction in exactly the
      // state this alarm exists to name. Rows predating the field match
      // 'watched' (SDK ContractFilter), so nothing old falls out of view.
      const known = new Set((await this.deps.contracts.getContracts({ watch: ['watched'] })).map((c) => c.script))
      const uncovered = this.watched.filter((s) => !known.has(s))
      // Two consecutive reads, so a lockup that is merely mid-registration is
      // not announced as one that will never arrive. @see seenUncovered
      const missing = uncovered.filter((s) => this.seenUncovered.has(s) && !this.reportedUnwatched.has(s))
      this.seenUncovered = new Set(uncovered)
      if (missing.length > 0) {
        for (const script of missing) this.reportedUnwatched.add(script)
        this.deps.onUnwatched?.(missing)
      }
      // Forget scripts that are no longer watched, so a swap re-quoted at the
      // same script reports again rather than being suppressed forever.
      for (const script of this.reportedUnwatched) {
        if (!this.watched.includes(script)) this.reportedUnwatched.delete(script)
      }
    } catch (error) {
      // Diagnostics only: a manager that cannot answer must not stop events
      // being delivered, and the sweep is the failsafe either way.
      this.deps.onError?.(error)
    }
  }

  /** Begin listening. Idempotent; safe to call before any script is watched. */
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.deps.contracts.onContractEvent((event) => this.handle(event))
  }

  /** Stop listening. Safe to call twice. */
  async stop(): Promise<void> {
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    unsubscribe?.()
  }

  private handle(event: ContractEvent): void {
    // A reset says the stream was down, not that a particular script moved.
    // Every watched swap is nudged, because any of them could have been funded
    // while nothing was listening.
    const scripts =
      event.type === 'connection_reset'
        ? [...this.watched]
        : this.watched.includes(event.contractScript)
          ? [event.contractScript]
          : []
    if (scripts.length === 0) return
    try {
      // Scripts only. The event's `vtxos` are deliberately not passed on.
      this.deps.onScripts(scripts)
    } catch (error) {
      // A throwing caller must not tear down the listener: the next event is
      // for a different swap, and losing the stream costs every one of them.
      this.deps.onError?.(error)
    }
  }
}
