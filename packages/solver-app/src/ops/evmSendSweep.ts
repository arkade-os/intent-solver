export const withEvmSendSweep = async (input: {
  service: { tickAll(): Promise<unknown> } | null
  policies: readonly { enabled: boolean; direction: 'send' | 'receive' }[]
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
    if (
      timer !== undefined ||
      input.signal.aborted ||
      !service ||
      !input.policies.some((policy) => policy.enabled && policy.direction === 'send')
    ) {
      return
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
    await inFlight
  }
}
