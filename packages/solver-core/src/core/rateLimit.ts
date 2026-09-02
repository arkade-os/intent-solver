/**
 * Admission control for quote creation. Pure — no I/O, clock injected.
 *
 * A quote costs the caller nothing but commits provider capacity for the whole
 * lockup timeout (the aggregate exposure cap counts `quoted` rows by design).
 * Unauthenticated, unmetered quote creation lets one script squat the entire cap on
 * repeat, turning the safety cap into a standing denial of service.
 *
 * This does NOT make squatting impossible. The key is only as strong as the
 * transport's requester identity — a socket IP behind no proxy, a relay author key
 * that costs nothing to mint — so a distributed attacker still gets through. It
 * prices quote spam per identity; the exposure cap remains the bound on what is
 * ever at risk.
 *
 * The window matches DEFAULT_LOCKUP_TIMEOUT: a squatted slot lives exactly one
 * window, so a requester that exhausts its budget is refused for precisely as
 * long as its own quotes would have held capacity anyway. `LOCKUP_TIMEOUT_SECONDS`
 * makes the match approximate — fine, this prices spam, it is not a safety bound.
 */

import { MINUTE } from './timelocks.js'

/** New quotes one requester key may open per window. */
export const QUOTE_RATE_LIMIT = 5

/** One lockup timeout, in seconds — see the module comment. */
export const QUOTE_RATE_WINDOW_SECONDS = 15 * MINUTE

/**
 * Bound on distinct keys held at once. An attacker minting a key per request
 * defeats per-key limiting by construction; the bound exists so that same
 * attack cannot also grow memory without limit. On pressure the oldest windows
 * are dropped — precision is sacrificed, never memory.
 */
const MAX_TRACKED_KEYS = 10_000

interface Window {
  start: number
  count: number
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>()

  /**
   * @param limit   takes allowed per key per window
   * @param windowSeconds  window length, in the same units as `now`
   * @param now     clock, injected like every core module's
   */
  constructor(
    private readonly limit: number,
    private readonly windowSeconds: number,
    private readonly now: () => number,
  ) {}

  /**
   * Consume one unit of `key`'s budget. Returns false — consuming nothing —
   * when the key has exhausted its window.
   */
  take(key: string): boolean {
    const now = this.now()
    if (this.windows.size >= MAX_TRACKED_KEYS) this.prune(now)
    const window = this.windows.get(key)
    if (!window || now - window.start >= this.windowSeconds) {
      // Map insertion order doubles as oldest-first for the prune above; a
      // reset moves the key to the back, which is also the right evict order.
      this.windows.delete(key)
      this.windows.set(key, { start: now, count: 1 })
      return true
    }
    if (window.count >= this.limit) return false
    window.count += 1
    return true
  }

  /** Drop expired windows; if none are expired, drop the oldest half. */
  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowSeconds) this.windows.delete(key)
    }
    if (this.windows.size < MAX_TRACKED_KEYS) return
    const excess = this.windows.size - MAX_TRACKED_KEYS / 2
    let dropped = 0
    for (const key of this.windows.keys()) {
      if (dropped++ >= excess) break
      this.windows.delete(key)
    }
  }
}
