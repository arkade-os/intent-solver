/**
 * The aggregations behind every chart on the P&L screen.
 *
 * The property under test throughout is that an UNPRICEABLE row stays out of a
 * total and is counted separately — a zero folded into a sum is the one
 * arithmetic error here that renders as a plausible chart.
 */
import { describe, it, expect } from 'vitest'
import { economicsOf, type SwapEconomics } from '@arkade-os/solver-core/analytics/economics.js'
import {
  byCorridor,
  byDuration,
  byFxLeg,
  median,
  percentile,
  series,
  summarise,
} from '@arkade-os/solver-core/analytics/aggregate.js'

const sats = (amount: number | null) => ({
  assetId: null,
  amount: amount === null ? null : String(amount),
  decimals: 8,
})
const token = (amount: string, assetId = 'usdt') => ({ assetId, amount, decimals: null })

const HOUR = 3_600
const T0 = 1_000 * HOUR

/** A delivered sats-to-sats swap that kept `spread`. */
const won = (over: { id: string; at: number; give: number; spread: number; corridor?: string; took?: number }) =>
  economicsOf({
    id: over.id,
    corridor: over.corridor ?? 'arkade:BTC->lightning:BTC',
    state: 'claimed',
    phase: 'done',
    quotedAt: over.at - (over.took ?? 30),
    settledAt: over.at,
    inbound: sats(over.give),
    outbound: sats(over.give - over.spread),
  })

const lost = (over: { id: string; at: number; payout: number; corridor?: string }) =>
  economicsOf({
    id: over.id,
    corridor: over.corridor ?? 'arkade:BTC->lightning:BTC',
    state: 'stuck',
    phase: 'failed',
    quotedAt: over.at - 60,
    settledAt: over.at,
    inbound: sats(over.payout + 300),
    outbound: sats(over.payout),
    lost: true,
  })

const fx = (over: { id: string; at: number; give: number; get: string; took?: number; corridor?: string }) =>
  economicsOf({
    id: over.id,
    corridor: over.corridor ?? 'arkade:BTC->arkade:usdt',
    state: 'filled',
    phase: 'done',
    quotedAt: over.at - (over.took ?? 30),
    settledAt: over.at,
    inbound: sats(over.give),
    outbound: token(over.get),
  })

describe('summarise', () => {
  it('totals the priced rows and reports the volume they are a margin of', () => {
    const summary = summarise(
      [won({ id: 'a', at: T0, give: 100_300, spread: 300 }), won({ id: 'b', at: T0, give: 200_600, spread: 600 })],
      T0 - HOUR,
      T0 + HOUR,
    )
    expect(summary.grossSats).toBe(900)
    expect(summary.volumeSats).toBe(300_900)
    expect(summary.marginBps).toBe(29)
    expect(summary.pricedCount).toBe(2)
  })

  it('leaves a cross-asset fill OUT of the sats total and counts it as unpriced', () => {
    const summary = summarise(
      [won({ id: 'a', at: T0, give: 100_300, spread: 300 }), fx({ id: 'fx', at: T0, give: 100_000, get: '50000000' })],
      T0 - HOUR,
      T0 + HOUR,
    )
    expect(summary.grossSats).toBe(300)
    expect(summary.realizedCount).toBe(2)
    expect(summary.pricedCount).toBe(1)
    expect(summary.unpricedCount).toBe(1)
  })

  it('reports what is gone separately from what was earned', () => {
    const summary = summarise(
      [won({ id: 'a', at: T0, give: 100_300, spread: 300 }), lost({ id: 'x', at: T0, payout: 50_151 })],
      T0 - HOUR,
      T0 + HOUR,
    )
    expect(summary.grossSats).toBe(300)
    expect(summary.atRiskSats).toBe(50_151)
    expect(summary.failedCount).toBe(1)
  })
})

describe('series', () => {
  it('emits EMPTY buckets so a quiet period draws as a gap rather than a trend', () => {
    const points = series([won({ id: 'a', at: T0, give: 100_300, spread: 300 })], {
      since: T0,
      until: T0 + 3 * HOUR,
      bucketSeconds: HOUR,
    })
    expect(points).toHaveLength(3)
    expect(points[1]!.count).toBe(0)
    expect(points[2]!.count).toBe(0)
  })

  it('buckets on SETTLEMENT, not on when the swap was quoted', () => {
    // Quoted in the first hour, settled in the second.
    const straddling = won({ id: 'slow', at: T0 + HOUR + 60, give: 100_300, spread: 300, took: 2 * HOUR })
    const points = series([straddling], { since: T0, until: T0 + 2 * HOUR, bucketSeconds: HOUR })
    expect(points[0]!.count).toBe(0)
    expect(points[1]!.count).toBe(1)
  })

  it('carries a running total so the cumulative line is the server’s arithmetic, not the browser’s', () => {
    const points = series(
      [
        won({ id: 'a', at: T0 + 10, give: 100_300, spread: 300 }),
        won({ id: 'b', at: T0 + HOUR + 10, give: 100_200, spread: 200 }),
      ],
      { since: T0, until: T0 + 3 * HOUR, bucketSeconds: HOUR },
    )
    expect(points.map((p) => p.cumulativeGrossSats)).toEqual([300, 500, 500])
  })

  it('refuses a non-positive bucket rather than looping forever building one', () => {
    expect(() => series([], { since: T0, until: T0 + HOUR, bucketSeconds: 0 })).toThrow(/positive/)
  })
})

describe('byCorridor', () => {
  it('splits the book by corridor and ranks the earners first', () => {
    const rows = [
      won({ id: 'a', at: T0, give: 100_300, spread: 300, corridor: 'arkade:BTC->lightning:BTC' }),
      won({ id: 'b', at: T0, give: 100_900, spread: 900, corridor: 'arkade:BTC->onchain:BTC' }),
    ]
    const breakdown = byCorridor(rows)
    expect(breakdown.map((c) => c.corridor)).toEqual(['arkade:BTC->onchain:BTC', 'arkade:BTC->lightning:BTC'])
    expect(breakdown[0]!.grossSats).toBe(900)
  })

  it('marks a cross-asset corridor, so a null sats figure reads as "not expressible" not "flat"', () => {
    const breakdown = byCorridor([fx({ id: 'fx', at: T0, give: 100_000, get: '50000000' })])
    expect(breakdown[0]!.crossAsset).toBe(true)
    expect(breakdown[0]!.pricedCount).toBe(0)
  })

  it('reports a p90 duration a real swap actually took', () => {
    const rows = [1, 2, 3, 4, 100].map((took, index) =>
      won({ id: `s${index}`, at: T0 + index, give: 100_300, spread: 300, took }),
    )
    expect(byCorridor(rows)[0]!.p90DurationSeconds).toBe(100)
  })
})

describe('byDuration: the chart the FX question is asked of', () => {
  it('shows margin decaying as a fill drags', () => {
    const rows = [
      won({ id: 'fast', at: T0, give: 100_500, spread: 500, took: 10 }),
      won({ id: 'slow', at: T0, give: 100_050, spread: 50, took: 4 * HOUR }),
    ]
    const bands = byDuration(rows)
    const fast = bands.find((b) => b.label === '<1m')!
    const slow = bands.find((b) => b.label === '>2h')!
    expect(fast.marginBps).toBe(49)
    expect(slow.marginBps).toBe(4)
  })

  it('leaves an unfilled quote out entirely — its duration is a validity window, not an execution', () => {
    const lapsed = economicsOf({
      id: 'lapsed',
      corridor: 'arkade:BTC->arkade:usdt',
      state: 'refused',
      phase: 'failed',
      quotedAt: T0 - 6 * HOUR,
      settledAt: T0,
      inbound: sats(100_000),
      outbound: token('50000000'),
    })
    expect(byDuration([lapsed]).every((band) => band.count === 0)).toBe(true)
  })

  it('emits every band, including empty ones, so the axis does not move between refreshes', () => {
    expect(byDuration([won({ id: 'a', at: T0, give: 100_300, spread: 300, took: 5 })])).toHaveLength(5)
  })
})

describe('byFxLeg', () => {
  const leg = (rows: SwapEconomics[]) => byFxLeg(rows)[0]!

  it('benchmarks each fill against the window’s volume-weighted mean rate', () => {
    // Three fills at 500 units per sat, one dragged out and filled 2% worse.
    const rows = [
      fx({ id: 'a', at: T0, give: 100_000, get: '50000000' }),
      fx({ id: 'b', at: T0 + 60, give: 100_000, get: '50000000' }),
      fx({ id: 'slow', at: T0 + 120, give: 100_000, get: '51000000', took: 3 * HOUR }),
    ]
    const points = leg(rows).points
    const slow = points.find((p) => p.id === 'slow')!
    // Paid out MORE per sat taken in than its peers, so the drift is against us.
    expect(slow.driftBps).toBeLessThan(0)
    expect(points.find((p) => p.id === 'a')!.driftBps).toBeGreaterThan(0)
    expect(slow.durationSeconds).toBe(3 * HOUR)
  })

  it('never pools a leg with its own inverse', () => {
    const forward = fx({ id: 'f', at: T0, give: 100_000, get: '50000000' })
    const reverse = economicsOf({
      id: 'r',
      corridor: 'arkade:usdt->arkade:BTC',
      state: 'filled',
      phase: 'done',
      quotedAt: T0,
      settledAt: T0 + 30,
      inbound: token('50000000'),
      outbound: sats(100_000),
    })
    expect(byFxLeg([forward, reverse])).toHaveLength(2)
  })

  it('never pools two corridors that happen to trade the same two assets', () => {
    const rows = [
      fx({ id: 'a', at: T0, give: 100_000, get: '50000000', corridor: 'arkade:BTC->arkade:usdt' }),
      fx({ id: 'b', at: T0, give: 100_000, get: '50000000', corridor: 'arkade:BTC->ethereum:usdt' }),
    ]
    expect(byFxLeg(rows)).toHaveLength(2)
  })

  it('ignores a swap that never delivered — an unfilled quote has no executed rate', () => {
    const unfilled = economicsOf({
      id: 'q',
      corridor: 'arkade:BTC->arkade:usdt',
      state: 'quoted',
      phase: 'open',
      quotedAt: T0,
      settledAt: T0,
      inbound: sats(100_000),
      outbound: token('50000000'),
    })
    expect(byFxLeg([unfilled])).toHaveLength(0)
  })
})

describe('percentile', () => {
  it('answers a value from the list rather than interpolating one nothing took', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2)
    expect(percentile([1, 2, 3, 4], 0.9)).toBe(4)
  })

  it('answers null on an empty list rather than zero', () => {
    expect(median([])).toBeNull()
  })
})
