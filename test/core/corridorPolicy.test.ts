import { describe, expect, it } from 'vitest'
import {
  CORRIDORS,
  FREE,
  feeSatsFor,
  giveSatsFor,
  isCorridor,
  payoutSatsFor,
  type Fee,
} from '@arkade-os/solver-core/core/corridorPolicy.js'
import { descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'

const ONCHAIN: Fee = { bps: 25, flatSats: 500 }
const LN: Fee = { bps: 10, flatSats: 0 }

describe('corridors', () => {
  it('covers exactly the four directional pairs the solver serves', () => {
    expect([...CORRIDORS].sort()).toEqual(
      [
        'arkade:BTC->lightning:BTC',
        'arkade:BTC->onchain:BTC',
        'lightning:BTC->arkade:BTC',
        'onchain:BTC->arkade:BTC',
      ].sort(),
    )
  })

  it('gives every corridor a distinct shell-legal env stem', () => {
    const stems = CORRIDORS.map((c) => descriptorFor(c).envStem)
    expect(new Set(stems).size).toBe(CORRIDORS.length)
    for (const stem of stems) expect(stem).toMatch(/^[A-Z][A-Z0-9_]*$/)
  })

  it('rejects a pair it does not serve', () => {
    expect(isCorridor('arkade:BTC->lightning:BTC')).toBe(true)
    expect(isCorridor('lightning:BTC->onchain:BTC')).toBe(false)
    expect(isCorridor('nonsense')).toBe(false)
  })
})

describe('feeSatsFor', () => {
  it('charges nothing when the fee is free — the behaviour every corridor had before', () => {
    expect(feeSatsFor(100_000, FREE)).toBe(0)
    expect(payoutSatsFor(100_000, FREE)).toBe(100_000)
  })

  it('adds the flat charge on top of the spread, not instead of it', () => {
    // 25bps of 100_000 = 250, plus the 500 flat.
    expect(feeSatsFor(100_000, ONCHAIN)).toBe(750)
  })

  it('rounds the spread UP, so the solver never eats the remainder', () => {
    // 10bps of 1001 = 1.001 sats. Rounded down this is 1 and the solver loses
    // the rest on every swap; the flat-fee case makes it worse, not better.
    expect(feeSatsFor(1001, LN)).toBe(2)
  })

  it('keeps the flat charge flat as the amount grows', () => {
    const small = feeSatsFor(10_000, ONCHAIN) - Math.ceil((10_000 * 25) / 10_000)
    const large = feeSatsFor(1_000_000, ONCHAIN) - Math.ceil((1_000_000 * 25) / 10_000)
    expect(small).toBe(500)
    expect(large).toBe(500)
  })
})

describe('payoutSatsFor', () => {
  it('reports a payout the flat fee has eaten, rather than clamping it to zero', () => {
    // 400 sats against a 500 sat flat fee is unquotable, and the caller has to
    // be able to see that. Clamping here would present it as a free swap.
    expect(payoutSatsFor(400, ONCHAIN)).toBeLessThanOrEqual(0)
  })
})

describe('giveSatsFor', () => {
  it('is the inverse of payoutSatsFor across a range, never short by a sat', () => {
    for (const fee of [FREE, LN, ONCHAIN]) {
      for (const payout of [1_000, 5_000, 12_345, 100_000, 999_999]) {
        const give = giveSatsFor(payout, fee)
        expect(payoutSatsFor(give, fee)).toBeGreaterThanOrEqual(payout)
      }
    }
  })

  it('does not overshoot — one sat less would not cover the payout', () => {
    for (const fee of [LN, ONCHAIN]) {
      for (const payout of [1_000, 12_345, 100_000]) {
        const give = giveSatsFor(payout, fee)
        expect(payoutSatsFor(give - 1, fee)).toBeLessThan(payout)
      }
    }
  })

  it('is the identity when the fee is free', () => {
    expect(giveSatsFor(50_000, FREE)).toBe(50_000)
  })
})
