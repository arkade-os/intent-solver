import { messageOf } from '@arkade-os/solver-core/util/poll.js'

export interface RailWatch {
  /** Whether a probe answered within the last {@link STALE_PROBES} intervals and none has failed since. */
  up(): boolean
  stop(): void
}

/** A stalled probe closes the gate after this many intervals, not at its own 30 s read deadline. */
const STALE_PROBES = 3

/**
 * Whether the rail's node answers, re-asked on a timer. Not `freshly`: it refreshes on read, so after a quiet spell
 * longer than its stale age the first quote would be refused against a healthy node.
 */
export const watchRail = ({
  probe,
  intervalMs,
  log,
  onReachable,
}: {
  probe: () => Promise<void>
  intervalMs: number
  log: (line: string) => void
  onReachable?: () => void
}): RailWatch => {
  let answeredAt: number | null = null
  let down: string | null = null
  let probing = false
  let stopped = false
  const check = async (): Promise<void> => {
    if (probing || stopped) return
    probing = true
    let reason: string | null = null
    try {
      await probe()
    } catch (error) {
      reason = messageOf(error)
    } finally {
      probing = false
    }
    if (stopped) return
    if (reason === null) {
      if (down !== null) log('LND answers again; quoting its corridors again')
      answeredAt = Date.now()
      down = null
      onReachable?.()
      return
    }
    if (reason !== down) log(`LND unreachable, refusing new swaps on its corridors: ${reason}`)
    answeredAt = null
    down = reason
  }
  void check()
  const timer = setInterval(() => void check(), intervalMs)
  timer.unref()
  return {
    up: () => answeredAt !== null && Date.now() - answeredAt < intervalMs * STALE_PROBES,
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
