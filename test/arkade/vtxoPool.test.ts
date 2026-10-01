import { describe, expect, it } from 'vitest'
import { planPool, poolTarget, type PoolCoin } from '@arkade-os/solver-arkade/arkade/vtxoPool.js'

/** 25,000 x 6 and 100,000 x 4: rungs as a deployment derives them, far above dust. */
const TARGET = poolTarget(100_000, 300_000)
const FLOOR = 330

let serial = 0
const coin = (value: number, over: Partial<PoolCoin> = {}): PoolCoin => ({
  key: `coin${serial++}:0`,
  value,
  usable: value,
  hasAssets: false,
  renewalDue: false,
  ...over,
})
const coins = (count: number, value: number, over: Partial<PoolCoin> = {}) =>
  Array.from({ length: count }, () => coin(value, over))
const keepers = () => [...coins(6, 25_000), ...coins(4, 100_000)]
const total = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0)
const plan = (float: readonly PoolCoin[], over: Partial<Parameters<typeof planPool>[0]> = {}) =>
  planPool({
    coins: float,
    target: TARGET,
    maxCount: 64,
    maxInputs: 50,
    maxOutputs: 8,
    minOutput: FLOOR,
    maxAmount: -1,
    ...over,
  })

describe('poolTarget', () => {
  it('derives its concurrency from the exposure cap already configured', () => {
    expect(TARGET).toEqual([
      { size: 25_000, want: 6 },
      { size: 100_000, want: 4 },
    ])
  })

  it('never asks for zero pieces, however small the cap', () => {
    for (const rung of poolTarget(1_000_000, 1)) expect(rung.want).toBeGreaterThan(0)
  })
})

describe('planPool — splitting', () => {
  it('splits a single fat coin into pieces', () => {
    const fat = coin(1_000_000)
    const result = plan([fat])
    expect(result.inputs).toEqual([fat.key])
    expect(result.outputs.length).toBeGreaterThan(1)
    expect(result.reason).toMatch(/minting/)
  })

  it('leans small — more small pieces than large ones', () => {
    const outputs = plan([coin(1_000_000)]).outputs
    const small = outputs.filter((size) => size === 25_000).length
    expect(small).toBeGreaterThanOrEqual(outputs.filter((size) => size === 100_000).length)
  })

  it('says nothing needs doing when the pool already matches', () => {
    const result = plan(keepers())
    expect(result).toMatchObject({ inputs: [], outputs: [] })
    expect(result.reason).toMatch(/already matches/)
  })

  it('distinguishes an empty float from a satisfied one', () => {
    const result = plan([coin(400)])
    expect(result.outputs).toEqual([])
    expect(result.reason).toMatch(/fund the solver/)
  })

  it('has something to say about an empty wallet', () => {
    expect(plan([]).reason).toMatch(/nothing spendable/)
  })

  it('never plans more outputs than one transaction may carry', () => {
    expect(plan([coin(1_000_000)], { maxOutputs: 3 }).outputs).toHaveLength(3)
  })

  it('counts a coin toward the largest rung it can serve, and never cuts a keeper', () => {
    const large = coins(4, 100_000)
    const result = plan([...large, coin(500_000)])
    expect(result.inputs.some((key) => large.some((kept) => kept.key === key))).toBe(false)
    expect(result.outputs.slice(0, -1).every((size) => size === 25_000)).toBe(true)
  })

  it('never pushes the count past the ceiling', () => {
    const float = [...coins(62, 1_000), coin(1_000_000)]
    const result = plan(float)
    expect(result.outputs.length).toBeGreaterThan(0)
    expect(float.length - result.inputs.length + result.outputs.length).toBeLessThanOrEqual(64)
  })

  it('leaves a coin renewal is about to take to renewal', () => {
    expect(plan([coin(1_000_000, { renewalDue: true })]).outputs).toEqual([])
  })

  it('names renewal, not funding, when every loose coin is due', () => {
    const result = plan([coin(1_000_000, { renewalDue: true })])
    expect(result.reason).toMatch(/due for renewal/)
    expect(result.reason).not.toMatch(/fund the solver/)
  })

  it('never mints a piece above the per-output ceiling', () => {
    const result = plan([coin(300_000)], { maxAmount: 50_000 })
    expect(result.outputs.length).toBeGreaterThan(0)
    expect(result.outputs.every((amount) => amount <= 50_000)).toBe(true)
  })

  it('plans nothing under a ceiling below the smallest output arkd accepts', () => {
    expect(plan([coin(300_000)], { maxAmount: 0 }).outputs).toEqual([])
    expect(plan(coins(64, 4_000), { maxAmount: FLOOR - 1 }).outputs).toEqual([])
  })

  it('cuts a coin above the per-output ceiling into chunks under it', () => {
    const result = plan([coin(1_200_000)], { maxAmount: 500_000 })
    expect(result.outputs.every((amount) => amount <= 500_000)).toBe(true)
    expect(total(result.outputs)).toBe(1_200_000)
  })

  it('refuses a coin one transaction cannot cut under that ceiling', () => {
    const result = plan([coin(10_000_000)], { maxAmount: 500_000 })
    expect(result.outputs).toEqual([])
    expect(result.reason).toMatch(/per-output ceiling/)
  })

  it('never mints a rung below the smallest output arkd accepts', () => {
    const tiny = [
      { size: 250, want: 6 },
      { size: 1_000, want: 4 },
    ]
    const result = plan([coin(10_000)], { target: tiny })
    expect(result.outputs.length).toBeGreaterThan(0)
    expect(result.outputs.every((amount) => amount >= FLOOR)).toBe(true)
  })

  it('refuses a split whose chunks would fall under the floor', () => {
    const target = [
      { size: 400, want: 6 },
      { size: 1_000, want: 4 },
    ]
    expect(plan([coin(2_120)], { target, maxAmount: 500 }).outputs).toEqual([])
  })
})

describe('planPool — consolidating', () => {
  it('merges at the ceiling instead of calling the float the right shape', () => {
    const result = plan(coins(64, 4_000))
    expect(result.inputs).toHaveLength(50)
    expect(result.outputs.length).toBeLessThan(50)
    expect(result.reason).toMatch(/consolidating 50 of 64/)
  })

  it('leaves the keepers out of the merge', () => {
    const kept = keepers()
    const result = plan([...kept, ...coins(60, 2_000)])
    expect(result.inputs).toHaveLength(50)
    expect(result.inputs.some((key) => kept.some((keeper) => keeper.key === key))).toBe(false)
  })

  it('takes the soonest-expiring coins first', () => {
    const float = Array.from({ length: 80 }, (_, i) => coin(2_000, { expiresAtMs: (80 - i) * 1_000 }))
    const soonest = [...float].sort((a, b) => a.expiresAtMs! - b.expiresAtMs!).slice(0, 50)
    expect([...plan(float).inputs].sort()).toEqual(soonest.map((c) => c.key).sort())
  })

  it('never takes a coin renewal is about to take', () => {
    const due = coins(30, 2_000, { renewalDue: true })
    const result = plan([...due, ...coins(40, 2_000)])
    expect(result.inputs).toHaveLength(40)
    expect(result.inputs.some((key) => due.some((d) => d.key === key))).toBe(false)
  })

  it('does nothing when fewer than two coins are loose', () => {
    const result = plan([...coins(63, 2_000, { renewalDue: true }), coin(2_000)])
    expect(result.outputs).toEqual([])
    expect(result.reason).toMatch(/63 due for renewal/)
  })

  it('refuses a merge that would not shrink the count', () => {
    const dust = coins(2, 330, { usable: 0, hasAssets: true })
    const result = plan([...coins(62, 2_000, { renewalDue: true }), ...dust])
    expect(result.outputs).toEqual([])
    expect(result.reason).toMatch(/would not shrink/)
  })

  it('routes every asset onto one change output and keeps the pieces clean', () => {
    const float = [...coins(4, 1_000, { usable: 670, hasAssets: true }), ...coins(60, 2_000)]
    const result = plan(float)
    const spent = float.filter((c) => result.inputs.includes(c.key))
    expect(spent.some((c) => c.hasAssets)).toBe(true)
    expect(total(result.outputs) + FLOOR).toBe(total(spent.map((c) => c.value)))
    expect(result.reason).toMatch(/assets ride a 330 sat change/)
  })

  it('refuses a merge whose chunks would fall under the floor', () => {
    const result = plan([...coins(61, 2_000, { renewalDue: true }), ...coins(3, 200)], { maxAmount: 500 })
    expect(result.outputs).toEqual([])
    expect(result.reason).toMatch(/outside the operator's bounds/)
  })

  it('cuts the remainder under the per-output ceiling', () => {
    const result = plan([...keepers(), ...coins(60, 40_000)], { maxAmount: 500_000 })
    expect(result.inputs).toHaveLength(50)
    expect(result.outputs).toEqual([500_000, 500_000, 500_000, 500_000])
  })

  it('stops taking coins before their sum outgrows what the outputs may carry', () => {
    const result = plan(coins(64, 100_000), { maxAmount: 500_000 })
    expect(result.inputs).toHaveLength(35)
    expect(result.outputs.every((amount) => amount <= 500_000)).toBe(true)
  })
})

describe('every plan conserves its sats and respects its bounds', () => {
  it.each([
    ['a fat coin', [coin(1_000_000)], -1],
    ['fragments at the ceiling', coins(64, 4_000), -1],
    ['keepers and fragments', [...keepers(), ...coins(60, 2_000)], -1],
    ['asset dust in the merge', [...coins(4, 1_000, { usable: 670, hasAssets: true }), ...coins(60, 2_000)], -1],
    ['ceiling-bound chunks', [...keepers(), ...coins(60, 40_000)], 500_000],
    ['big coins under a ceiling', coins(64, 100_000), 500_000],
    ['a coin over the ceiling', [coin(1_200_000)], 500_000],
    ['a ceiling below every piece', coins(64, 4_000), 20_000],
    ['a ceiling below the large piece', [coin(300_000)], 50_000],
    ['a ceiling under twice the floor', coins(64, 400), 500],
  ] as const)('%s', (_name, float, maxAmount) => {
    const result = plan(float, { maxAmount })
    const spent = float.filter((c) => result.inputs.includes(c.key))
    const carrier = spent.some((c) => c.hasAssets) ? FLOOR : 0
    expect(result.outputs.length).toBeGreaterThan(0)
    expect(spent).toHaveLength(result.inputs.length)
    expect(spent.length).toBeLessThanOrEqual(50)
    expect(total(result.outputs) + carrier).toBe(total(spent.map((c) => c.value)))
    expect(result.outputs.length + (carrier > 0 ? 1 : 0)).toBeLessThanOrEqual(8)
    for (const amount of result.outputs) {
      expect(amount).toBeGreaterThanOrEqual(FLOOR)
      if (maxAmount >= 0) expect(amount).toBeLessThanOrEqual(maxAmount)
    }
  })
})
