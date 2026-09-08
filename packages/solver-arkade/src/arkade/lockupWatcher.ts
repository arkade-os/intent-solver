/**
 * Funding detection as a push, with the indexer read still the authority.
 *
 * The sweep finds a lockup by asking the indexer every few seconds, so the mean
 * cost of detecting a funded swap is half that interval — latency the provider
 * pays on every swap for nothing. This turns the SDK's contract stream into the
 * fast path.
 *
 * Scripts reach the stream via `watchScript` (SDK 0.4.71, arkade-os/ts-sdk#857),
 * so watching is implied by asking and nothing reconciles the two.
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
  | { type: 'vtxo_received'; contractScript: string; timestamp: number }
  | { type: 'vtxo_spent'; contractScript: string; timestamp: number }
  | { type: 'connection_reset'; timestamp: number }

/** The slice of the SDK's `ContractManager` this needs, narrowed for injection. */
export interface ContractSource {
  /** Subscribe to contract events. Returns an unsubscribe function. */
  onContractEvent(callback: (event: ContractEvent) => void): () => void
  watchScript(script: string): Promise<void>
  /** Take it off both. The set is re-derived each sweep, so this is reversible. */
  unwatchScript(script: string): Promise<void>
}

export interface LockupWatcherDeps {
  contracts: ContractSource
  /** Called with the scripts an event named. Never awaited; may throw. */
  onScripts: (scripts: string[]) => void
  onError?: (error: unknown) => void
}

export class LockupWatcher {
  private watched: string[] = []
  private unsubscribe?: () => void
  /** Scripts the source confirmed it watches. Only a SUCCESSFUL call lands here. */
  private readonly asked = new Set<string>()
  private reconciling?: Promise<void>

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
   * Record which scripts a swap is waiting on, and put them on the stream.
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
   * the watch calls are fired off and left to land on their own. Awaiting them
   * would put `watchScript()` — and behind it `getContractManager()`, which is
   * `create` -> `initialize` -> an indexer reconciliation with no timeout — on
   * the sweep's critical path, in the same loop as the hot tick. That is the
   * exact veto `arkade/lazyContractSource.ts` exists to avoid.
   */
  sync(scripts: readonly string[]): void {
    this.watched = [...new Set(scripts)].sort()
    void this.reconcile()
  }

  /**
   * Bring the source's watched set in line with this one; never rejects. At most
   * one pass runs at a time; the sets converge, they are never applied as a delta.
   */
  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling
    this.reconciling = this.applyWatched().finally(() => {
      this.reconciling = undefined
    })
    return this.reconciling
  }

  private async applyWatched(): Promise<void> {
    const wanted = new Set(this.watched)
    for (const script of wanted) {
      if (this.asked.has(script)) continue
      try {
        await this.deps.contracts.watchScript(script)
        // Only on success, so a failed call is retried rather than remembered.
        this.asked.add(script)
      } catch (error) {
        this.deps.onError?.(error)
      }
    }
    for (const script of [...this.asked]) {
      if (wanted.has(script)) continue
      try {
        await this.deps.contracts.unwatchScript(script)
        // Dropped only on success, for the same reason: while an unwatch keeps
        // failing the source really is still watching, so the set stays honest.
        this.asked.delete(script)
      } catch (error) {
        this.deps.onError?.(error)
      }
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
