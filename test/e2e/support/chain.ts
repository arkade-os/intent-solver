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

/** How long Esplora may lag bitcoind before a mined block is visible, and how often to re-ask. */
const INDEX_LAG_TIMEOUT_MS = 30_000
const INDEX_POLL_MS = 500

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
 * `null` when Esplora could not supply a baseline to compare against — the
 * blocks are still mined, they just cannot be verified from here.
 */
export const mineBlocks = async (count = 1): Promise<number | null> => {
  const { chainTip } = await import('./preflight.js')
  const before = await readTipWithin(chainTip, Date.now() + INDEX_LAG_TIMEOUT_MS, (tip) => tip !== null)
  await run(process.execPath, ['regtest.mjs', 'mine', String(count)], {
    cwd: regtestDir(),
    timeout: MINE_TIMEOUT_MS,
  })
  // Esplora indexes BEHIND bitcoind, so a tip read straight after the mine can
  // still be the one from before it — CI saw `mineBlocks(4)` return an unmoved
  // 105 and fail a deadline assertion on the indexer's lag rather than on the
  // miner. Bounded, and it cannot hide a dead miner: the tip is returned either
  // way, so a caller asserting the chain moved still fails.
  //
  // A null baseline is NOT a blip — it means Esplora stayed unreadable for the
  // whole poll above. Returning a height then would be a number no reader can
  // trust, since a lagging index can serve the pre-mine one; `null` says so.
  if (before === null) return null
  return readTipWithin(chainTip, Date.now() + INDEX_LAG_TIMEOUT_MS, (tip) => tip !== null && tip >= before + count)
}

const readTipWithin = async (
  chainTip: () => Promise<number | null>,
  deadline: number,
  enough: (tip: number | null) => boolean,
): Promise<number | null> => {
  let tip = await chainTip()
  while (!enough(tip) && Date.now() < deadline) {
    await new Promise((settle) => setTimeout(settle, INDEX_POLL_MS))
    tip = await chainTip()
  }
  return tip
}
