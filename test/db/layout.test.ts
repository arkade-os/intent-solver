import { describe, it, expect } from 'vitest'
import { resolveDbLayout, suffixed } from '@arkade-os/solver-corridors/db/layout.js'

/** A filesystem described as a set of paths that exist. */
const fs = (...present: string[]) => {
  const set = new Set(present)
  return (path: string) => set.has(path)
}

const BASE = '/data/swaps.sqlite'

describe('suffixed', () => {
  it('splices the suffix in before .sqlite', () => {
    expect(suffixed(BASE, 'onchain')).toBe('/data/swaps-onchain.sqlite')
    expect(suffixed(BASE, 'onchain-receive')).toBe('/data/swaps-onchain-receive.sqlite')
  })

  it('appends when the path has no .sqlite extension', () => {
    expect(suffixed('/data/swaps', 'admin')).toBe('/data/swaps-admin')
  })

  // The runbook publishes these exact names as what an operator must back up.
  it('produces the five names the runbook documents', () => {
    expect([
      BASE,
      suffixed(BASE, 'onchain'),
      suffixed(BASE, 'receive'),
      suffixed(BASE, 'onchain-receive'),
      suffixed(BASE, 'admin'),
    ]).toEqual([
      '/data/swaps.sqlite',
      '/data/swaps-onchain.sqlite',
      '/data/swaps-receive.sqlite',
      '/data/swaps-onchain-receive.sqlite',
      '/data/swaps-admin.sqlite',
    ])
  })
})

describe('resolveDbLayout', () => {
  it('consolidates a fresh install — nothing on disk at all', () => {
    const layout = resolveDbLayout(BASE, fs())
    expect(layout.consolidated).toBe(true)
    expect([layout.send, layout.onchainSend, layout.receive, layout.onchainReceive, layout.admin]).toEqual(
      Array(5).fill(BASE),
    )
  })

  // The swap file alone is not evidence of the split layout: the consolidated
  // layout writes that same path. Reading it as "legacy" would strand a
  // consolidated deployment's four other corridors in files nobody writes.
  it('still consolidates when only the swap file exists', () => {
    expect(resolveDbLayout(BASE, fs(BASE)).consolidated).toBe(true)
  })

  it('keeps the split layout when the legacy files are there', () => {
    const layout = resolveDbLayout(BASE, fs(BASE, '/data/swaps-onchain.sqlite', '/data/swaps-receive.sqlite'))
    expect(layout.consolidated).toBe(false)
    expect(layout.onchainSend).toBe('/data/swaps-onchain.sqlite')
    expect(layout.receive).toBe('/data/swaps-receive.sqlite')
    // Named even though absent — this deployment is legacy, so the corridor
    // that has not run yet still belongs in its own file rather than being
    // quietly folded into the swap file beside rows written the other way.
    expect(layout.onchainReceive).toBe('/data/swaps-onchain-receive.sqlite')
  })

  // A deployment that only ever ran one non-Lightning corridor still has just
  // one suffixed file. Treating that as fresh would move its rows out of view.
  it.each([
    ['/data/swaps-onchain.sqlite'],
    ['/data/swaps-receive.sqlite'],
    ['/data/swaps-onchain-receive.sqlite'],
    ['/data/swaps-admin.sqlite'],
  ])('treats a single legacy file (%s) as the split layout', (legacyFile) => {
    expect(resolveDbLayout(BASE, fs(BASE, legacyFile)).consolidated).toBe(false)
  })

  // A corridor with no previous release has no file it "already has", so the
  // split layout has nothing to preserve for it. Naming a suffixed EVM file
  // would invent one for an operator to find, back up, and later consolidate.
  it('keeps the EVM tables in the swap file even in the split layout', () => {
    const legacy = resolveDbLayout(BASE, fs(BASE, '/data/swaps-onchain.sqlite'))
    expect(legacy.consolidated).toBe(false)
    expect([legacy.evmSend, legacy.evmReceive]).toEqual([BASE, BASE])
    // And it is not merely following `send`, which happens to equal BASE too.
    const custom = resolveDbLayout('/srv/x.sqlite', fs('/srv/x-admin.sqlite'))
    expect(custom.evmSend).toBe('/srv/x.sqlite')
  })

  it('follows a custom SWAP_DB_PATH', () => {
    const custom = '/srv/solver/state.sqlite'
    expect(resolveDbLayout(custom, fs('/srv/solver/state-admin.sqlite')).admin).toBe('/srv/solver/state-admin.sqlite')
    expect(resolveDbLayout(custom, fs()).admin).toBe(custom)
  })
})
