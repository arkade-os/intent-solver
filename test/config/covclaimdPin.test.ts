/**
 * The covclaimd the docs tell an operator to start must be one that can claim.
 *
 * `rc.4` cannot: it omits the `PrevArkTx` the emulator has required since
 * `v0.0.7`, and fails silently enough that a receive swap just stops. The
 * mechanism and the two log lines that name it are in `docs/runbook.md`
 * § covclaimd; this only holds the floor, because the tag is written twice.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../..', import.meta.url))
const DOCS = ['README.md', 'docs/runbook.md']

/** Lowest covclaimd that attaches `PrevArkTx`, as `[major, minor, patch, rc]`. */
const FLOOR = [0, 0, 1, 5]

const PIN = /COVCLAIMD_IMAGE=ghcr\.io\/arkade-os\/covclaimd:v(\d+)\.(\d+)\.(\d+)-rc\.(\d+)/g

const pins = (): { file: string; tag: string; version: number[] }[] =>
  DOCS.flatMap((file) => {
    const text = readFileSync(join(root, file), 'utf8')
    return [...text.matchAll(PIN)].map((m) => ({
      file,
      tag: m[0].split('=')[1] as string,
      version: m.slice(1, 5).map(Number),
    }))
  })

const belowFloor = (version: number[]): boolean => {
  for (const [i, part] of version.entries()) {
    if (part !== FLOOR[i]) return part < (FLOOR[i] as number)
  }
  return false
}

describe('the documented covclaimd image', () => {
  // Without this the assertion below ranges over an empty list, and a renamed
  // variable reads as "every pin is fine" while pinning nothing.
  it('is pinned by the docs at all', () => {
    expect(pins().length).toBeGreaterThan(0)
  })

  it('is never below the version that attaches PrevArkTx', () => {
    const stale = pins().filter((pin) => belowFloor(pin.version))
    expect(stale.map((pin) => `${pin.file}: ${pin.tag}`)).toEqual([])
  })
})
