/**
 * Every module the operator scripts import actually exists.
 *
 * `scripts/*.mjs` are the incident-response tools — the Dockerfile ships them
 * for the reason its own comment gives: "reaching for one of these means an
 * incident is already underway, and an image that lacks them forces `docker cp`
 * into a container that may not permit it". They are plain `.mjs` that import
 * BUILT output by specifier, and nothing else in this repo does that.
 *
 * Which made them invisible. The workspace split moved `arkade/`, `db/`,
 * `core/` and `relay/` out of the root `dist/` and left five scripts importing
 * paths that no longer resolve — `regtest-settle.mjs` died on
 * ERR_MODULE_NOT_FOUND the first time it was needed. Typecheck did not see it
 * (these are `.mjs` importing emitted `.js`), the unit suite did not import
 * them, and CI does not run them. A green pipeline said nothing was wrong.
 *
 * This checks SOURCE rather than `dist/`, so it needs no build and fails at the
 * moment a file moves rather than the moment an operator reaches for it.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPTS = join(REPO, 'scripts')

/** Every import specifier in a script, static or dynamic. */
const specifiers = (source: string): string[] => [
  ...[...source.matchAll(/(?:^|\s)import\s[^'"]*from\s*'([^']+)'/gm)].map((m) => m[1] as string),
  ...[...source.matchAll(/\bimport\(\s*'([^']+)'/g)].map((m) => m[1] as string),
]

/**
 * Where a specifier's SOURCE lives, or null if it is a third-party package this
 * guard has no opinion about.
 *
 * Both forms map onto the same tree: `@arkade-os/solver-rails/ln/port.js` is emitted from
 * `packages/solver-rails/src/ln/port.ts`, and `../packages/solver-app/dist/config.js`
 * from `packages/solver-app/src/config.ts`.
 *
 * The second form is a PATH into a package's build output rather than a
 * specifier, and it is what these scripts actually use — plain `.mjs` reaching
 * for compiled output that no `exports` map has to admit. Matching any
 * `packages/<pkg>/dist/…` rather than only the app's brings
 * `regtest-watch-offers.mjs` under the guard too: it already used this shape,
 * resolved to null, and was therefore being checked by nobody.
 */
const sourceFor = (specifier: string): string | null => {
  const workspace = specifier.match(/^@arkade-os\/solver-([a-z-]+)\/(.+)\.js$/)
  if (workspace) return join(REPO, 'packages', `solver-${workspace[1]}`, 'src', `${workspace[2]}.ts`)
  const built = specifier.match(/^(?:\.\.\/)+packages\/(solver-[a-z-]+)\/dist\/(.+)\.js$/)
  if (built) return join(REPO, 'packages', built[1] as string, 'src', `${built[2] as string}.ts`)
  return null
}

const scriptFiles = readdirSync(SCRIPTS).filter((name) => name.endsWith('.mjs'))

describe('operator scripts import modules that exist', () => {
  it('finds scripts to check, so this cannot pass by checking nothing', () => {
    expect(scriptFiles.length).toBeGreaterThan(3)
  })

  it.each(scriptFiles)('%s imports nothing that has moved', (name) => {
    const source = readFileSync(join(SCRIPTS, name), 'utf8')
    const missing = specifiers(source)
      .map((specifier) => ({ specifier, path: sourceFor(specifier) }))
      .filter((entry) => entry.path !== null && !existsSync(entry.path))
      .map((entry) => entry.specifier)
    expect(missing, `${name} imports modules that no longer exist: ${missing.join(', ')}`).toEqual([])
  })

  /**
   * Guards the guard: `sourceFor` returning null for everything would make the
   * assertion above pass while resolving nothing at all.
   */
  it('resolves a meaningful number of specifiers rather than skipping them all', () => {
    const resolved = scriptFiles
      .flatMap((name) => specifiers(readFileSync(join(SCRIPTS, name), 'utf8')))
      .filter((specifier) => sourceFor(specifier) !== null)
    expect(resolved.length).toBeGreaterThan(5)
  })
})
