/**
 * The join between a synchronous reader and an async source.
 *
 * What is worth pinning is not the caching — it is the three behaviours that
 * make it safe to price from: a refresh never blocks a read, a failed fetch
 * does not discard a good answer, and a value too old to trust reads as
 * ABSENT rather than as itself.
 */
import { describe, it, expect } from 'vitest'
import { freshly } from '@arkade-os/solver-core/util/freshness.js'

/** Deterministic clock; no timers anywhere in this file. */
const clock = (start = 0) => {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

/**
 * Drain the microtask queue.
 *
 * Awaiting the fetch's own promise is NOT enough. `freshly` attaches
 * `.then().catch().finally()`, so the assignment lands several microtasks
 * after that promise settles — asserting straight after the await reads the
 * value from BEFORE the refresh. That failed here once and looked exactly
 * like the cache declining to update; it was this helper missing.
 */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** Lets a test decide exactly when a fetch resolves. */
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('freshly', () => {
  it('reads null until the first fetch lands, rather than blocking', async () => {
    const { now } = clock()
    const first = deferred<number>()
    const read = freshly({ fetch: () => first.promise, refreshAfterMs: 100, staleAfterMs: 1_000, now })

    // The whole contract: a read never waits.
    expect(read()).toBeNull()
    first.resolve(42)
    await flush()
    expect(read()).toBe(42)
  })

  it('keeps serving the held value while a refresh is in flight', async () => {
    const c = clock()
    let pending = deferred<number>()
    const read = freshly({ fetch: () => pending.promise, refreshAfterMs: 100, staleAfterMs: 1_000, now: c.now })
    read()
    pending.resolve(1)
    await flush()
    expect(read()).toBe(1)

    // Past the refresh age: a new fetch starts, and 1 is still what a quote gets.
    pending = deferred<number>()
    c.advance(150)
    expect(read()).toBe(1)
    pending.resolve(2)
    await flush()
    expect(read()).toBe(2)
  })

  it('runs ONE fetch for a burst of reads, not one each', async () => {
    const c = clock()
    let fetches = 0
    const read = freshly({
      fetch: () => {
        fetches++
        return Promise.resolve(7)
      },
      refreshAfterMs: 100,
      staleAfterMs: 1_000,
      now: c.now,
    })
    // The amplification the synchronous read exists to prevent.
    for (let i = 0; i < 50; i++) read()
    expect(fetches).toBe(1)
  })

  it('keeps the last good value when a fetch fails', async () => {
    const c = clock()
    let mode: 'ok' | 'fail' = 'ok'
    const read = freshly({
      fetch: () => (mode === 'ok' ? Promise.resolve(5) : Promise.reject(new Error('upstream down'))),
      refreshAfterMs: 100,
      staleAfterMs: 1_000,
      now: c.now,
    })
    read()
    await flush()
    expect(read()).toBe(5)

    // A failed fetch says nothing about whether the last answer is still true.
    mode = 'fail'
    c.advance(150)
    expect(read()).toBe(5)
    await flush()
    expect(read()).toBe(5)
  })

  it('reads null once the held value is too old to trust', async () => {
    const c = clock()
    const read = freshly({ fetch: () => Promise.resolve(9), refreshAfterMs: 100, staleAfterMs: 1_000, now: c.now })
    read()
    await flush()
    expect(read()).toBe(9)

    // Past staleness: ABSENT, not itself. `networkFeePricing` reads null as
    // "no estimate" and falls back, rather than pricing off an hour-old rate.
    c.advance(1_000)
    expect(read()).toBeNull()
  })

  it('a permanently broken source degrades to null, never to a lie', async () => {
    const c = clock()
    let mode: 'ok' | 'fail' = 'ok'
    const read = freshly({
      fetch: () => (mode === 'ok' ? Promise.resolve(3) : Promise.reject(new Error('down'))),
      refreshAfterMs: 100,
      staleAfterMs: 1_000,
      now: c.now,
    })
    read()
    await Promise.resolve()
    mode = 'fail'
    c.advance(1_000)
    expect(read()).toBeNull()
  })

  it('refuses a staleness age at or below the refresh age', () => {
    // Otherwise every read past the refresh age returns null and the cache
    // silently becomes "always null" — under load, and nowhere else.
    const { now } = clock()
    expect(() => freshly({ fetch: () => Promise.resolve(1), refreshAfterMs: 100, staleAfterMs: 100, now })).toThrow(
      /must exceed/,
    )
  })
})
