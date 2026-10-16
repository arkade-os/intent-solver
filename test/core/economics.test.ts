/**
 * `economicsOf`: the one subtraction every corridor's P&L goes through.
 *
 * The cases here are the ones where a wrong answer is INVISIBLE — a sign
 * flipped, a null collapsed to zero, a spread taken as a percentage of the
 * wrong leg. Each of those still renders as a perfectly convincing chart.
 */
import { describe, it, expect } from 'vitest'
import { bpsOf, clampLedgerLimit, economicsOf } from '@arkade-os/solver-core/analytics/economics.js'

const sats = (amount: number | null) => ({
  assetId: null,
  amount: amount === null ? null : String(amount),
  decimals: 8,
})
const token = (amount: string, assetId = 'usdt') => ({ assetId, amount, decimals: null })

const base = {
  id: 'swap-1',
  corridor: 'arkade:BTC->lightning:BTC',
  state: 'claimed',
  phase: 'done' as const,
  quotedAt: 1_000,
  settledAt: 1_090,
}

describe('economicsOf: a sats-to-sats swap', () => {
  it('keeps what came in minus what went out', () => {
    const record = economicsOf({ ...base, inbound: sats(100_300), outbound: sats(100_000) })
    expect(record.grossSats).toBe(300)
    expect(record.grossBps).toBe(29)
    expect(record.realized).toBe(true)
    expect(record.durationSeconds).toBe(90)
  })

  it('reports a NEGATIVE gross when the solver paid out more than it took', () => {
    const record = economicsOf({ ...base, inbound: sats(99_000), outbound: sats(100_000) })
    expect(record.grossSats).toBe(-1_000)
    expect(record.grossBps).toBeLessThan(0)
  })

  it('answers null, not zero, when the inbound leg was never funded', () => {
    const record = economicsOf({ ...base, inbound: sats(null), outbound: sats(100_000) })
    expect(record.grossSats).toBeNull()
    expect(record.grossBps).toBeNull()
    expect(record.rate).toBeNull()
  })
})

describe('economicsOf: a cross-asset swap', () => {
  it('has no sats spread of its own — the two legs are different units', () => {
    const record = economicsOf({ ...base, inbound: sats(100_000), outbound: token('50000000') })
    expect(record.grossSats).toBeNull()
  })

  it('takes the corridor-supplied spread when the corridor books one in sats', () => {
    const record = economicsOf({
      ...base,
      inbound: sats(100_000),
      outbound: token('50000000'),
      quotedSpreadSats: 400,
    })
    expect(record.grossSats).toBe(400)
    expect(record.grossBps).toBe(40)
  })

  it('refuses a bps figure when the INTAKE is not sats, however the spread was supplied', () => {
    const record = economicsOf({
      ...base,
      inbound: token('50000000'),
      outbound: sats(99_600),
      quotedSpreadSats: 400,
    })
    expect(record.grossSats).toBe(400)
    // 400 sats over 50,000,000 token base units is not a basis point of anything.
    expect(record.grossBps).toBeNull()
  })

  it('carries the executed rate as an exact ratio rather than a float', () => {
    const record = economicsOf({ ...base, inbound: sats(100_000), outbound: token('50000000') })
    expect(record.rate).toEqual({ numerator: '50000000', denominator: '100000' })
  })

  it('ignores a supplied spread on a sats-to-sats swap, where the legs already say it', () => {
    const record = economicsOf({ ...base, inbound: sats(100_300), outbound: sats(100_000), quotedSpreadSats: 9_999 })
    expect(record.grossSats).toBe(300)
  })
})

describe('economicsOf: what is at risk', () => {
  it('is null on a swap that delivered — nothing is outstanding', () => {
    expect(economicsOf({ ...base, inbound: sats(100_300), outbound: sats(100_000) }).atRiskSats).toBeNull()
  })

  it('is null on a refused swap, which never paid out', () => {
    const record = economicsOf({
      ...base,
      state: 'refused',
      phase: 'failed',
      inbound: sats(null),
      outbound: sats(100_000),
    })
    expect(record.atRiskSats).toBeNull()
  })

  it('is the payout on a lost swap: money went out and did not come back', () => {
    const record = economicsOf({
      ...base,
      state: 'stuck',
      phase: 'failed',
      inbound: sats(100_300),
      outbound: sats(100_000),
      lost: true,
    })
    expect(record.atRiskSats).toBe(100_000)
  })

  it('takes the corridor-supplied notional when the outbound leg is a token', () => {
    const record = economicsOf({
      ...base,
      state: 'stuck',
      phase: 'failed',
      inbound: sats(100_000),
      outbound: token('50000000'),
      exposureSats: 99_600,
      lost: true,
    })
    expect(record.atRiskSats).toBe(99_600)
  })

  it('answers null rather than zero for a lost token payout with no notional supplied', () => {
    const record = economicsOf({
      ...base,
      state: 'stuck',
      phase: 'failed',
      inbound: sats(100_000),
      outbound: token('50000000'),
      lost: true,
    })
    expect(record.atRiskSats).toBeNull()
  })
})

describe('economicsOf: the clock', () => {
  it('never reports a swap as having settled before it was quoted', () => {
    const record = economicsOf({ ...base, quotedAt: 2_000, settledAt: 1_000, inbound: sats(1), outbound: sats(1) })
    expect(record.durationSeconds).toBe(0)
  })
})

describe('bpsOf', () => {
  it('rounds toward zero so a spread never reads better than it was', () => {
    expect(bpsOf(299, 100_000)).toBe(29)
    expect(bpsOf(-299, 100_000)).toBe(-29)
  })

  it('answers null on a non-positive notional rather than dividing by it', () => {
    expect(bpsOf(100, 0)).toBeNull()
    expect(bpsOf(100, -1)).toBeNull()
  })
})

describe('clampLedgerLimit', () => {
  it('bounds a large request rather than refusing it', () => {
    expect(clampLedgerLimit(10_000_000)).toBe(50_000)
  })

  it('refuses a non-positive limit rather than silently substituting the default', () => {
    expect(() => clampLedgerLimit(0)).toThrow(/positive integer/)
    expect(() => clampLedgerLimit(-1)).toThrow(/positive integer/)
  })
})
