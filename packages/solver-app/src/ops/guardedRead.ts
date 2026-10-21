/** Reads for the periodic reports: bounded in time, and not repeated while one is still running. */

/** Rejects after `ms`. The read itself keeps running: no port here takes a cancellation signal. */
export const within =
  <T>(read: () => Promise<T>, ms: number) =>
  async (): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms)
          timer.unref()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

// ponytail: a backend that never answers leaks one abandoned read per window; a cancellable port would end that.
/** Past this, a read still running is taken as wedged and the next caller starts a fresh one beside it. */
export const STALE_READ_MS = 10 * 60_000

/** A read still running under `key`, and younger than `maxAgeMs`, is joined by the next caller instead of started again. */
export const createJoin = (maxAgeMs = Infinity) => {
  const running = new Map<string, { pending: Promise<unknown>; startedAt: number }>()
  return <T>(key: string, read: () => Promise<T>) =>
    (): Promise<T> => {
      const entry = running.get(key)
      if (entry !== undefined && Date.now() - entry.startedAt < maxAgeMs) return entry.pending as Promise<T>
      const pending: Promise<T> = Promise.resolve()
        .then(read)
        .finally(() => {
          if (running.get(key)?.pending === pending) running.delete(key)
        })
      running.set(key, { pending, startedAt: Date.now() })
      return pending
    }
}
