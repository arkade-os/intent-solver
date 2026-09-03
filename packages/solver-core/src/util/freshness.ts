/**
 * An async value read synchronously, or not at all.
 *
 * `PricingStrategy` is synchronous on purpose — quoting is on the hot path, and
 * an upstream call per quote adds its latency to every request and hands a
 * taker a way to amplify load onto whatever is being asked. But the numbers
 * pricing wants (a fee rate, a routing estimate) come from the network. This is
 * the join: something else fetches on a schedule, and the reader gets whatever
 * has most recently landed.
 *
 * TWO AGES, not one, and the difference is the whole point:
 *
 *  - `refreshAfterMs` — how old a value may get before a new fetch STARTS. The
 *    old value keeps being served meanwhile, so a refresh never blocks a quote.
 *  - `staleAfterMs` — how old it may get before it stops being served at all,
 *    and reads return null.
 *
 * With one age you must choose between blocking on a refresh and quoting off
 * something arbitrarily old. With two, the common case is free and the bad case
 * is a refusal: `networkFeePricing` reads null as "no estimate" and falls back
 * to the configured flat rather than pricing off a number from an hour ago.
 */
export interface FreshnessOptions<T> {
  /** The fetch. May reject; a rejection leaves the previous value in place. */
  fetch: () => Promise<T>
  /** Start a refresh once the held value is older than this. */
  refreshAfterMs: number
  /** Stop serving the held value once it is older than this. Must exceed `refreshAfterMs`. */
  staleAfterMs: number
  /** Milliseconds. Injected so tests need no timers. */
  now: () => number
}

/**
 * Returns a synchronous reader. Null until the first fetch lands, and again
 * whenever the last one is older than `staleAfterMs`.
 *
 * Reading is what triggers refreshing — there is no timer. A solver that stops
 * quoting stops fetching, which is the behaviour you want from something whose
 * only consumer is quoting: no background traffic to an upstream nobody is
 * currently asking about.
 */
export const freshly = <T>({ fetch, refreshAfterMs, staleAfterMs, now }: FreshnessOptions<T>): (() => T | null) => {
  if (staleAfterMs <= refreshAfterMs) {
    // Otherwise a value becomes unservable at or before the moment a refresh
    // would start, so every read past `refreshAfterMs` returns null and the
    // cache degrades into "always null" — quietly, and only under load.
    throw new Error(`freshly: staleAfterMs ${staleAfterMs} must exceed refreshAfterMs ${refreshAfterMs}`)
  }

  let held: T | null = null
  let heldAt = 0
  let inFlight = false

  const start = (): void => {
    // One at a time. Without this a burst of quotes past the refresh age each
    // start their own fetch, which is precisely the amplification the
    // synchronous read exists to prevent.
    if (inFlight) return
    inFlight = true
    void fetch()
      .then((value) => {
        held = value
        heldAt = now()
      })
      // Swallowed deliberately, and the previous value is KEPT: a fetch that
      // fails says nothing about whether the last answer is still true. It
      // ages out on `staleAfterMs` like any other, so a permanently broken
      // source degrades to null rather than to a lie.
      .catch(() => {})
      .finally(() => {
        inFlight = false
      })
  }

  return () => {
    const age = now() - heldAt
    if (held === null || age >= refreshAfterMs) start()
    return held !== null && age < staleAfterMs ? held : null
  }
}
