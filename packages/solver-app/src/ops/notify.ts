/**
 * Fire-and-forget delivery to the operator's chat. `post` is SYNCHRONOUS and
 * void: no promise to await, no rejection to catch, so a notification cannot
 * block or fail a swap by construction. The queue drops its OLDEST entry when
 * full and retries stop after `attempts`. A sink is known by NAME only.
 */

export interface NotifySink {
  readonly name: string
  send(text: string): Promise<void>
}

export interface NotifyStats {
  sent: number
  failed: number
  dropped: number
}

export interface Notifier {
  post(text: string): void
  stats(): NotifyStats
  /** Resolves when the queue is empty. For tests and for shutdown. */
  flush(): Promise<void>
}

export interface NotifierOptions {
  sinks: readonly NotifySink[]
  attempts?: number
  maxQueue?: number
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  onDeliveryFailed?: (sinkName: string, error: unknown) => void
}

const DEFAULT_ATTEMPTS = 3
const DEFAULT_MAX_QUEUE = 100
const DEFAULT_BASE_DELAY_MS = 500

export const createNotifier = (options: NotifierOptions): Notifier => {
  const { sinks, onDeliveryFailed } = options
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const queue: string[] = []
  const stats: NotifyStats = { sent: 0, failed: 0, dropped: 0 }
  let draining: Promise<void> | null = null
  let scheduled = false

  const deliver = async (sink: NotifySink, text: string): Promise<boolean> => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await sink.send(text)
        return true
      } catch (error) {
        if (attempt === attempts) {
          onDeliveryFailed?.(sink.name, error)
          return false
        }
        await sleep(baseDelayMs * attempt)
      }
    }
    return false
  }

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const text = queue.shift()
      if (text === undefined) continue
      const results = await Promise.all(sinks.map((sink) => deliver(sink, text)))
      if (results.some(Boolean)) stats.sent += 1
      else stats.failed += 1
    }
    draining = null
  }

  // A microtask, not an inline call: `drain()` here would run the first
  // `sink.send(...)` on the CALLER's stack, putting a sink's synchronous work on
  // the money path.
  const schedule = (): void => {
    if (scheduled || draining !== null) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (draining === null) {
        draining = drain().catch(() => {
          draining = null
        })
      }
    })
  }

  return {
    post: (text) => {
      if (sinks.length === 0) return
      if (queue.length >= maxQueue) {
        queue.shift()
        stats.dropped += 1
      }
      queue.push(text)
      schedule()
    },
    stats: () => ({ ...stats }),
    flush: async () => {
      while (scheduled || draining !== null) {
        if (draining !== null) await draining
        else await new Promise<void>((resolve) => queueMicrotask(resolve))
      }
    },
  }
}
