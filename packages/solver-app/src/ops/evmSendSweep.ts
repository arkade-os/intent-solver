/**
 * Armed on the SERVICE alone: `enabled` stops new business, but disabling is the
 * incident response to a stuck row — gating this timer on it silenced the late-lock watch (#175).
 */
export const withEvmSendSweep = async (input: {
  service: { tickAll(): Promise<unknown> } | null
  intervalMs: number
  signal: AbortSignal
  run(startSweep: () => void): Promise<void>
  onError(error: unknown): void
}): Promise<void> => {
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<void> | undefined
  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const start = (): void => {
    const service = input.service
    if (timer !== undefined || input.signal.aborted || !service) return
    timer = setInterval(() => {
      if (inFlight) return
      inFlight = Promise.resolve()
        .then(() => service.tickAll())
        .then(() => {})
        .catch(input.onError)
        .finally(() => {
          inFlight = undefined
        })
    }, input.intervalMs)
  }
  input.signal.addEventListener('abort', stop)
  try {
    await input.run(start)
  } finally {
    stop()
    input.signal.removeEventListener('abort', stop)
    await inFlight
  }
}
