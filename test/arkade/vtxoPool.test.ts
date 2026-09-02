import { describe, expect, it } from 'vitest'
import { planPool, poolTarget } from '@arkade-os/solver-arkade/arkade/vtxoPool.js'

/** Bitcoin's real limits: 500..1000 sats, exposure capped at 3x the max swap. */
const MAX_SATS = 1000
const MAX_EXPOSED = 3000
const TARGET = poolTarget(MAX_SATS, MAX_EXPOSED)

const plan = (spendable: readonly number[], over: Partial<Parameters<typeof planPool>[0]> = {}) =>
  planPool({ spendable, target: TARGET, maxCount: 64, maxOutputs: 8, dust: 330, ...over })

describe('poolTarget', () => {
  it('derives its concurrency from the exposure cap already configured', () => {
    // 3000/1000 = three max-size swaps in flight, so four whole pieces (one
    // spare) and eight quarter pieces to compose from.
    expect(TARGET).toEqual([
      { size: 250, want: 6 },
      { size: 1000, want: 4 },
    ])
  })

  it('never asks for zero pieces, however small the cap', () => {
    for (const rung of poolTarget(1_000_000, 1)) expect(rung.want).toBeGreaterThan(0)
  })
})

describe('planPool', () => {
  /**
   * The case the pool exists for. One coin means one reservation covers the
   * whole float, so the second concurrent swap is refused rather than queued.
   */
  it('splits a single fat coin into pieces', () => {
    const result = plan([10_000])
    expect(result.outputs.length).toBeGreaterThan(1)
    expect(result.reason).toMatch(/minting/)
  })

  it('leans small — more small pieces than large ones', () => {
    const outputs = plan([10_000]).outputs
    const small = outputs.filter((size) => size === 250).length
    const large = outputs.filter((size) => size === 1000).length
    expect(small).toBeGreaterThanOrEqual(large)
  })

  it('says nothing needs doing when the pool already matches', () => {
    const matched = [...Array(6).fill(250), ...Array(4).fill(1000)]
    const result = plan(matched)
    expect(result.outputs).toEqual([])
    expect(result.reason).toMatch(/already matches/)
  })

  /**
   * Distinct from "already matches", and the distinction is the point: an
   * operator reading "matches its target" on a nearly-empty solver would
   * conclude it is healthy.
   */
  it('distinguishes an empty float from a satisfied one', () => {
    const result = plan([400])
    expect(result.outputs).toEqual([])
    expect(result.reason).toMatch(/fund the solver/)
  })

  it('refuses to shred past the count ceiling', () => {
    const result = plan(Array(64).fill(250), { maxCount: 64 })
    expect(result.outputs).toEqual([])
    expect(result.reason).toMatch(/ceiling/)
  })

  it('never plans more outputs than one transaction may carry', () => {
    const result = plan([1_000_000], { maxOutputs: 3 })
    expect(result.outputs).toHaveLength(3)
  })

  it('leaves dust headroom rather than spending the float to the satoshi', () => {
    const outputs = plan([2_000], { dust: 330 }).outputs
    const minted = outputs.reduce((sum, size) => sum + size, 0)
    expect(minted).toBeLessThanOrEqual(2_000 - 330)
  })

  it('counts a coin toward the largest rung it can serve, not the smallest', () => {
    // Four whole-size coins satisfy the large rung; only the small rung is short.
    const result = plan(Array(4).fill(1000))
    expect(result.outputs.every((size) => size === 250)).toBe(true)
  })

  it('has something to say about an empty wallet', () => {
    const result = plan([])
    expect(result.outputs).toEqual([])
    expect(result.reason).toMatch(/nothing spendable/)
  })
})
