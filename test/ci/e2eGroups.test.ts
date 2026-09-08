import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A `test/e2e/*.e2e.test.ts` in no group runs nowhere and leaves every leg of
 * `e2e.yml` green. Under `test/` rather than `test/e2e/` so it needs no stack
 * and runs inside `ci.yml`, which is a merge gate; e2e is opt-in and stays so.
 */

// fileURLToPath, not .pathname: on Windows the latter keeps a leading `/`
// before the drive letter, which fs then doubles into `C:\C:\...`.
const E2E_DIR = fileURLToPath(new URL('../e2e/', import.meta.url))
const GROUPS_PATH = fileURLToPath(new URL('../../.github/e2e-groups.json', import.meta.url))

interface Group {
  name: string
  why: string
  profiles: string
  files: string[]
  mintAsset: boolean
  lnd: boolean
  covclaimd: boolean
  evmChain: boolean
  arkdTimelocks: 'seconds' | 'blocks'
}

const groups: Group[] = JSON.parse(readFileSync(GROUPS_PATH, 'utf8'))
const onDisk = readdirSync(E2E_DIR)
  .filter((name) => name.endsWith('.e2e.test.ts'))
  .sort()

describe('.github/e2e-groups.json', () => {
  it('covers every e2e file exactly once', () => {
    const claimed = groups.flatMap((group) => group.files)
    const duplicated = claimed.filter((file, index) => claimed.indexOf(file) !== index)
    expect(duplicated, 'a file in two groups runs against two stacks and is billed twice').toEqual([])
    expect(
      [...claimed].sort(),
      'every test/e2e/*.e2e.test.ts must name a group, and every group entry must exist',
    ).toEqual(onDisk)
  })

  it('gives every group a distinct name and a reason it is separate', () => {
    const names = groups.map((group) => group.name)
    expect(new Set(names).size).toBe(names.length)
    for (const group of groups) {
      expect(group.name, 'the matrix leg name').toMatch(/^[a-z][a-z0-9-]*$/)
      expect(group.profiles.length, `${group.name} names no arkade-regtest profile`).toBeGreaterThan(0)
      expect(group.files.length, `${group.name} is empty`).toBeGreaterThan(0)
      expect(group.why.length, `${group.name} does not say what forces it apart`).toBeGreaterThan(40)
    }
  })

  it('declares every stack flag the workflow branches on', () => {
    const flags = ['mintAsset', 'lnd', 'covclaimd', 'evmChain'] as const
    for (const group of groups) {
      // On EVERY group: an absent key reads as `null` in a matrix `if:`, which
      // is falsy and silent — the same shape as a flag someone forgot to set.
      for (const flag of flags) expect(typeof group[flag], `${group.name}.${flag}`).toBe('boolean')
      // Not a boolean, because the assert runs in both directions: each mode
      // has a file the other makes vacuous.
      expect(['seconds', 'blocks'], `${group.name}.arkdTimelocks`).toContain(group.arkdTimelocks)
    }
  })

  it('runs blockTimelocks, and only blockTimelocks, on a block-typed arkd', () => {
    const blockTyped = groups.filter((group) => group.arkdTimelocks === 'blocks')
    expect(blockTyped.flatMap((group) => group.files)).toContain('blockTimelocks.e2e.test.ts')
    expect(blockTyped.length, 'a second block-typed group buys a stack for nothing').toBe(1)
  })

  it('asks for covclaimd wherever a file needs it', () => {
    // Not a bare word match: four other files discuss covclaimd in prose —
    // receiveLightning's header exists to say it runs WITHOUT the daemon.
    const needsDaemon = (file: string) =>
      /createCovclaimdClient|covclaimdUrl|'covclaimd'/.test(readFileSync(join(E2E_DIR, file), 'utf8'))
    for (const group of groups) {
      if (group.files.some(needsDaemon)) {
        expect(group.covclaimd, `${group.name} runs a file that reaches for covclaimd`).toBe(true)
        expect(group.profiles, `${group.name} must bring the covclaimd profile up`).toContain('covclaimd')
      }
    }
  })
})
