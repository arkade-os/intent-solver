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

/**
 * A cross-asset corridor that books its spread in sats — the ERC20 legs.
 *
 * `takes` says which leg the SATS are on. On the receive direction the intake
 * is a token and the payout is sats, which is the case that broke the
 * denominator: the spread entered the numerator while the notional contributed
 * nothing, so one small fill moved a blended margin by tens of basis points.
 */
const erc20 = (over: { id: string; at: number; sats: number; spread: number; takes: 'sats' | 'token' }) =>
  economicsOf({
    id: over.id,
    corridor: `arkade:BTC->ethereum:usdt`,
    state: 'claimed',
    phase: 'done',
    quotedAt: over.at - 30,
    settledAt: over.at,
    inbound: over.takes === 'sats' ? sats(over.sats) : token('50000000'),
    outbound: over.takes === 'sats' ? token('50000000') : sats(over.sats - over.spread),
    quotedSpreadSats: over.spread,
    exposureSats: over.sats - over.spread,
  })

describe('volume is the sats size of the trade, whichever leg the sats are on', () => {
  it('counts an ERC20 RECEIVE fill in the denominator as well as the numerator', () => {
    const summary = summarise(
      [erc20({ id: 'r', at: T0, sats: 50_000, spread: 500, takes: 'token' })],
      T0 - HOUR,
      T0 + HOUR,
    )
    expect(summary.grossSats).toBe(500)
    // The sats leg is the PAYOUT here. Zero volume would make marginBps null
    // while the 500 still moved every blended total it appeared in.
    expect(summary.volumeSats).toBe(49_500)
    expect(summary.marginBps).toBe(101)
  })

  it('does not let a token-intake fill distort a blended margin', () => {
    const blended = summarise(
      [
        won({ id: 'a', at: T0, give: 100_000, spread: 1_000 }),
        erc20({ id: 'r', at: T0, sats: 50_000, spread: 500, takes: 'token' }),
      ],
      T0 - HOUR,
      T0 + HOUR,
    )
    // 1,500 over 149,500. Reading only the inbound leg gave 1,500 over 100,000
    // — 150bp for a book whose real blended margin is 100.
    expect(blended.grossSats).toBe(1_500)
    expect(blended.volumeSats).toBe(149_500)
    expect(blended.marginBps).toBe(100)
  })

  it('still reads the intake on the direction whose intake IS sats', () => {
    const summary = summarise(
      [erc20({ id: 's', at: T0, sats: 50_000, spread: 500, takes: 'sats' })],
      T0 - HOUR,
      T0 + HOUR,
    )
    expect(summary.volumeSats).toBe(50_000)
  })
})

describe('a loss that cannot be priced in sats', () => {
  it('is counted rather than folded into the total as zero', () => {
    const lostToken = economicsOf({
      id: 'stuck-asset',
      corridor: 'arkade:BTC->arkade:usdt',
      state: 'stuck',
      phase: 'failed',
      quotedAt: T0 - 60,
      settledAt: T0,
      inbound: sats(100_000),
      outbound: token('50000000'),
      lost: true,
    })
    const summary = summarise([lostToken], T0 - HOUR, T0 + HOUR)
    expect(summary.atRiskSats).toBe(0)
    // Without this counter, "nothing is outstanding" and "something is
    // outstanding and nobody can price it" are the same zero.
    expect(summary.atRiskUnknownCount).toBe(1)
  })

  it('is zero when every loss in the window could be priced', () => {
    expect(summarise([lost({ id: 'x', at: T0, payout: 50_151 })], T0 - HOUR, T0 + HOUR).atRiskUnknownCount).toBe(0)
  })
})

describe('an at-risk figure that is a ceiling says so in the payload', () => {
  const ceiling = economicsOf({
    id: 'evm-stuck',
    corridor: 'arkade:BTC->ethereum:usdt',
    state: 'stuck',
    phase: 'failed',
    quotedAt: T0 - 60,
    settledAt: T0,
    inbound: sats(50_000),
    outbound: token('25000000'),
    exposureSats: 49_500,
    lost: true,
    atRiskUpperBound: true,
  })

  it('flags the corridor and the summary, not just the docs', () => {
    expect(byCorridor([ceiling])[0]!.atRiskUpperBound).toBe(true)
    expect(summarise([ceiling], T0 - HOUR, T0 + HOUR).atRiskUpperBound).toBe(true)
  })

  it('leaves a corridor that measures its losses unflagged', () => {
    expect(byCorridor([lost({ id: 'x', at: T0, payout: 50_151 })])[0]!.atRiskUpperBound).toBe(false)
    expect(summarise([lost({ id: 'x', at: T0, payout: 50_151 })], T0 - HOUR, T0 + HOUR).atRiskUpperBound).toBe(false)
  })

  it('does not flag a healthy row merely because its corridor would qualify one', () => {
    const fine = economicsOf({
      id: 'evm-ok',
      corridor: 'arkade:BTC->ethereum:usdt',
      state: 'claimed',
      phase: 'done',
      quotedAt: T0 - 60,
      settledAt: T0,
      inbound: sats(50_000),
      outbound: token('25000000'),
      quotedSpreadSats: 500,
      exposureSats: 49_500,
      atRiskUpperBound: true,
    })
    expect(fine.atRiskUpperBound).toBe(false)
    expect(summarise([fine], T0 - HOUR, T0 + HOUR).atRiskUpperBound).toBe(false)
  })
})

describe('byFxLeg on 18-decimal tokens', () => {
  const dai = (id: string, sat: number, units: string) =>
    economicsOf({
      id,
      corridor: 'arkade:BTC->ethereum:dai',
      state: 'claimed',
      phase: 'done',
      quotedAt: T0 - 30,
      settledAt: T0,
      inbound: token(units, 'dai'),
      outbound: sats(sat),
      quotedSpreadSats: 0,
    })

  /**
   * $100k of an 18-decimal token is ~10^23 atomic units, against a safe-integer
   * ceiling of ~9·10^15. The weighted mean is `Σ(rateᵢ·denᵢ)/Σ(denᵢ)`, and
   * `rateᵢ·denᵢ` is just `numᵢ` — so summing as bigint and dividing ONCE keeps
   * the benchmark exact right up to that single division.
   *
   * This pins the property, not the discrimination: the residual error below is
   * the final `Number()` division alone, which is unavoidable and ~1e-16
   * relative — sixteen orders of magnitude under the basis point anything is
   * reported in.
   */
  it('computes the benchmark as an exact ratio of sums, dividing only once', () => {
    const legs = byFxLeg([dai('a', 100_000, '100000' + '0'.repeat(18)), dai('b', 250_000, '250000' + '0'.repeat(18))])
    expect(legs).toHaveLength(1)
    const expected = Number(350_000n) / Number(BigInt('350000' + '0'.repeat(18)))
    expect(legs[0]!.meanRate).toBe(expected)
    expect(legs[0]!.meanRate).toBeCloseTo(1e-18, 25)
  })

  it('reports no drift for fills that all executed at the same rate', () => {
    const legs = byFxLeg([dai('a', 100_000, '100000' + '0'.repeat(18)), dai('b', 250_000, '250000' + '0'.repeat(18))])
    expect(legs[0]!.points.map((p) => p.driftBps)).toEqual([0, 0])
  })

  it('still ranks a worse fill below the benchmark at this scale', () => {
    // 'b' pays out the same sats for MORE token intake, so it took in more per
    // sat delivered — the favourable side.
    const legs = byFxLeg([dai('a', 100_000, '100000' + '0'.repeat(18)), dai('b', 100_000, '200000' + '0'.repeat(18))])
    const drifts = Object.fromEntries(legs[0]!.points.map((p) => [p.id, p.driftBps ?? 0]))
    expect(drifts.a).toBeLessThan(0)
    expect(drifts.b).toBeGreaterThan(0)
  })
})

describe('series', () => {
  it('ignores a record that settled outside the window, even when its bucket exists', () => {
    // The first bucket starts at `floor(since / bucketSeconds)`, which can
    // precede `since` — so a record settled just before the window opened lands
    // in a bucket that exists and was silently counted.
    const before = won({ id: 'early', at: T0 - 30, give: 100_300, spread: 300 })
    const points = series([before], { since: T0 - 10, until: T0 + HOUR, bucketSeconds: HOUR })
    expect(points.reduce((total, point) => total + point.count, 0)).toBe(0)
  })

  it('refuses a window that would allocate more buckets than the cap', () => {
    expect(() => series([], { since: 0, until: 1_800_000_000, bucketSeconds: 300 })).toThrow(/cap/)
  })

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
