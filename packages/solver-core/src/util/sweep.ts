/** What a sweep drives. Hooks are read per row, so a host may set them after construction. */
export interface SweepTarget<R> {
  tick(id: string): Promise<R>
  shouldSkipTick?: (id: string) => boolean
  onTickSuccess?: (id: string) => void
  onTickError?: (id: string, error: unknown) => void
}

/** Tick each row once, `concurrency` at a time, isolating per-row failures. Rows return in completion order. */
export const sweep = async <R extends { id: string }>(
  rows: readonly R[],
  target: SweepTarget<R>,
  store: { get(id: string): Promise<R> },
  { inFlight, concurrency = 1 }: { inFlight?: ReadonlySet<string>; concurrency?: number } = {},
): Promise<R[]> => {
  const driven: R[] = []
  const cursor = rows[Symbol.iterator]()
  const worker = async (): Promise<void> => {
    for (const row of cursor) {
      // Gated here rather than in `tick`, so only the timer is throttled — never an
      // operator's recheck or a one-shot CLI tick.
      if (target.shouldSkipTick?.(row.id) || inFlight?.has(row.id)) {
        driven.push(row)
        continue
      }
      try {
        driven.push(await target.tick(row.id))
        target.onTickSuccess?.(row.id)
      } catch (error) {
        target.onTickError?.(row.id, error)
        try {
          driven.push(await store.get(row.id))
        } catch {
          // A store fault; rethrowing would abort the whole sweep. The next one retries.
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker))
  return driven
}

/** Step one row until it stops advancing; a re-entrant call gets the current row instead. */
export const guardedTick = async <R>(
  id: string,
  inFlight: Set<string>,
  store: { get(id: string): Promise<R> },
  step: (row: R) => Promise<boolean>,
): Promise<R> => {
  if (inFlight.has(id)) return store.get(id)
  inFlight.add(id)
  try {
    while (await step(await store.get(id))) {
      // each successful step re-reads the row and tries the next
    }
    return await store.get(id)
  } finally {
    inFlight.delete(id)
  }
}
