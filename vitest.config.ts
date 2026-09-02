import { defineConfig } from 'vitest/config'

/**
 * One fork for the whole suite.
 *
 * better-sqlite3 is a NATIVE addon: each `Database` registers an environment
 * cleanup hook, and its destructor asserts that the environment still exists.
 * With a worker per file, a handle that reaches its destructor during worker
 * teardown — after the fork's Node environment is already gone — trips
 *
 *   node::RemoveEnvironmentCleanupHook … Assertion failed: (env) != nullptr
 *
 * which kills the worker mid-flight. Vitest then reports whatever it was
 * carrying as `Error: Channel closed` (ERR_IPC_CHANNEL_CLOSED) from tinypool
 * losing its child, so the visible failure names neither the database nor the
 * test that owned it.
 *
 * It is a race, so it lands on whichever run loses it rather than on the change
 * that caused it: it failed CI twice on a diff containing only a Dockerfile and
 * a CLI edit, while thirteen consecutive local runs passed. A test suite that
 * fails for reasons unrelated to the diff teaches everyone to re-run rather than
 * read, which is an expensive habit on a repo that moves money.
 *
 * A single fork means teardown happens once, after every `afterEach` has closed
 * its handles, so there is no live native object to destruct against a dead
 * environment. Measured cost of serialising: 8.5s -> 11.1s. Worth 2.6 seconds.
 *
 * The complementary half of this fix is closing handles deterministically —
 * `test/db/driver.test.ts` was leaking three per run and now closes them.
 */
export default defineConfig({
  /**
   * `examples/` imports the BUILT output (`../../dist/index.js`) because that
   * is what an integrator consumes. Under test it resolves to the source
   * instead, so a test may import an example without `pnpm build` having run —
   * CI builds AFTER the unit suite, so the alternative is a test that passes
   * locally and cannot pass in CI.
   *
   * Pointing at source is also the more honest target: a test that loaded
   * `dist/` would be asserting against whatever was built last, which on a
   * developer's machine is routinely not the working tree.
   */
  resolve: {
    alias: [
      { find: /^\.\.\/\.\.\/dist\/index\.js$/, replacement: new URL('src/index.ts', import.meta.url).pathname },
      /**
       * Workspace packages resolve to SOURCE under test, for the same reason
       * the `dist/index.js` alias above does: the unit suite runs BEFORE the
       * build in CI, so resolving a package through its `exports` map — which
       * points at `dist/` — would make every cross-package import depend on an
       * artifact that does not exist yet.
       */
      {
        find: /^@arkade-os\/solver-([a-z-]+)\/(.*)\.js$/,
        replacement: new URL('packages/solver-', import.meta.url).pathname + '$1/src/$2.ts',
      },
    ],
  },
  test: {
    /**
     * Collect from THIS repo's test tree and nowhere else.
     *
     * Vitest's default include is repo-wide (`**\/*.test.ts`), which is fine
     * until the checkout contains another checkout. A git worktree under
     * `.claude/worktrees/` is a full second copy of this repo, tests and all,
     * so the default glob collects every worktree's suite alongside our own —
     * one local run picked up 579 files instead of 64, and reported failures
     * from a stale branch nobody was working on as though they were ours.
     *
     * Bounding it here rather than in the scripts means a bare `npx vitest`
     * is scoped too, and that the positional path arguments the scripts used
     * to pass — which vitest treats as a FILTER PATTERN, not a directory, and
     * which therefore matched `.claude/worktrees/*\/test/e2e` just as happily
     * as `test/e2e` — are not needed at all.
     */
    dir: 'test',
    poolOptions: { forks: { singleFork: true } },
  },
})
