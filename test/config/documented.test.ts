/**
 * Every configuration option the code reads is documented in the README.
 *
 * A knob nobody wrote down is a knob nobody sets, and on this service the
 * unset ones are not neutral: they are the corridor fees, the exposure cap and
 * the spend-on-its-own switch. `POOL_AUTO_MINT` went undocumented through
 * several releases while doing exactly what its name says.
 *
 * Asserted against the README's own text rather than a hand-kept list, because
 * a hand-kept list is a third thing to forget. The env names are recovered the
 * way an operator would find them — reading the source — so adding a knob
 * without a row fails here.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../..', import.meta.url))
const readme = readFileSync(join(root, 'README.md'), 'utf8')

/**
 * Every `.ts` under the app's src/, so a knob added anywhere in it is caught,
 * not just in config.ts.
 *
 * The app is where env reading lives — it is the composition root, and every
 * other package is handed its settings. The one `process.env` elsewhere in
 * `packages/` is a default parameter in `solver-rails-evm` that names nothing.
 * This scanned the repo root's `src/` before that tree became a package and
 * covers exactly the same files; widening it to all of `packages/` would be a
 * change of scope, not of path.
 */
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })

/**
 * The env names the app's src/ reads, however it reads them:
 *  - `process.env.NAME` and `process.env['NAME']`
 *  - passed by name to a reader helper — `required('NAME')`, `intFromEnv('NAME', …)`
 *  - built from a corridor stem — `<STEM>_<SUFFIX>`, expanded below
 *  - `fileOrInline` pairs, which read `NAME` and `NAME_PATH`
 */
const CORRIDOR_STEMS = ['LN_SEND', 'LN_RECEIVE', 'ONCHAIN_SEND', 'ONCHAIN_RECEIVE']

const envNamesInSource = (): Set<string> => {
  const names = new Set<string>()
  for (const file of sourceFiles(join(root, 'packages', 'solver-app', 'src'))) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]+)|\['([A-Z][A-Z0-9_]+)'\])/g)) {
      names.add((m[1] ?? m[2]) as string)
    }
    for (const m of text.matchAll(/\b(required|intFromEnv|requiredBigintFromEnv)\(\s*'([A-Z][A-Z0-9_]+)'/g)) {
      names.add(m[2] as string)
    }
    // `resolveLndSecret(NAME)` reads BOTH `NAME` and `NAME_PATH` — inline or
    // from a file, exactly one of the two. Both are options an operator sets,
    // so both have to be written down.
    for (const m of text.matchAll(/\bresolveLndSecret\(\s*'([A-Z][A-Z0-9_]+)'/g)) {
      names.add(m[1] as string)
      names.add(`${m[1]}_PATH`)
    }
  }
  return names
}

/**
 * What the README documents, with `<CORRIDOR>_X` expanded to the four concrete
 * names — the README documents the family as a pattern on purpose, and that is
 * a real answer to "is this written down", not a gap.
 */
const documentedNames = (): Set<string> => {
  const names = new Set<string>()
  for (const m of readme.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) names.add(m[1] as string)
  for (const m of readme.matchAll(/<CORRIDOR>_([A-Z_]+)/g)) {
    for (const stem of CORRIDOR_STEMS) names.add(`${stem}_${m[1]}`)
  }
  return names
}

describe('README documents every config option', () => {
  it('leaves no env var the code reads undocumented', () => {
    const documented = documentedNames()
    const undocumented = [...envNamesInSource()].filter((name) => !documented.has(name)).sort()
    expect(undocumented, `undocumented in README.md: ${undocumented.join(', ')}`).toEqual([])
  })

  it('finds the knobs it is meant to be checking', () => {
    // Guards the guard: a regex that silently matched nothing would make the
    // assertion above pass by knowing about no options at all.
    const found = envNamesInSource()
    expect(found.size).toBeGreaterThan(20)
    // One name per SHAPE the regexes above recognise: `process.env.NAME`,
    // `required('NAME')`, `intFromEnv('NAME', …)` and the `resolveLndSecret`
    // pair. A shape that stopped matching would otherwise pass silently.
    for (const name of ['SWAP_NETWORK', 'ARK_MNEMONIC', 'MAX_EXPOSED_SATS', 'POOL_AUTO_MINT', 'LND_CERT_PATH']) {
      expect(found, `${name} should be discoverable in src/`).toContain(name)
    }
  })

  it('leaves no env var missing from .env.sample either', () => {
    // The README explains; the sample is the checklist you copy. A knob in one
    // and not the other is how an operator ends up with a config that starts
    // and then behaves in a way nothing told them about.
    const sample = readFileSync(join(root, '.env.sample'), 'utf8')
    const named = new Set<string>()
    for (const m of sample.matchAll(/^#?\s*([A-Z][A-Z0-9_]{2,})=/gm)) named.add(m[1] as string)
    for (const m of sample.matchAll(/<CORRIDOR>_([A-Z_]+)/g)) {
      for (const stem of CORRIDOR_STEMS) named.add(`${stem}_${m[1]}`)
    }
    // The cert/macaroon pairs are written as `NAME=  /  NAME_PATH=` prose.
    for (const m of sample.matchAll(/\b([A-Z][A-Z0-9_]+_PATH)\b/g)) named.add(m[1] as string)

    const missing = [...envNamesInSource()].filter((name) => !named.has(name)).sort()
    expect(missing, `missing from .env.sample: ${missing.join(', ')}`).toEqual([])
  })

  it('never ships a filled-in secret in the sample', () => {
    // The sample is committed. Every secret line must be empty or commented.
    const sample = readFileSync(join(root, '.env.sample'), 'utf8')
    for (const secret of ['ARK_MNEMONIC', 'PAYEE_MNEMONIC', 'LND_MACAROON']) {
      const assigned = sample.match(new RegExp(`^${secret}=(.*)$`, 'm'))
      expect(assigned?.[1] ?? '', `${secret} must ship empty`).toBe('')
    }
  })

  it('expands the per-corridor pattern rather than demanding twenty rows', () => {
    const documented = documentedNames()
    for (const stem of CORRIDOR_STEMS) {
      for (const suffix of [
        'MIN_SATS',
        'MAX_SATS',
        'FEE_BPS',
        'FEE_FLAT_SATS',
        'FEE_CAP_SATS',
        'FEE_MIN_SATS',
        'ENABLED',
      ]) {
        expect(documented).toContain(`${stem}_${suffix}`)
      }
    }
  })
})
