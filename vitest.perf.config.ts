import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.js'

/**
 * Load-test-only config. A THIRD config rather than a flag on either of the
 * other two, because the benchmark must be reachable by exactly one command and
 * by no other.
 *
 * THREE INDEPENDENT THINGS KEEP IT OUT OF THE OTHER SUITES, and it wants all
 * three because the failure mode is expensive in both directions — a load test
 * that quietly joins CI wedges the pipeline, and one nobody can run rots.
 *
 *  - The file is named `*.perf.ts`, which cannot match the default include
 *    (`**\/*.{test,spec}.?(c|m)[jt]s?(x)`) that `pnpm test` collects with. This
 *    is the load-bearing one: it holds even for a bare `npx vitest`.
 *  - `dir` is `test/perf`, outside `vitest.e2e.config.ts`'s `test/e2e`, so
 *    `pnpm test:e2e` cannot see it either. (Exclude patterns resolve RELATIVE
 *    to `dir`, which has caught this repo out before — being outside the other
 *    suites' `dir` needs no exclude at all.)
 *  - `include` here names `*.perf.ts` explicitly, so this config collects the
 *    benchmark and nothing else that might later land in the same folder.
 *
 * `dir` also bounds collection to THIS checkout: a positional path on the
 * command line is a FILTER PATTERN, so it would match `.claude/worktrees/
 * <branch>/test/perf` too and run a second checkout's load test against the one
 * regtest stack.
 *
 * `--experimental-eventsource` for the reason `vitest.e2e.config.ts` spells
 * out — the Arkade SDK's contract watcher and periodic settle open an
 * EventSource, vitest's forks do not inherit the parent's flags, and without it
 * the wallets' vtxos quietly stop being renewed. It matters MORE here: this
 * suite stands up a hundred wallets, so a hundred watchers would be throwing
 * `EventSource is not defined` instead of watching.
 *
 * `singleFork: false` is inherited from the e2e config's reasoning rather than
 * the base config's: there is exactly one file here, so the two settings cannot
 * differ in effect, and matching the suite that also builds Arkade wallets is
 * the honest default if a second file is ever added.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      dir: 'test/perf',
      include: ['**/*.perf.ts'],
      fileParallelism: false,
      poolOptions: { forks: { singleFork: false, execArgv: ['--experimental-eventsource'] } },
    },
  }),
)
