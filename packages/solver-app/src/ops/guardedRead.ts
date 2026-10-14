/** Reads for the periodic reports: bounded in time, and never repeated while one is still running. */

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

/** A read still running under `key` is joined by the next caller instead of started again. */
export const createJoin = () => {
  const running = new Map<string, Promise<unknown>>()
  return <T>(key: string, read: () => Promise<T>) =>
    (): Promise<T> => {
      let pending = running.get(key) as Promise<T> | undefined
      if (pending === undefined) {
        pending = Promise.resolve()
          .then(read)
          .finally(() => running.delete(key))
        running.set(key, pending)
      }
      return pending
    }
}
