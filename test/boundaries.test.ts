import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compiledFilesUnder, externalImports, localImports } from './support/importScan.js'

// fileURLToPath, not .pathname: on Windows a URL's pathname keeps a leading `/`
// before the drive letter, which fs functions mishandle into a doubled path.
const PACKAGES = fileURLToPath(new URL('../packages/', import.meta.url))
const APP_SRC = fileURLToPath(new URL('../packages/solver-app/src/', import.meta.url))
const REPO = fileURLToPath(new URL('../', import.meta.url))

/**
 * The layer each top-level directory of the APP's `src/` belongs to, and what
 * that layer may import.
 *
 * This is the target topology from the SDK spec §3, asserted BEFORE the packages
 * exist. Encoding it as a test rather than waiting for tsconfig project
 * references is the whole point of the spec's guard-first sequencing: the
 * physical split is only mechanical if no illegal edge is left to discover.
 */
type Layer = 'core' | 'rail' | 'arkade' | 'corridor' | 'transport' | 'admin' | 'node'

const LAYER_OF: Record<string, Layer> = {
  core: 'core',
  db: 'corridor',
  util: 'core',
  invoice: 'core',
  price: 'core',
  wire: 'corridor',
  ln: 'rail',
  onchain: 'rail',
  arkade: 'arkade',
  corridors: 'corridor',
  send: 'corridor',
  receive: 'corridor',
  ingress: 'transport',
  relay: 'transport',
  http: 'transport',
  admin: 'admin',
  ops: 'node',
}

/** Which layers each layer may import FROM. A layer may always import itself. */
const MAY_IMPORT: Record<Layer, readonly Layer[]> = {
  core: [],
  rail: ['core'],
  arkade: ['core'],
  corridor: ['core', 'rail', 'arkade'],
  transport: ['core', 'corridor'],
  /**
   * The console may reach the whole stack, and that is the RULE changing rather
   * than the code being excused.
   *
   * The SDK spec opened with "solver-admin may not import a corridor", recorded
   * as an assumption nobody had confirmed. Examined against what the three
   * edges actually were, it does not hold:
   *
   * - `admin -> node` is the console invoking operator actions (`ops/refunds`,
   *   `ops/claims`, `ops/pool`, `ops/float`). `ops/pool.ts` notes the console
   *   "runs INSIDE the provider process, so its reservations are the ones this
   *   process holds" — an interface between a UI and the process it is embedded
   *   in buys nothing and costs a translation layer per action.
   * - `admin -> corridor` is partly the console's own settings-DB driver and
   *   partly `descriptorFor`, because the console RENDERS corridors. A console
   *   that lists corridors must be handed corridors.
   * - `admin -> transport` is two type-only imports about ad publishing.
   *
   * So `solver-admin` is not a separate package: it ships inside `solver-node`,
   * which is what it already is in every deployment.
   *
   * Two narrowings stay worth doing on their own merits, neither about this
   * rule: hand the console a `CorridorReaderSet` rather than letting it import
   * `readerSetFromDeps`, and split `SqlDriver` (core) from `betterSqliteDriver`
   * (infrastructure) if a dependency-light `solver-core` is wanted at package
   * time — moving the driver wholesale into core would drag a NATIVE BINDING in
   * with it, which is worse than the edge it removes.
   */
  admin: ['core', 'corridor', 'transport', 'node'],
  node: ['core', 'rail', 'arkade', 'corridor', 'transport', 'admin'],
}

/**
 * Top-level files of the app's `src/`, which have no directory to key off.
 *
 * `config.ts` is `node`, not `core`, because that is what it currently IS:
 * it reads `process.env`, reads files off disk, and assembles every subsystem's
 * settings. Its non-core imports are two `import type`s (`arkade`, `relay`) and
 * the rail registry it validates `LN_BACKEND` against, so calling it `core`
 * would have recorded violations that describe a mislabel rather than a
 * coupling.
 *
 * The cost is that `node` may import anything, so this file is unconstrained by
 * the DAG. That is the honest state today. When `loadConfig` splits into core
 * primitives plus a composition half, the primitives half becomes `core` and
 * regains coverage.
 */
const ROOT_FILE_LAYER: Record<string, Layer> = {
  'cli.ts': 'node',
  'config.ts': 'node',
  'index.ts': 'node',
  'worker.ts': 'node',
}

/**
 * Edges that exist today and are not yet legal, as `importer -> imported`
 * LAYER pairs.
 *
 * A ratchet, not an exemption list: the test fails if an edge appears that is
 * not here, AND fails if an edge here no longer occurs. The second half is what
 * makes it shrink — a migration that fixes a violation must delete its line, so
 * the list cannot quietly outlive the problem it records.
 */
/**
 * EMPTY, and it got here by shrinking — never by widening to accommodate a
 * change. It began at eight.
 *
 * Five were inverted: `rail -> arkade` (the preimage bridge moved to core),
 * `corridor -> admin` (corridors project their own rows), `corridor ->
 * transport` (corridors own their RFQ handling), `arkade -> corridor`
 * (corridors report their own lockups), `core -> corridor` (shared paging,
 * market vocabulary and the RFQ protocol moved to core).
 *
 * Three were RETIRED by fixing the rule instead: the `admin -> *` edges — see
 * `MAY_IMPORT.admin` above for why the rule was wrong rather than the code.
 * That distinction matters. Emptying a ratchet by relaxing the DAG is how a
 * guard becomes decoration, so the reasoning lives beside the rule it changed
 * and not here.
 *
 * A new entry is a debt, not a permission. The test fails on an unrecorded edge
 * AND on a recorded one that no longer occurs, so this list cannot quietly
 * outlive what it records.
 */
const KNOWN_VIOLATIONS: readonly string[] = []

/**
 * Workspace packages, by directory, and the layer each one IS.
 *
 * A package is a whole layer, so every file under it carries that layer no
 * matter which subdirectory it sits in — `solver-core` holds `core/`, `util/`,
 * `invoice/` and `price/`, and `LAYER_OF` already called all four `core`.
 *
 * `solver-app` is deliberately ABSENT, and is the one package that is not a
 * layer: it is the composition root, and it still holds `admin/` beside
 * `ops/` — two layers the DAG distinguishes, with `admin -> node` the only
 * edge `MAY_IMPORT.admin` was written to permit. Naming it here would make
 * every file in it `node`, `node` may import anything, and the three `admin`
 * rules would stop being checked while the suite stayed green. `layerOf`
 * therefore keys it on its own subdirectories, exactly as it did when the same
 * tree was the repo root's `src/`.
 */
const PACKAGE_LAYER: Record<string, Layer> = {
  'solver-core': 'core',
  'solver-arkade': 'arkade',
  'solver-rails': 'rail',
  /**
   * `solver-rails-esplora` is classified `core` even though it does HTTP: the
   * layer question here is dependency DIRECTION, and in direction it is a leaf
   * — every onchain vendor adapter needs it, and it imports nothing of ours but
   * port types. It is the infrastructure slot this file's SqlDriver comment
   * already anticipated. Classifying it `rail` would make rail -> rail legal,
   * which is precisely what the vendor-package split exists to forbid: one
   * vendor must never reach another vendor's module, and a shared chain-read
   * client is not a vendor's module.
   */
  'solver-rails-esplora': 'core',
  /**
   * `solver-db` is classified `core` for the same reason as the esplora client
   * above: direction is what the layers measure, and it is a leaf — every
   * corridor's store needs a driver, and it imports nothing of ours but core's
   * `SqlDriver` port type. The `better-sqlite3` NATIVE BINDING it carries is
   * precisely why it is its own package rather than folded into `solver-core`
   * (see the SqlDriver note in `MAY_IMPORT.admin` above): a dependency-light
   * core keeps the binding out, and every dependent may still reach the driver.
   */
  'solver-db': 'core',
  'solver-rails-lnd': 'rail',
  'solver-rails-fake': 'rail',
  'solver-rails-evm': 'rail',
  'solver-corridors': 'corridor',
  'solver-corridors-evm': 'corridor',
  'solver-transport': 'transport',
}

/**
 * The layer each package SPECIFIER reaches, which is what makes the split
 * visible to this guard at all.
 *
 * Extracting a layer into a package turns every edge into it from a relative
 * path into a bare specifier, and `localImports` deliberately keeps only
 * relative ones. Left unhandled, the guard would go on passing while seeing
 * NOTHING — the 314 rewritten imports into `@arkade-os/solver-core` would simply stop
 * being checked, and the DAG that justified the split would be enforced by
 * nobody. A guard that silently stops looking is worse than no guard, because
 * its green is read as coverage.
 */
const LAYER_OF_SPECIFIER: Record<string, Layer> = {
  '@arkade-os/solver-core': 'core',
  '@arkade-os/solver-arkade': 'arkade',
  '@arkade-os/solver-rails': 'rail',
  '@arkade-os/solver-rails-esplora': 'core',
  '@arkade-os/solver-db': 'core',
  '@arkade-os/solver-rails-lnd': 'rail',
  '@arkade-os/solver-rails-fake': 'rail',
  '@arkade-os/solver-rails-evm': 'rail',
  '@arkade-os/solver-corridors': 'corridor',
  '@arkade-os/solver-corridors-evm': 'corridor',
  '@arkade-os/solver-transport': 'transport',
  /**
   * Nothing imports the app today — it is the deployable, and the Dockerfile
   * runs its `dist/cli.js` by path. The entry is here so that the day a package
   * DOES reach for it, the edge is measured rather than ignored: `node` sits
   * above every layer, so any inbound edge but `admin -> node` is a violation
   * and this is what makes it visible.
   */
  '@arkade-os/solver-app': 'node',
}

/**
 * Every compiled source file in the workspace: each package, the app included.
 *
 * Two directories must be excluded, and BOTH produce false results rather than
 * merely extra work:
 *
 * - `dist/`, because `compiledFilesUnder` matches any `.ts` and that includes
 *   emitted `.d.ts`. They duplicate every import in the tree, so the guard
 *   would report edges from build output nobody wrote.
 * - `node_modules/`, because pnpm gives each package its own, holding SYMLINKS
 *   back to its workspace dependencies. A recursive scan follows them, so
 *   `packages/solver-transport/node_modules/@arkade-os/solver-corridors/src/…` gets read
 *   as a transport file purely because of the prefix its path happens to
 *   carry. That reported `transport -> arkade` and `transport -> rail` — two
 *   edges that do not exist in any file anyone wrote, and which no amount of
 *   reading `packages/solver-transport/src/` would explain.
 *
 * The second one is the dangerous direction. A guard that invents violations
 * gets its list treated as noise, and the real entry is then read past.
 */
const workspaceSources = (): string[] =>
  compiledFilesUnder(PACKAGES).filter((file) => {
    const segments = file.split(/[\\/]/)
    return !segments.includes('dist') && !segments.includes('node_modules')
  })

const layerOf = (file: string): Layer | null => {
  // The app first, because it is under PACKAGES and is NOT one layer — see
  // `PACKAGE_LAYER`. Its subdirectories answer the question, exactly as they
  // did when this same tree was the repo root's `src/`.
  if (file.startsWith(APP_SRC)) {
    const segments = relative(APP_SRC, file).split(/[\\/]/)
    const top = segments[0]
    if (top === undefined) return null
    return (segments.length === 1 ? ROOT_FILE_LAYER[top] : LAYER_OF[top]) ?? null
  }
  if (file.startsWith(PACKAGES)) {
    const pkg = relative(PACKAGES, file).split(/[\\/]/)[0]
    return pkg === undefined ? null : (PACKAGE_LAYER[pkg] ?? null)
  }
  return null
}

describe('layer boundaries', () => {
  it('has a layer assignment for every directory and root file in the workspace', () => {
    const unassigned = workspaceSources()
      .filter((file) => layerOf(file) === null)
      .map((file) => relative(REPO, file).replace(/\\/g, '/'))
    expect([...new Set(unassigned)].sort()).toEqual([])
  }, 30_000)

  it('has no import that crosses a layer boundary the DAG forbids', () => {
    const found = new Set<string>()
    for (const file of workspaceSources()) {
      const from = layerOf(file)
      if (from === null) continue
      const source = readFileSync(file, 'utf8')
      for (const specifier of localImports(source)) {
        const target = resolve(dirname(file), specifier)
        const to = layerOf(target)
        if (to === null || to === from) continue
        if (MAY_IMPORT[from].includes(to)) continue
        found.add(`${from} -> ${to}`)
      }
      // The same question for edges that have become package specifiers. Once a
      // layer ships as a package, this is the ONLY form its inbound edges take.
      for (const specifier of externalImports(source)) {
        const to = LAYER_OF_SPECIFIER[specifier]
        if (to === undefined || to === from) continue
        if (MAY_IMPORT[from].includes(to)) continue
        found.add(`${from} -> ${to}`)
      }
    }
    const unexpected = [...found].filter((edge) => !KNOWN_VIOLATIONS.includes(edge)).sort()
    const stale = KNOWN_VIOLATIONS.filter((edge) => !found.has(edge)).sort()
    expect({ unexpected, stale }).toEqual({ unexpected: [], stale: [] })
  }, 30_000)
})

/**
 * Every exhaustive `Record<Corridor, …>` in the tree, by file.
 *
 * These are the tables the SDK spec §4.1 inverts. Each one is a compile-time
 * forcing function — `Record` over a closed union will not typecheck until a new
 * corridor answers it — so the count may only fall as each is replaced by a
 * REQUIRED descriptor field that forces the same question. A table removed
 * without its question being re-asked somewhere is a money-path regression, not
 * a cleanup, which is why this counts rather than merely forbidding.
 *
 * Three of the original four files are gone: `CORRIDOR_ENV_STEM`, `DELIVERED`,
 * `VOCABULARY` and `PAYOUT_RAIL` are now the required `envStem`, `states` and
 * `payoutRail` fields on `CorridorDescriptor`. What remains is `config.ts`,
 * whose nine are three fields on the EXPORTED `Config` type plus each reader's
 * return annotation and `as` cast — changing those changes a public shape, so
 * they land with the Corridor interface rather than here.
 *
 * These are OCCURRENCES, not distinct tables: `config.ts` declares three fields
 * and then repeats the type across each reader's return annotation and its
 * closing `as` cast.
 *
 * WHAT ACTUALLY FORCES THE ANSWER NOW, measured rather than assumed, twice.
 *
 * `config.ts`'s nine occurrences force NOTHING. They all sit behind
 * `Object.fromEntries(...) as Record<Corridor, …>`, and a cast suppresses the
 * very exhaustiveness error the table is credited with. That was confirmed by
 * adding a fifth member to `CORRIDORS` and reading the errors.
 *
 * The compile-time gate USED to be the exhaustive `switch (corridor)` in
 * `admin/routes/swaps.ts`. The corridor registry replaced both switches with a
 * lookup, so that gate is now GONE. Re-running the fifth-corridor probe
 * afterwards left exactly one typecheck error, in
 * `test/perf/swapThroughput.perf.ts` — an array that happens to be
 * corridor-count-sensitive. That is incidental, not a guard anyone designed,
 * and nothing may rely on it.
 *
 * So the ONLY deliberate gate today is the runtime registry-coverage test in
 * `test/corridors/registry.test.ts`, together with the descriptor-completeness
 * check beside it. Both were seen to fail on the probe. Neither may be deleted
 * without a replacement — they are all that stands between a new corridor and
 * an unanswered money-critical question.
 *
 * Prose is excluded by requiring the match NOT to follow a backtick. Every
 * mention in a doc comment in this tree is written as `Record<Corridor, …>`,
 * and no type position ever is — so the cheap discriminator is exact here,
 * where a comment-stripping parse would be a lot of machinery for the same
 * answer. It matters because the file that DEFINES the replacement necessarily
 * names what it replaces, and counting that would leave a permanent entry that
 * no migration could ever clear.
 */
const CORRIDOR_RECORD_CENSUS: Readonly<Record<string, number>> = {
  'packages/solver-app/src/config.ts': 9,
}

describe('the corridor record census', () => {
  it('matches the census exactly, so a table cannot be added or silently dropped', () => {
    // `Partial<Record<Corridor, …>>` is deliberately NOT counted: it is not
    // exhaustive, so it forces nothing and blocks nothing. registryCard.ts
    // already uses that form. A leading backtick means prose — see above.
    const pattern = /(?<!Partial<)(?<!`)Record<\s*Corridor\s*,/g
    const census: Record<string, number> = {}
    for (const file of workspaceSources()) {
      const matches = readFileSync(file, 'utf8').match(pattern)
      if (matches === null) continue
      census[relative(REPO, file).replace(/\\/g, '/')] = matches.length
    }
    expect(census).toEqual(CORRIDOR_RECORD_CENSUS)
  }, 30_000)
})
