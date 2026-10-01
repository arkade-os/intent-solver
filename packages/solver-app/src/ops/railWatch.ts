import { messageOf } from '@arkade-os/solver-core/util/poll.js'

export interface RailWatch {
  /** False until a probe answers, and again from the first one that does not. */
  up(): boolean
  stop(): void
}

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
  let up = false
  let down: string | null = null
  let probing = false
  const check = async (): Promise<void> => {
    if (probing) return
    probing = true
    let reason: string | null = null
    try {
      await probe()
    } catch (error) {
      reason = messageOf(error)
    } finally {
      probing = false
    }
    if (reason === null) {
      if (down !== null) log('LND answers again; quoting its corridors again')
      up = true
      down = null
      onReachable?.()
      return
    }
    if (reason !== down) log(`LND unreachable, refusing new swaps on its corridors: ${reason}`)
    up = false
    down = reason
  }
  void check()
  const timer = setInterval(() => void check(), intervalMs)
  timer.unref()
  return { up: () => up, stop: () => clearInterval(timer) }
}
