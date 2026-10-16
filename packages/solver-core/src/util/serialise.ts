/**
 * One job at a time, in call order. A live serve-list swap must not interleave
 * with a quote that has already read the old list, and three call sites wanted
 * that guarantee — so the chain is spelled once, here.
 *
 * One queue per instance, not one per market: per-pair locks would let two
 * pairs proceed at once, and a swap is a map assignment. A rejected job does
 * not poison the queue.
 */
export type Serialiser = <T>(job: () => Promise<T>) => Promise<T>

export const createSerialiser = (): Serialiser => {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job, job)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
