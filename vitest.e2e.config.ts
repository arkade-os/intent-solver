import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.js'

/**
 * E2E-only config. Kept SEPARATE from `vitest.config.ts` so nothing here can
 * reach the unit suite CI runs — `pnpm test` never loads this file.
 *
 * The one thing it adds is `--experimental-eventsource` in the test fork.
 * Every `node` invocation in this repo that touches the Arkade SDK passes that
 * flag (see `package.json`'s `start`/`cli` scripts and every `docs/runbook.md`
 * command) because the SDK's own background machinery — the contract watcher
 * and the periodic settle — opens an EventSource. Vitest's forks do not
 * inherit the parent's flags, so without this the SDK logs
 *
 *   Subscription error: ReferenceError: EventSource is not defined
 *   Error during periodic settle: INVALID_INTENT_PROOF
 *
 * on every run, and the wallet's vtxos quietly stop being renewed — they drift
 * from `available` into `recoverable`, which then fails the next run's funding
 * precondition for reasons that have nothing to do with the code under test.
 * Running the e2e in the same runtime shape as production removes a whole
 * class of confusing local failures.
 *
 * Deliberately not added to the base config: an unrecognised Node flag is a
 * hard startup error, so putting it on the path CI takes would risk the entire
 * unit suite for no benefit — nothing under `test/` outside `test/e2e` builds
 * an Arkade wallet.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      // Narrower than the base config's `test`, and for the same reason it
      // exists: a positional `test/e2e` on the command line is a filter
      // PATTERN, so it also matches `.claude/worktrees/<branch>/test/e2e` and
      // runs another checkout's corridors against the one regtest stack. Two
      // wallets on one mnemonic tear each other down (docs/runbook.md), so
      // that is not merely slow — it is a suite that fails for reasons no test
      // in it owns.
      dir: 'test/e2e',
      // One fork PER FILE, run one at a time. The base config's `singleFork`
      // exists to stop better-sqlite3 handles being destructed against a dead
      // worker environment, which is a real hazard for the unit suite's many
      // short-lived databases — but it is the wrong shape here, because each
      // e2e file builds its own Arkade wallet and the SDK's ContractWatcher
      // and periodic settle keep polling AFTER `ArkadeContext.close()` (which
      // closes the SQLite executor and nothing else). Sharing one process
      // meant the previous file's orphaned watcher hitting a closed handle
      // ("The database connection is not open") and its settle racing the next
      // file's wallet ("VTXO_ALREADY_REGISTERED") — failures belonging to no
      // test in particular.
      //
      // A fork per file gives every corridor a clean process; `fileParallelism:
      // false` keeps them sequential, which matters independently: two wallets
      // on one mnemonic tear each other's backend connection down
      // (docs/runbook.md), and these tests share one regtest wallet.
      fileParallelism: false,
      poolOptions: { forks: { singleFork: false, execArgv: ['--experimental-eventsource'] } },
    },
  }),
)
