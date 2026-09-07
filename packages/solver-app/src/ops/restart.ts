/**
 * Stopping this process on purpose, so a supervisor starts it again.
 *
 * ## There is no in-process restart, and there cannot be one
 *
 * Node cannot re-exec itself into a clean process; the only lever is exiting and
 * letting whatever started the process start it again. So the whole question is
 * WHETHER SOMETHING WILL, and that is a fact about the deployment which this
 * process cannot read:
 *
 * - `docker-compose.yml` sets `restart: unless-stopped` on `swap-provider`, so a
 *   container started from it comes back.
 * - the SAME image under a bare `docker run` with no `--restart` does not.
 * - Shape 1 in docs/runbook.md is `node dist/cli.js serve`, and the runbook only
 *   RECOMMENDS running it under systemd with `Restart=always`. A deployment that
 *   skipped that has no supervisor at all.
 *
 * `process.pid === 1` does not settle it either: it says this is a container's
 * main process, not that the container has a restart policy. So the capability is
 * OPT-IN — `ADMIN_RESTART_SUPERVISED` is the operator asserting the answer — and
 * the refusal is the default. A button that exits an unsupervised solver is a
 * button that takes a money-mover down until a human notices.
 *
 * ## Why SIGTERM rather than process.exit
 *
 * `serve`, `relay` and `watch` all await `watchUntilStopped`, which installs
 * SIGINT/SIGTERM handlers that end the sweep loop and let the command's `finally`
 * close the HTTP servers and every database before `main()` resolves into
 * `process.exit`. Raising the signal takes that existing graceful path instead of
 * duplicating it. The hard exit below is only the backstop for a loop wedged on
 * an unresponsive backend, where nothing would otherwise re-check `running`.
 */

import type { Config } from '../config.js'

/** What {@link ProcessRestart.arm} scheduled, so the caller can report it. */
export interface RestartPlan {
  readonly signalInMs: number
  readonly forceAfterMs: number
}

export interface ProcessRestart {
  /** Why this deployment must not stop itself, or null when it may. */
  readonly refusal: string | null
  /** Arm the shutdown. Throws when {@link refusal} is set. */
  arm(): RestartPlan
}

/**
 * Long enough for the caller to have written its audit row and answered the
 * request, short enough that an operator does not press the button twice.
 *
 * The audit row is a synchronous better-sqlite3 write the route awaits BEFORE
 * this timer can fire, so the margin here is three orders of magnitude rather
 * than a hope — but it is a margin, which is why the ordering is asserted at the
 * seam in `test/admin/restartAction.test.ts` rather than trusted to the clock.
 */
const SIGNAL_DELAY_MS = 1_000

/** The graceful drain's budget before the process is ended outright. */
const FORCE_AFTER_MS = 30_000

export const UNSUPERVISED_REFUSAL =
  'this deployment has not declared a supervisor, so stopping the solver could leave it stopped. Set ' +
  'ADMIN_RESTART_SUPERVISED=true only where something starts the process again when it exits — a container ' +
  'with a Docker restart policy (docker-compose.yml sets `restart: unless-stopped`), or a systemd unit with ' +
  'Restart=always. Until then, restart it the way you deploy it.'

export interface RestartHooks {
  /** Defaults to raising SIGTERM at this process. */
  signal?: () => void
  /** The backstop, when the graceful drain does not finish. */
  exit?: () => void
  schedule?: (run: () => void, ms: number) => void
}

export const createProcessRestart = (
  config: Pick<Config, 'adminRestartSupervised'>,
  hooks: RestartHooks = {},
): ProcessRestart => {
  const signal = hooks.signal ?? ((): void => void process.kill(process.pid, 'SIGTERM'))
  const exit = hooks.exit ?? ((): void => process.exit(0))
  const schedule =
    hooks.schedule ??
    ((run: () => void, ms: number): void => {
      setTimeout(run, ms).unref()
    })
  const refusal = config.adminRestartSupervised ? null : UNSUPERVISED_REFUSAL

  return {
    refusal,
    arm(): RestartPlan {
      if (refusal !== null) throw new Error(refusal)
      schedule(() => {
        signal()
        schedule(exit, FORCE_AFTER_MS)
      }, SIGNAL_DELAY_MS)
      return { signalInMs: SIGNAL_DELAY_MS, forceAfterMs: FORCE_AFTER_MS }
    },
  }
}
