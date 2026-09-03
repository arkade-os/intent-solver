import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compiledFilesUnder, externalImports, typeOnlyImports } from './support/importScan.js'

/**
 * The runtime image is built with `pnpm prune --prod`
 * (`packages/solver-app/Dockerfile`), so a devDependency imported from the
 * app's `src/` compiles and typechecks fine, ships in `dist/`, and then dies
 * with ERR_MODULE_NOT_FOUND the first time the container reaches that import.
 * It happened once: `@scure/bip39`.
 *
 * CI could not see it. The docker job does run the image, but only
 * `cli.js help`, and the Nostr codec is behind a dynamic import — `cli.js`
 * loading cleanly proves nothing about the modules it reaches later. This
 * closes that gap statically.
 *
 * Known limit: this compares against `package.json` rather than resolving,
 * and it truncates specifiers to their package root, so it proves the
 * package survives the prune — not that a subpath (`nostr-tools/pure`)
 * exists. Importing every built module inside the pruned image would cover
 * both; see the note in the PR.
 */

// fileURLToPath, not .pathname: on Windows a URL's pathname keeps a leading
// `/` before the drive letter (`/C:/...`), which fs functions mishandle into
// a doubled `C:\C:\...` — fileURLToPath does the platform-correct conversion.
const APP = new URL('../packages/solver-app/', import.meta.url)
const SRC = fileURLToPath(new URL('src/', APP))

describe('packaging', () => {
  /**
   * Checked against the APP's own manifest, not the workspace root's.
   *
   * The root is `private: true` and never installed anywhere; what the image
   * carries is `packages/solver-app` and its declared dependency closure. A
   * package the app imports but only the root declares would still resolve in
   * a local checkout — node walks up into the root `node_modules` — and would
   * be a coin flip in the pruned image. Reading the app manifest makes the
   * guard say what it means.
   */
  it("imports nothing from the app's src/ that `pnpm prune --prod` would delete", () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', APP), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >
    const production = new Set(Object.keys(manifest.dependencies ?? {}))
    const dev = new Set(Object.keys(manifest.devDependencies ?? {}))

    const offenders = compiledFilesUnder(SRC).flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      const erased = typeOnlyImports(source)
      return externalImports(source)
        .filter((pkg) => !production.has(pkg) && !erased.has(pkg))
        .map((pkg) => `${file.slice(SRC.length)} imports ${pkg}${dev.has(pkg) ? ' (devDependency)' : ' (undeclared)'}`)
    })
    expect(offenders).toEqual([])
    // 30s, not the 5s default: this reads and parses every compiled file under
    // src/ synchronously, which is ~250ms alone but has been seen to take 7.5s
    // when the full suite runs it alongside 145 other files. A guard that goes
    // red on scheduling luck teaches people to re-run rather than to read it.
  }, 30_000)

  /**
   * The same prune, one layer down.
   *
   * The guard above reads the app's manifest, which is the right question to
   * ask of the app and cannot see past it. The image copies every
   * `packages/*` and prunes ONCE, at the root — so a LIBRARY package that
   * imports something the prune deletes dies with the identical
   * ERR_MODULE_NOT_FOUND, and no amount of correctness in the app's manifest
   * prevents it.
   *
   * `@arkade-os/swap` was undeclared in `solver-arkade` exactly this way: a
   * value import of `offerVtxoScript` that resolved in a checkout, because
   * node walks up into the root's `node_modules`, and vanished in the image,
   * because the root held it as a devDependency. Nothing caught it — the
   * app's own imports of that package are type-only, so the guard above is
   * honestly green while `packages/solver-arkade/dist` cannot load.
   *
   * Checked against the package's OWN manifest and nothing else, which is
   * strictly more than the image needs and exactly what PUBLISHING needs.
   *
   * The weaker question — "does it survive the prune" — would also pass by
   * counting the root's production dependencies, because the image prunes once
   * at the root and node resolution walks up. That is how sixty imports across
   * six packages resolved by accident for as long as they did: `solver-core`
   * declared nothing while importing `zod`, `@noble/hashes` and
   * `light-bolt11-decoder`, and every one of them was found in the root's
   * `node_modules`.
   *
   * A CONSUMER HAS NO ROOT TO WALK UP INTO. `npm i @arkade-os/solver-core`
   * gets that package's `dependencies` and stops, so each of those sixty was
   * an ERR_MODULE_NOT_FOUND waiting for the first person to install it — and
   * `release.yml`'s `publish --dry-run` would not have caught one, because
   * packing a manifest says nothing about what the code inside it imports.
   * Asking each package alone is what makes that dry-run mean something.
   */
  it('declares, in every library package, everything that package imports', () => {
    const PACKAGES = new URL('../packages/', import.meta.url)

    const names = readdirSync(fileURLToPath(PACKAGES), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // The app is the deployable, covered above against its own manifest.
      .filter((name) => name !== 'solver-app')

    // A non-empty list is the assertion's precondition: a read that silently
    // matched nothing would pass this test while checking no package at all.
    expect(names.length).toBeGreaterThan(0)

    const offenders = names.flatMap((name) => {
      const dir = new URL(`${name}/`, PACKAGES)
      const manifest = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >
      const resolvable = new Set([...Object.keys(manifest.dependencies ?? {})])
      const src = fileURLToPath(new URL('src/', dir))
      return compiledFilesUnder(src).flatMap((file) => {
        const source = readFileSync(file, 'utf8')
        const erased = typeOnlyImports(source)
        return externalImports(source)
          .filter((pkg) => !resolvable.has(pkg) && !erased.has(pkg))
          .map((pkg) => `${name}/${relative(src, file).replace(/\\/g, '/')} imports ${pkg}, which it does not declare`)
      })
    })
    expect(offenders).toEqual([])
  }, 30_000)

  /**
   * The app is the DEPLOYABLE, and the one package in the workspace that must
   * never enter the publish matrix.
   *
   * `release.yml` publishes with `pnpm -r --filter './packages/*'`, which is a
   * glob over the directory rather than a hand-kept list — so a new package
   * joins the matrix by existing. `private: true` is what keeps this one out,
   * and nothing else would notice its removal until a release shipped an image
   * to npm as a library. It also has no `exports` map on purpose: nothing
   * imports it, the Dockerfile runs `dist/cli.js` by path.
   */
  it('keeps the app out of the publish matrix', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', APP), 'utf8')) as Record<string, unknown>
    expect(manifest.private).toBe(true)
    expect(manifest.exports).toBeUndefined()
  })
})

/**
 * The exemption above is the only part of this guard that can turn a real
 * ERR_MODULE_NOT_FOUND into a pass, so it is pinned in both directions rather
 * than trusted. The cases that matter are the ones that LOOK type-only and are
 * not.
 */
describe('the type-only exemption', () => {
  it.each([
    ['import type { T } from', "import type { Offer } from '@arkade-os/swap'"],
    ['inline type specifiers', "import { type Offer, type Deposit } from '@arkade-os/swap'"],
    ['export type ... from', "export type { Offer } from '@arkade-os/swap'"],
    ['inline type re-export', "export { type Offer } from '@arkade-os/swap'"],
  ])('exempts %s, which tsc erases', (_label, source) => {
    expect(typeOnlyImports(source).has('@arkade-os/swap')).toBe(true)
  })

  it.each([
    ['a value import', "import { onchainHtlcScript } from '@arkade-os/swap'"],
    ['a default import', "import swap from '@arkade-os/swap'"],
    ['a namespace import', "import * as swap from '@arkade-os/swap'"],
    ['a side-effect import', "import '@arkade-os/swap'"],
    ['a mixed default + type', "import swap, { type Offer } from '@arkade-os/swap'"],
    ['a star re-export', "export * from '@arkade-os/swap'"],
    ['an empty named import', "import {} from '@arkade-os/swap'"],
  ])('does NOT exempt %s, which ships', (_label, source) => {
    expect(typeOnlyImports(source).has('@arkade-os/swap')).toBe(false)
  })

  it('does not exempt a package imported as a type here and a value there', () => {
    // The value import is what ships, so one anywhere in the file is decisive.
    const source = [
      "import type { Offer } from '@arkade-os/swap'",
      "import { onchainHtlcScript } from '@arkade-os/swap'",
    ].join('\n')
    expect(typeOnlyImports(source).has('@arkade-os/swap')).toBe(false)
  })

  it('keeps the subpath truncation, so a type-only subpath exempts its root', () => {
    expect(typeOnlyImports("import type { A } from '@arkade-os/swap/offers'").has('@arkade-os/swap')).toBe(true)
  })

  it('ignores relative and node: specifiers', () => {
    const source = ["import type { A } from './local.js'", "import type { B } from 'node:fs'"].join('\n')
    expect(typeOnlyImports(source).size).toBe(0)
  })
})
