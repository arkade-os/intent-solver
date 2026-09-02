import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compiledFilesUnder, externalImports, typeOnlyImports } from './support/importScan.js'

/**
 * The runtime image is built with `pnpm prune --prod` (Dockerfile), so a
 * devDependency imported from `src/` compiles and typechecks fine, ships in
 * `dist/`, and then dies with ERR_MODULE_NOT_FOUND the first time the
 * container reaches that import. It happened once: `@scure/bip39`.
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
const SRC = fileURLToPath(new URL('../src/', import.meta.url))

describe('packaging', () => {
  it('imports nothing from src/ that `pnpm prune --prod` would delete', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<
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
