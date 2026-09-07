// SIGTERM, not `process.exit`: `cli.ts` already closes the services and the
// store on that signal. A supervisor is what starts the process again.

/** Deferred so the HTTP response flushes before the process begins to die. */
const DEFAULT_DELAY_MS = 250

export interface RestartDeps {
  enabled: boolean
  signal?: (pid: number, signal: NodeJS.Signals) => void
  setTimer?: (fn: () => void, ms: number) => void
  delayMs?: number
  pid?: number
}

export interface RestartResult {
  restarting: true
  signal: 'SIGTERM'
  delayMs: number
  pid: number
}

export class RestartDisabledError extends Error {
  readonly code = 'restart_disabled'

  constructor() {
    super(
      'Restart is disabled. Set ADMIN_RESTART_ENABLED=true to enable it, and only where a supervisor ' +
        'restarts the process (docker-compose sets restart: unless-stopped; systemd needs Restart=always). ' +
        'Without one, this stops the solver and nothing brings it back.',
    )
    this.name = 'RestartDisabledError'
  }
}

export const requestRestart = (deps: RestartDeps): RestartResult => {
  if (!deps.enabled) throw new RestartDisabledError()

  const pid = deps.pid ?? process.pid
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS
  const signal = deps.signal ?? ((target, sig) => process.kill(target, sig))
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref())

  setTimer(() => signal(pid, 'SIGTERM'), delayMs)

  return { restarting: true, signal: 'SIGTERM', delayMs, pid }
}
