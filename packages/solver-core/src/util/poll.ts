/** Bounded retry, shared by every "wait for it to show up" loop. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const nowSeconds = (): number => Math.floor(Date.now() / 1000)

export const log = (...parts: unknown[]): void => console.log(`[${new Date().toISOString()}]`, ...parts)

export const json = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))

/** Thrown by a probe that wants to stop the loop rather than be retried. */
export class GiveUp extends Error {}

/**
 * Probe until it yields something, then return it.
 *
 * Probes first and sleeps after, so a value already available costs no wait and
 * the final attempt is not followed by a sleep nobody uses.
 *
 * A probe that throws costs an attempt and the loop continues. This matters more
 * than it looks: these loops run in the window where the provider has paid over
 * Lightning and not yet claimed, so letting one dropped packet abort the loop
 * would abandon a claim on money that has already left. A probe that genuinely
 * wants to stop throws `GiveUp`.
 */
export const poll = async <T>(
  probe: () => Promise<T | null | undefined>,
  { attempts, intervalMs = 2000, whenExhausted }: { attempts: number; intervalMs?: number; whenExhausted: string },
): Promise<T> => {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const value = await probe()
      // `null`/`undefined` is the "not yet" signal, per this function's own
      // signature — NOT falsiness. A probe answering `0` is answering, and
      // `0` is a perfectly ordinary vout, block height or balance. Reading it
      // as "keep waiting" would spin out the full attempt budget and then throw
      // about a value it had in hand on the first try.
      if (value !== null && value !== undefined) return value
      lastError = undefined
    } catch (error) {
      if (error instanceof GiveUp) throw error
      lastError = error
    }
    if (attempt < attempts - 1) await sleep(intervalMs)
  }
  const detail = lastError instanceof Error ? `; last error: ${lastError.message}` : ''
  throw new Error(`${whenExhausted}${detail}`)
}
