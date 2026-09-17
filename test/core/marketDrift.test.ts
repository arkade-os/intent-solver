/**
 * The feed-relative mark: how a quote priced against the MARKET, not against
 * this solver's other fills.
 *
 * The distinction is the whole reason the snapshot exists. `driftBps`
 * benchmarks a fill against its peers, so it finds a bad fill and is blind to a
 * bad book — a market that ran against every quote in a window leaves them all
 * looking fine relative to each other. These tests pin the case that separates
 * the two: fills that agree with each other and are all wrong.
 */
import { describe, it, expect } from 'vitest'
import { economicsOf } from '@arkade-os/solver-core/analytics/economics.js'
import { byFxLeg } from '@arkade-os/solver-core/analytics/aggregate.js'
import { impliedQuotePrice } from '@arkade-os/solver-core/core/assetRfq.js'

const T0 = 1_000 * 3_600

/**
 * A filled asset-RFQ swap with a price snapshot.
 *
 * `feed` and `implied` are both quote-per-base at the same scale, which is what
 * the orchestrator stores — so these fixtures are the shape the store really
 * holds rather than a convenient stand-in.
 */
const fill = (over: { id: string; feed: bigint; implied: bigint; givesBase: boolean; scale?: number; at?: number }) =>
  economicsOf({
    id: over.id,
    corridor: 'arkade:BTC->arkade:usdt',
    state: 'filled',
    phase: 'done',
    quotedAt: (over.at ?? T0) - 30,
    settledAt: over.at ?? T0,
    inbound: { assetId: null, amount: '100000', decimals: 8 },
    outbound: { assetId: 'usdt', amount: '50000000', decimals: 6 },
    quotePrice: {
      mantissa: over.feed.toString(),
      scale: over.scale ?? 8,
      impliedMantissa: over.implied.toString(),
      givesBase: over.givesBase,
    },
  })

describe('impliedQuotePrice', () => {
  /**
   * Both directions describe the SAME ratio — quote per base — which is what
   * makes a drift figure comparable across the two legs of one market.
   */
  it('produces quote-per-base whichever way the client traded', () => {
    const selling = impliedQuotePrice({
      fromAmount: 1_00000000n, // 1 base, 8dp
      toAmount: 50_000000n, // 50 quote, 6dp
      givesBase: true,
      baseDecimals: 8,
      quoteDecimals: 6,
      scale: 8,
    })
    const buying = impliedQuotePrice({
      fromAmount: 50_000000n, // 50 quote in
      toAmount: 1_00000000n, // 1 base out
      givesBase: false,
      baseDecimals: 8,
      quoteDecimals: 6,
      scale: 8,
    })
    expect(selling).toBe(50n * 10n ** 8n)
    expect(buying).toBe(selling)
  })

  it('answers null on a degenerate amount rather than dividing by it', () => {
    expect(
      impliedQuotePrice({ fromAmount: 0n, toAmount: 5n, givesBase: true, baseDecimals: 8, quoteDecimals: 6, scale: 8 }),
    ).toBeNull()
  })
})

describe('marketDriftBps is signed in the solver’s favour, both directions', () => {
  const FEED = 100_00000000n // 100.00000000

  /**
   * The client hands over base, so the solver PAYS quote for it. Paying less
   * than the market is the good outcome.
   */
  it('is POSITIVE when the solver bought base below the market', () => {
    expect(fill({ id: 'a', feed: FEED, implied: 99_00000000n, givesBase: true }).marketDriftBps).toBe(100)
  })

  it('is NEGATIVE when the solver bought base above the market', () => {
    expect(fill({ id: 'a', feed: FEED, implied: 101_00000000n, givesBase: true }).marketDriftBps).toBe(-100)
  })

  /**
   * The mirror: the client hands over quote, so the solver pays base and
   * receives quote. Receiving MORE quote per base is the good outcome — the
   * opposite comparison, which is why the direction bit is stored.
   */
  it('inverts for the other side of the same market', () => {
    expect(fill({ id: 'a', feed: FEED, implied: 101_00000000n, givesBase: false }).marketDriftBps).toBe(100)
    expect(fill({ id: 'a', feed: FEED, implied: 99_00000000n, givesBase: false }).marketDriftBps).toBe(-100)
  })

  it('is zero when the quote matched the market exactly', () => {
    expect(fill({ id: 'a', feed: FEED, implied: FEED, givesBase: true }).marketDriftBps).toBe(0)
  })

  it('answers null on an unusable feed rather than treating it as a drift of zero', () => {
    expect(fill({ id: 'a', feed: 0n, implied: FEED, givesBase: true }).marketDriftBps).toBeNull()
  })

  it('is null where no snapshot was taken', () => {
    const noSnapshot = economicsOf({
      id: 'old',
      corridor: 'arkade:BTC->arkade:usdt',
      state: 'filled',
      phase: 'done',
      quotedAt: T0 - 30,
      settledAt: T0,
      inbound: { assetId: null, amount: '100000', decimals: 8 },
      outbound: { assetId: 'usdt', amount: '50000000', decimals: 6 },
    })
    expect(noSnapshot.marketDriftBps).toBeNull()
    expect(noSnapshot.quotePrice).toBeNull()
  })
})

describe('a bad BOOK, which the self-referential mark cannot see', () => {
  /**
   * THE CASE THE WHOLE SNAPSHOT EXISTS FOR. Three fills at an identical rate,
   * every one of them 200bps worse than the market. Benchmarked against each
   * other they are flawless; benchmarked against the feed they are all bad.
   */
  it('reports every fill as flat on peer drift and badly off on market drift', () => {
    const rows = [
      fill({ id: 'a', feed: 100_00000000n, implied: 102_00000000n, givesBase: true, at: T0 }),
      fill({ id: 'b', feed: 100_00000000n, implied: 102_00000000n, givesBase: true, at: T0 + 60 }),
      fill({ id: 'c', feed: 100_00000000n, implied: 102_00000000n, givesBase: true, at: T0 + 120 }),
    ]
    const leg = byFxLeg(rows)[0]!
    // Identical rates, so nothing drifts from the cohort mean.
    expect(leg.points.map((p) => p.driftBps)).toEqual([0, 0, 0])
    // And every one of them was priced 200bps against the solver.
    expect(leg.points.map((p) => p.marketDriftBps)).toEqual([-200, -200, -200])
    expect(leg.medianMarketDriftBps).toBe(-200)
  })

  it('leaves the leg median null when no fill on it carried a snapshot', () => {
    const bare = economicsOf({
      id: 'x',
      corridor: 'arkade:BTC->arkade:usdt',
      state: 'filled',
      phase: 'done',
      quotedAt: T0 - 30,
      settledAt: T0,
      inbound: { assetId: null, amount: '100000', decimals: 8 },
      outbound: { assetId: 'usdt', amount: '50000000', decimals: 6 },
    })
    expect(byFxLeg([bare])[0]!.medianMarketDriftBps).toBeNull()
  })
})
