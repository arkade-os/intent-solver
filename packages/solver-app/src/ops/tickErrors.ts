/**
 * What to do when the same swap fails the same way over and over.
 *
 * The hot loop ticks at 250ms, which is right for a preimage landing in under a second
 * and wrong for a swap whose every tick throws: it re-asks a question whose answer has
 * not changed, 3.5 times a second, and logs it each time. Observed on mainnet as 98
 * lines in 28s of an unreachable-backend error, and 96 lines in 36s of a DETERMINISTIC
 * fee-estimate refusal that could not have changed between ticks.
 *
 * So: back the swap off, and collapse the log. Both keyed on the error's SIGNATURE as
 * well as the swap, because a swap whose failure CHANGES is making progress of a kind
 * and should be reported immediately — see {@link signatureOf} for why raw text does
 * not work.
 */

/**
 * Context keys whose value differs on every attempt, and so must not make one failure
 * look like a new one.
 *
 * `serverTraceId` is the one that mattered: a backend SDK that appends request context
 * to every error makes two identical faults a quarter-second apart differ in that
 * field alone. Keying on raw text therefore reset the backoff on EVERY attempt and let
 * one swap retry on mainnet for six days at roughly a call a second.
 *
 * Matched by key NAME rather than value shape: a hex-run rule would also swallow
 * payment hashes and amounts, which are exactly what should distinguish two faults.
 */
const VOLATILE_CONTEXT_KEYS = ['serverTraceId', 'traceId', 'requestId', 'correlationId']

/**
 * The part of a message that identifies the FAULT, with per-attempt metadata blanked.
 *
 * Only ever compared, never shown: the log keeps the original text, because an operator
 * matching a line against a backend's own traces needs the real id.
 */
export const signatureOf = (message: string): string => {
  let out = message
  for (const key of VOLATILE_CONTEXT_KEYS) {
    const marker = `${key}:`
    const blanked = `${marker} <volatile>`
    for (let at = out.indexOf(marker); at !== -1; at = out.indexOf(marker, at + blanked.length)) {
      // The value runs to the next context separator: these ids sit in a `[k: v, k: v]`
      // block, so a comma or the closing bracket ends it.
      let stop = at + marker.length
      while (stop < out.length && out[stop] !== ',' && out[stop] !== ']') stop += 1
      out = out.slice(0, at) + blanked + out.slice(stop)
    }
  }
  return out
}

/** Doubling from a quarter-second, capped where a human would notice anyway. */
const FIRST_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 60_000

/**
 * How long after its last failure a swap stops counting as failing.
 *
 * Comfortably clear of {@link MAX_BACKOFF_MS}, so nothing live is pruned. What goes is
 * the entry for a swap that stopped being ticked at all — terminal, or parked in
 * `stuck` — which no `onTickSuccess` will ever clear. Without it the Map leaks, and the
 * `failing` panel fills with resolved swaps until its reader learns to ignore it.
 */
const STALE_AFTER_MS = 5 * 60_000

/**
 * Cap on the error text the console carries, per swap. SDK errors routinely carry
 * serialised request and response bodies, and `failing` ships on EVERY overview load.
 * The discriminating part of a message is its start; the full text is in the log.
 */
const DISPLAY_CHARS = 200

interface Failure {
  /** The message we are counting repeats OF, as logged — carries the real ids. */
  message: string
  /** {@link signatureOf} of that message: what "a different failure" is judged on. */
  signature: string
  count: number
  /** Wall-clock ms after which this swap may be ticked again. */
  nextAttemptAt: number
  backoffMs: number
  /** Repeats since the last line we actually printed. */
  sinceReported: number
  /** When this swap last failed, for {@link STALE_AFTER_MS}. */
  lastFailureAt: number
}

export interface TickErrorReport {
  /** The line to log, or null when this repeat is being collapsed. */
  line: string | null
  /** How long this swap is being held off for, for callers that want to say so. */
  backoffMs: number
}

/**
 * Per-swap failure state. One instance per process, shared by every corridor: the
 * backoff is about not hammering a BACKEND, and the corridors share those.
 */
export class TickErrorTracker {
  private readonly failures = new Map<string, Failure>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Record a failure and decide what to say about it. Reports the first occurrence,
   * then thins out: every doubling of the backoff prints one line carrying the count
   * since the last.
   */
  record(id: string, error: unknown): TickErrorReport {
    const message = error instanceof Error ? error.message : String(error)
    const signature = signatureOf(message)
    const previous = this.failures.get(id)
    const now = this.now()

    // A NEW failure — first ever, or a different message. Start the backoff over: the
    // swap failing differently is not the same fault continuing, and inheriting the old
    // delay would hide a fast-moving one.
    if (!previous || previous.signature !== signature) {
      this.prune(now)
      this.failures.set(id, {
        message,
        signature,
        count: 1,
        backoffMs: FIRST_BACKOFF_MS,
        nextAttemptAt: now + FIRST_BACKOFF_MS,
        sinceReported: 0,
        lastFailureAt: now,
      })
      return { line: message, backoffMs: FIRST_BACKOFF_MS }
    }

    // Keep the newest text so a reported line carries a CURRENT trace id rather than
    // the first occurrence's, which no longer resolves.
    previous.message = message
    previous.lastFailureAt = now
    previous.count += 1
    previous.sinceReported += 1
    const backoffMs = Math.min(previous.backoffMs * 2, MAX_BACKOFF_MS)
    previous.backoffMs = backoffMs
    previous.nextAttemptAt = now + backoffMs

    // Report on the 1st, 2nd, 4th, 8th … occurrence. Logarithmic rather than every-nth:
    // the interesting part of a repeating fault is that it is STILL happening, which
    // seven lines convey as well as ninety-eight, while a linear rule either floods
    // early or goes quiet exactly when a long outage is worth noticing.
    const isPowerOfTwo = (previous.count & (previous.count - 1)) === 0
    if (!isPowerOfTwo) return { line: null, backoffMs }

    const repeats = previous.sinceReported
    previous.sinceReported = 0
    return {
      line: `${message} (${previous.count} consecutive; ${repeats} since last, backing off ${Math.round(backoffMs / 1000)}s)`,
      backoffMs,
    }
  }

  /**
   * Whether this swap is still being held off. Skipping is safe by the orchestrators'
   * own contract — a tick is re-entrant and re-reads the row — so it costs latency on a
   * swap that was failing anyway, and nothing else.
   */
  shouldSkip(id: string): boolean {
    const failure = this.failures.get(id)
    return failure !== undefined && this.now() < failure.nextAttemptAt
  }

  /**
   * Forget a swap's failures, on a clean tick. The next fault should be reported at
   * once rather than inheriting a minute-long delay from a cause that no longer applies.
   */
  clear(id: string): void {
    this.failures.delete(id)
  }

  /**
   * Drop swaps that stopped failing without ever ticking cleanly — terminal, or parked
   * in `stuck`. `clear` handles recovery; nothing else would remove these.
   */
  private prune(now: number): void {
    for (const [id, failure] of this.failures) {
      if (now - failure.lastFailureAt > STALE_AFTER_MS) this.failures.delete(id)
    }
  }

  /**
   * Swaps CURRENTLY failing, for the console's diagnostics — an entry older than
   * {@link STALE_AFTER_MS} is dropped rather than listed, so the panel says what needs
   * attention now. Newest first.
   */
  get failing(): { id: string; message: string; count: number }[] {
    const now = this.now()
    this.prune(now)
    return [...this.failures.entries()]
      .sort(([, a], [, b]) => b.lastFailureAt - a.lastFailureAt)
      .map(([id, f]) => ({ id, message: f.message.slice(0, DISPLAY_CHARS), count: f.count }))
  }
}
