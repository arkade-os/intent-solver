/**
 * A slow pass on its own clock, off the caller's loop. @see cli.ts
 *
 * Three properties are the contract: one pass at a time, no pass started once
 * the signal aborts, and `stop` outlives the pass in flight — the caller tears
 * down the stores a pass reads.
 */
export const startCadence = (input: {
  intervalMs: number
  signal: AbortSignal
  pass: () => Promise<void>
  onError: (error: unknown) => void
}): { stop: () => Promise<void> } => {
  let inFlight: Promise<void> | undefined
  const tick = (): void => {
    if (inFlight || input.signal.aborted) return
    // Caught here, not by the caller: an interval's rejection has nobody to
    // await it, and an unhandled rejection takes the process down.
    inFlight = Promise.resolve()
      .then(input.pass)
      .catch(input.onError)
      .finally(() => {
        inFlight = undefined
      })
  }
  const timer = setInterval(tick, input.intervalMs)
  const clear = (): void => clearInterval(timer)
  input.signal.addEventListener('abort', clear)
  tick()
  return {
    stop: async () => {
      clear()
      input.signal.removeEventListener('abort', clear)
      await inFlight
    },
  }
}
