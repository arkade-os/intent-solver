/** Observe a rejection at once, so an early return cannot leave it unhandled. */
export type Captured<T> = { ok: true; value: T } | { ok: false; error: unknown }

export const capture = <T>(promise: Promise<T>): Promise<Captured<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  )

export const unwrap = <T>(captured: Captured<T>): T => {
  if (!captured.ok) throw captured.error
  return captured.value
}
