/**
 * Every covclaimd this repo names — the two documented bring-ups and the e2e
 * group that CI actually runs — must be one that can claim.
 *
 * `rc.4` cannot: it omits the `PrevArkTx` the emulator has required since
 * `v0.0.7`, and fails silently enough that a receive swap just stops. The
 * mechanism and the two log lines that name it are in `docs/runbook.md`
 * § covclaimd; this only holds the floor, in the three places it is written.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../..', import.meta.url))
const DOCS = ['README.md', 'docs/runbook.md']

/** Lowest covclaimd that attaches `PrevArkTx`, as `[major, minor, patch, rc]`. */
const FLOOR = [0, 0, 1, 5]

// The `-rc.N` is optional so a first stable tag reads as the release it is,
// rather than as no pin at all: absent, it sorts above every rc of that patch.
const PIN = /COVCLAIMD_IMAGE=ghcr\.io\/arkade-os\/covclaimd:v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?/g
/** A runnable bring-up, not the prose that discusses one: start of line, no `#`. */
const BRINGUP = /^node regtest\.mjs start\b/gm

const countIn = (pattern: RegExp) => (file: string) =>
  [...readFileSync(join(root, file), 'utf8').matchAll(pattern)].length

const TAG = /^ghcr\.io\/arkade-os\/covclaimd:v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/

const parse = (m: RegExpMatchArray): number[] => [
  ...m.slice(1, 4).map(Number),
  m[4] === undefined ? Infinity : Number(m[4]),
]

const docPins = (): { file: string; tag: string; version: number[] }[] =>
  DOCS.flatMap((file) => {
    const text = readFileSync(join(root, file), 'utf8')
    return [...text.matchAll(PIN)].map((m) => ({
      file,
      tag: m[0].split('=')[1] as string,
      version: parse(m),
    }))
  })

/** The tag CI runs. An empty string is a group that wants no covclaimd at all. */
const groupPins = (): { file: string; tag: string; version: number[] }[] => {
  const file = '.github/e2e-groups.json'
  const groups = JSON.parse(readFileSync(join(root, file), 'utf8')) as { covclaimdImage: string }[]
  return groups
    .filter((group) => group.covclaimdImage !== '')
    .map((group) => {
      const m = TAG.exec(group.covclaimdImage)
      if (!m) throw new Error(`${file}: unparseable covclaimdImage ${group.covclaimdImage}`)
      return { file, tag: group.covclaimdImage, version: parse(m) }
    })
}

const pins = () => [...docPins(), ...groupPins()]

const belowFloor = (version: number[]): boolean => {
  for (const [i, part] of version.entries()) {
    if (part !== FLOOR[i]) return part < (FLOOR[i] as number)
  }
  return false
}

describe('every covclaimd image this repo names', () => {
  // Counted against the bring-ups, not merely `> 0`: one command losing its pin
  // leaves the other to carry the version assertion, which then passes while the
  // stack it documents comes up with no covclaimd in it at all.
  it('is pinned on every documented bring-up', () => {
    const bringups = DOCS.map(countIn(BRINGUP)).reduce((a, b) => a + b, 0)
    expect(bringups).toBeGreaterThan(0)
    expect(DOCS.map(countIn(PIN)).reduce((a, b) => a + b, 0)).toBe(bringups)
  })

  // The group file is the pin that actually gates the nightly, and it is the one
  // that went stale. `e2eGroups.test.ts` only asks whether a group names an
  // image, never which.
  it('is pinned by the e2e group that runs the daemon', () => {
    expect(groupPins().length).toBeGreaterThan(0)
  })

  it('is never below the version that attaches PrevArkTx', () => {
    const stale = pins().filter((pin) => belowFloor(pin.version))
    expect(stale.map((pin) => `${pin.file}: ${pin.tag}`)).toEqual([])
  })
})
