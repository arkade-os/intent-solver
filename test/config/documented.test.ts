/**
 * Every setting the config document can hold is documented in the README.
 *
 * A setting nobody wrote down is a setting nobody sets, and on this service the
 * unset ones are not neutral: they are the corridor fees, the exposure cap and
 * the spend-on-its-own switch. `POOL_AUTO_MINT` went undocumented through
 * several releases while doing exactly what its name says.
 *
 * Asserted against the README's own text, from the tables the loader itself
 * uses, so adding a setting without a row fails here.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { CORRIDOR_FIELDS, EVM_FIELDS, PATHS } from '@arkade-os/solver-app/config/knobs.js'

const root = fileURLToPath(new URL('../..', import.meta.url))
const readme = readFileSync(join(root, 'README.md'), 'utf8')

/** Each path as the README writes it, backticked; a family member under a placeholder or a concrete key. */
const documentedPaths = (): string[] => [
  ...PATHS.map(([path]) => path),
  'offers.markets',
  ...[...new Set(Object.values(CORRIDOR_FIELDS).flat())].map((field) => `corridors["<pair>"].${field}`),
  ...Object.keys(EVM_FIELDS).map((field) => `rails.evm.<chain>.${field}`),
  ...['kind', 'chain', 'address', 'decimals', 'priceFeed', 'pricePath', 'assetId', 'approvalThreshold'].map(
    (field) => `assets.<label>.${field}`,
  ),
  'rails.lightning.<rail>',
]

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const documented = (path: string): boolean => {
  const placeholder = /^(corridors\["<pair>"\]|assets\.<label>)(\..+)$/.exec(path)
  if (!placeholder) return readme.includes(`\`${path}\``)
  const [, family, field] = placeholder
  const key = family!.startsWith('corridors') ? 'corridors\\["[^"]+"\\]' : 'assets(?:\\.[^.`]+|\\["[^"]+"\\])'
  return new RegExp(`\`${key}${escape(field!)}\``).test(readme)
}

describe('README documents every setting', () => {
  it('leaves no path the document accepts undocumented', () => {
    const undocumented = documentedPaths().filter((path) => !documented(path))
    expect(undocumented, `undocumented in README.md: ${undocumented.join(', ')}`).toEqual([])
  })

  it('finds the settings it is meant to be checking', () => {
    // Guards the guard: a table that silently shrank would make the check above pass by knowing nothing.
    expect(documentedPaths().length).toBeGreaterThan(80)
    for (const path of ['network', 'rails.arkade.mnemonic', 'limits.maxExposedSats', 'rails.arkade.poolAutoMint']) {
      expect(documentedPaths()).toContain(path)
    }
  })

  it('documents how the document is supplied', () => {
    for (const variable of ['SOLVER_CONFIG', 'SOLVER_CONFIG_JSON']) expect(readme).toContain(`\`${variable}\``)
  })
})
