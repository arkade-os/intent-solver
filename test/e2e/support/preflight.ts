/**
 * What "the stack is up" means, checked before any e2e test moves money.
 *
 * These tests gate no merge (`pnpm test` excludes `test/e2e`); they are run
 * deliberately — locally by someone who has just brought a regtest stack up, or
 * by `.github/workflows/e2e.yml`, which stands one up on demand. That
 * makes the single worst outcome a SILENT SKIP: a suite that quietly passes
 * with nothing connected rots into one that cannot pass at all, and nobody
 * finds out for months. So an absent dependency is a FAILURE here, never a
 * skip — but a failure that names exactly which dependency, at which URL,
 * with what error, rather than a thirty-second timeout with no explanation.
 *
 * Every probe in {@link probeStack} runs on every preflight even though no
 * single test needs all of them, so the report an operator reads shows the
 * WHOLE stack at a glance. Only the subset a test declares in
 * `requireStack([...])` can fail it.
 *
 * Environment: read from an env file (`E2E_ENV_FILE`, default
 * `.env.regtest.lnd` — the superset that carries both the Arkade wallet and
 * the LND credentials all four corridors need between them), loaded here
 * rather than by `node --env-file` so `pnpm test:e2e` stays one command.
 * Anything already set in the real environment wins, so a one-off override on
 * the command line still works.
 */

import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'

/** Every external process an e2e corridor can depend on. */
export type Dependency = 'arkd' | 'emulator' | 'esplora' | 'covclaimd' | 'lnd' | 'ln-counterparty'

export interface ProbeResult {
  dependency: Dependency
  /** Where it was looked for — the URL or host:port actually probed. */
  target: string
  reachable: boolean
  /** Why it was unreachable, when it was. */
  detail?: string
}

/** How long any single preflight probe may take. Short: this is a liveness check, not a swap. */
const PROBE_TIMEOUT_MS = 5000

/**
 * Load `path` into `process.env` WITHOUT overwriting anything already set.
 *
 * A deliberately minimal parser — `KEY=value`, `#` comments, optional
 * surrounding quotes — matching the shape of this repo's own `.env.regtest*`
 * files (which are consumed by `node --env-file` everywhere else and so are
 * already restricted to what that understands). No dotenv dependency is added
 * for eight lines of parsing.
 */
export const loadEnvFile = (path: string): void => {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, rawValue] = match as unknown as [string, string, string]
    if (process.env[key] !== undefined) continue
    process.env[key] = rawValue.trim().replace(/^(["'])(.*)\1$/, '$2')
  }
}

let envLoaded = false

/** Load the e2e env file once per process. Idempotent — every test file calls it. */
export const loadE2eEnv = (): void => {
  if (envLoaded) return
  envLoaded = true
  loadEnvFile(process.env.E2E_ENV_FILE ?? '.env.regtest.lnd')
}

/** covclaimd's base URL. No `packages/solver-app/src/config.ts` knob exists for it — the receive legs are not wired into the CLI yet. */
export const covclaimdUrl = (): string => process.env.COVCLAIMD_URL ?? 'http://localhost:7271'

/** The stack's Esplora-compatible chain index (arkade-regtest's mempool proxy). */
export const esploraUrl = (): string => process.env.ESPLORA_URL ?? 'http://localhost:3000/api'

/** Current chain tip height, or null if it cannot be read. */
export const chainTip = async (): Promise<number | null> => {
  try {
    const response = await fetch(`${esploraUrl().replace(/\/$/, '')}/blocks/tip/height`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const height = Number((await response.text()).trim())
    return Number.isFinite(height) ? height : null
  } catch {
    return null
  }
}

/**
 * Turn "waited for confirmations and gave up" into "the miner is not mining".
 *
 * Anything gated on `min_confirmations` cannot finish on a stack whose miner
 * is stopped — a common state, since arkade-regtest's miner is a separate
 * container from the nodes the preflight probes and can die on its own while
 * everything else stays reachable. Called only on the failure path, so a
 * healthy run pays nothing for it.
 */
export const explainConfirmationTimeout = async (tipBefore: number | null, original: Error): Promise<Error> => {
  const tipAfter = await chainTip()
  if (tipBefore === null || tipAfter === null || tipAfter > tipBefore) return original
  return new Error(
    [
      `${original.message}`,
      '',
      `The chain tip has not moved (still ${tipAfter}) for the whole wait, so no confirmation could ever arrive.`,
      "The stack's miner is not mining. Everything else can be up and this still fails.",
      '  docker start bitcoin-miner        # or: cd arkade-regtest && node regtest.mjs mine 1',
    ].join('\n'),
  )
}

const probeHttp = async (dependency: Dependency, target: string): Promise<ProbeResult> => {
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!response.ok) return { dependency, target, reachable: false, detail: `HTTP ${response.status}` }
    return { dependency, target, reachable: true }
  } catch (error) {
    return { dependency, target, reachable: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * LND speaks gRPC over TLS with a macaroon, so the cheap liveness answer is
 * "is anything accepting TCP on that socket". A full authenticated call would
 * also prove the cert and macaroon are right — that is left to the adapter
 * construction in `stack.ts`, which fails just as loudly and does not need
 * the credentials duplicated here.
 */
const probeTcp = (dependency: Dependency, hostPort: string): Promise<ProbeResult> =>
  new Promise((resolve) => {
    const [host = 'localhost', port = ''] = hostPort.split(':')
    const socket = connect({ host, port: Number(port) })
    const done = (reachable: boolean, detail?: string): void => {
      socket.destroy()
      resolve({ dependency, target: hostPort, reachable, detail })
    }
    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false, `no TCP connect within ${PROBE_TIMEOUT_MS}ms`))
    socket.once('error', (error: Error) => done(false, error.message))
  })

/**
 * The SECOND LND node, reached the way the Lightning corridors reach it:
 * `docker exec <container> lncli`. Probed through that exact path rather than
 * over TCP because both failure modes a test actually hits — docker not on
 * PATH, and the container not running — leave the node's port either closed or
 * irrelevant, and neither is distinguishable from a hung Lightning leg without
 * this line in the report.
 */
const probeCounterparty = async (): Promise<ProbeResult> => {
  const { COUNTERPARTY_CONTAINER, nodeBlockHeight } = await import('./counterparty.js')
  const target = `docker exec ${COUNTERPARTY_CONTAINER} lncli`
  try {
    await nodeBlockHeight(COUNTERPARTY_CONTAINER)
    return { dependency: 'ln-counterparty', target, reachable: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return { dependency: 'ln-counterparty', target, reachable: false, detail }
  }
}

/** Probe every dependency, in parallel. Never throws — the report is the product. */
export const probeStack = async (): Promise<ProbeResult[]> => {
  loadE2eEnv()
  const arkServerUrl = process.env.ARK_SERVER_URL ?? 'http://localhost:7070'
  const emulatorUrl = process.env.EMULATOR_URL ?? 'http://localhost:7073'
  return Promise.all([
    probeHttp('arkd', `${arkServerUrl.replace(/\/$/, '')}/v1/info`),
    probeHttp('emulator', `${emulatorUrl.replace(/\/$/, '')}/v1/info`),
    probeHttp('esplora', `${esploraUrl().replace(/\/$/, '')}/blocks/tip/height`),
    probeHttp('covclaimd', `${covclaimdUrl().replace(/\/$/, '')}/v1/preimage/covclaimd-pubkey`),
    probeTcp('lnd', process.env.LND_SOCKET ?? 'localhost:10010'),
    probeCounterparty(),
  ])
}

/** The whole stack as a fixed-width table, reachable and not — what a failing preflight prints. */
export const formatReport = (results: readonly ProbeResult[]): string =>
  results
    .map(
      (r) =>
        `  ${r.reachable ? 'up  ' : 'DOWN'}  ${r.dependency.padEnd(10)} ${r.target}${r.detail ? ` — ${r.detail}` : ''}`,
    )
    .join('\n')

/**
 * Assert every dependency in `required` is reachable, or throw naming all of
 * them plus the state of everything else.
 *
 * Call from a `beforeAll`. The thrown message is the entire diagnostic: which
 * corridor wanted what, what was actually up, and the one command that brings
 * the stack back.
 */
export const requireStack = async (corridor: string, required: readonly Dependency[]): Promise<void> => {
  const results = await probeStack()
  const missing = results.filter((r) => required.includes(r.dependency) && !r.reachable)
  if (missing.length === 0) return
  throw new Error(
    [
      `${corridor} e2e cannot run: ${missing.map((m) => m.dependency).join(', ')} unreachable.`,
      '',
      `required by this corridor: ${required.join(', ')}`,
      'stack:',
      formatReport(results),
      '',
      'Bring the stack up first (docs/runbook.md § "Replicating end to end on regtest"):',
      '  git clone https://github.com/arklabsHQ/arkade-regtest && cd arkade-regtest && node regtest.mjs start',
      `Environment came from ${process.env.E2E_ENV_FILE ?? '.env.regtest.lnd'} (override with E2E_ENV_FILE).`,
    ].join('\n'),
  )
}
