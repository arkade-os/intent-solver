/**
 * Driving the regtest chain forward on purpose, instead of waiting for it.
 *
 * arkade-regtest's auto-miner produces a block every 600 SECONDS, and its
 * entrypoint sleeps BEFORE the first one. That cadence is fine for a stack
 * that just needs to make progress and hopeless for a test with a wall-clock
 * budget: a scenario gated on `min_confirmations` can observe at most ONE
 * block inside a ten-minute timeout, so anything needing two confirmations
 * cannot pass on the auto-miner alone no matter how generous the budget is.
 * A test that times out that way looks exactly like a stalled swap, and has
 * been misread as "the miner is broken" more than once — it is not, it is
 * simply slower than the test.
 *
 * So corridors that depend on confirmations mine explicitly. Mining is
 * ADDITIVE and non-destructive: it appends blocks to a chain that was going to
 * get them anyway, touches no configuration, and cannot disturb another run
 * sharing the stack. That is what makes it safe to do from a test, unlike
 * restarting the stack (whose settings are passed inline and would be lost).
 *
 * Note for anyone reading a results table: a scenario that only passes because
 * something mined by hand is a real operational caveat, not an implementation
 * detail. Every call site here says out loud why it needs a block.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** How long a single `regtest.mjs mine` may take. Generous — it shells out to bitcoin-cli in a container. */
const MINE_TIMEOUT_MS = 120_000

/**
 * Locate the arkade-regtest checkout.
 *
 * `ARKADE_REGTEST_DIR` wins. Otherwise the sibling-directory layout
 * `docs/runbook.md` assumes (`git clone ... && cd arkade-regtest` next to this
 * repo) is searched for by walking UP from the working directory — which
 * matters because e2e runs happen inside `.claude/worktrees/<name>`, several
 * levels below the checkout the runbook's `../arkade-regtest` is written
 * relative to.
 */
export const regtestDir = (): string => {
  const configured = process.env.ARKADE_REGTEST_DIR
  if (configured) {
    if (!existsSync(join(configured, 'regtest.mjs'))) {
      throw new Error(`ARKADE_REGTEST_DIR=${configured} has no regtest.mjs in it`)
    }
    return configured
  }
  let at = resolve(process.cwd())
  for (;;) {
    const candidate = join(at, 'arkade-regtest')
    if (existsSync(join(candidate, 'regtest.mjs'))) return candidate
    const parent = dirname(at)
    if (parent === at) break
    at = parent
  }
  throw new Error(
    [
      'cannot find an arkade-regtest checkout to mine from.',
      `Looked for an "arkade-regtest/regtest.mjs" in every parent of ${process.cwd()}.`,
      'Set ARKADE_REGTEST_DIR to the checkout, or clone it beside this repo as docs/runbook.md describes.',
    ].join('\n'),
  )
}

/**
 * Mine `count` blocks now.
 *
 * @returns the chain tip height afterwards, read back from Esplora so a caller
 * can assert the chain actually moved rather than trusting the CLI's exit code.
 */
export const mineBlocks = async (count = 1): Promise<number | null> => {
  await run(process.execPath, ['regtest.mjs', 'mine', String(count)], {
    cwd: regtestDir(),
    timeout: MINE_TIMEOUT_MS,
  })
  const { chainTip } = await import('./preflight.js')
  return chainTip()
}
