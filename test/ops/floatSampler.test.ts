import { describe, it, expect } from 'vitest'
import { onchainFloatSampler } from '@arkade-os/solver-app/ops/floatSampler.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const sampler = (over: Record<string, unknown> = {}) => {
  let clock = 1_000_000
  const reads: number[] = []
  let balance = { confirmedSats: 50_000 } as { confirmedSats: number; sharedWithLightning?: boolean }
  const stale: number[] = []
  const shared: number[] = []
  const it = onchainFloatSampler({
    getBalance: async () => {
      reads.push(clock)
      return balance
    },
    refreshAfterMs: 30_000,
    staleAfterMs: 120_000,
    onStale: (ageMs) => stale.push(ageMs),
    onSharedPool: () => shared.push(1),
    now: () => clock,
    ...over,
  })
  return {
    it,
    reads,
    stale,
    shared,
    tick: (ms: number) => (clock += ms),
    set: (next: { confirmedSats: number; sharedWithLightning?: boolean }) => (balance = next),
  }
}

/** Reading is what triggers fetching: a sampler nobody read holds nothing. */
const primed = async (over: Record<string, unknown> = {}) => {
  const s = sampler(over)
  s.it.read()
  await settle()
  return s
}

describe('onchainFloatSampler', () => {
  it('is null until the first read lands, and never blocks on it', async () => {
    const s = sampler()
    expect(s.it.read()).toBeNull()
    await settle()
    expect(s.it.read()).toEqual({ sats: 50_000, ageMs: 0 })
  })

  it('serves the held reading without refetching inside the refresh window', async () => {
    const s = await primed()
    s.tick(10_000)
    s.it.read()
    s.it.read()
    await settle()
    expect(s.reads).toHaveLength(1)
  })

  it('keeps serving past staleAfterMs rather than returning null', async () => {
    const s = await primed()
    s.tick(10 * 60 * 1000)
    expect(s.it.read()).toEqual({ sats: 50_000, ageMs: 10 * 60 * 1000 })
  })

  it('says so once per stale episode, not once per quote', async () => {
    const s = await primed()
    s.tick(10 * 60 * 1000)
    s.it.read()
    s.it.read()
    s.it.read()
    expect(s.stale).toHaveLength(1)
  })

  it('goes quiet again once a fresh reading lands', async () => {
    const s = await primed()
    s.tick(10 * 60 * 1000)
    s.it.read()
    await settle()
    s.it.read()
    expect(s.stale).toHaveLength(1)
    s.tick(10 * 60 * 1000)
    s.it.read()
    expect(s.stale).toHaveLength(2)
  })

  it('keeps the last reading when a fetch fails — better evidence than none', async () => {
    let fail = false
    const s = await primed({
      getBalance: async () => {
        if (fail) throw new Error('node down')
        return { confirmedSats: 50_000 }
      },
    })
    fail = true
    s.tick(60_000)
    s.it.read()
    await settle()
    expect(s.it.read()?.sats).toBe(50_000)
  })

  it('drops the reading on invalidate, refusing to admit against a spent balance', async () => {
    const s = await primed()
    expect(s.it.read()).not.toBeNull()
    s.it.invalidate()
    expect(s.it.read()).toBeNull()
  })

  it('ignores a balance read that started BEFORE the invalidation', async () => {
    let release!: (v: { confirmedSats: number }) => void
    const s = sampler({ getBalance: () => new Promise((resolve) => (release = resolve)) })
    s.it.read()
    s.it.invalidate()
    release({ confirmedSats: 50_000 })
    await settle()
    // Accepting it restores the PRE-withdrawal balance, dated fresh — which the
    // null check cannot catch, because the reading is no longer null.
    expect(s.it.read()).toBeNull()
  })

  it('recovers once a read that started after the invalidation lands', async () => {
    const s = await primed()
    s.it.invalidate()
    s.it.read()
    await settle()
    expect(s.it.read()?.sats).toBe(50_000)
  })

  it('announces a pool shared with lightning once, where the gate is only advisory', async () => {
    const s = sampler()
    s.set({ confirmedSats: 50_000, sharedWithLightning: true })
    s.it.read()
    await settle()
    s.it.read()
    s.tick(60_000)
    s.it.read()
    await settle()
    expect(s.shared).toHaveLength(1)
  })

  it('says nothing on a backend that keeps its own wallet, which every shipped one does', async () => {
    const s = await primed()
    s.it.read()
    expect(s.shared).toHaveLength(0)
  })
})
