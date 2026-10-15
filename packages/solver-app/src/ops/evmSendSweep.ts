/**
 * Armed on the SERVICE alone: `enabled` stops new business, but disabling is the
 * incident response to a stuck row — gating this timer on it silenced the late-lock watch (#175).
 */
export const withEvmSendSweep = async (input: {
  service: { tickAll(): Promise<unknown> } | null
  recoverySweep?: () => Promise<void>
  intervalMs: number
  signal: AbortSignal
  run(startSweep: () => void): Promise<void>
  onError(error: unknown): void
}): Promise<void> => {
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<void> | undefined
  let recoveryTimer: ReturnType<typeof setInterval> | undefined
  let recoveryInFlight: Promise<void> | undefined
  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    if (recoveryTimer !== undefined) clearInterval(recoveryTimer)
    recoveryTimer = undefined
  }
  const start = (): void => {
    const service = input.service
    if (timer !== undefined || input.signal.aborted || !service) return
    const recoverySweep = input.recoverySweep
    if (recoverySweep !== undefined && recoveryTimer === undefined) {
      const runRecovery = (): void => {
        if (recoveryInFlight || input.signal.aborted) return
        recoveryInFlight = Promise.resolve()
          .then(recoverySweep)
          .catch(input.onError)
          .finally(() => {
            recoveryInFlight = undefined
          })
      }
      runRecovery()
      recoveryTimer = setInterval(runRecovery, input.intervalMs)
    }
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
    await Promise.all([inFlight, recoveryInFlight])
  }
}
