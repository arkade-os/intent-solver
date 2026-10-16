/**
 * The market mark, composed through the REAL quote path.
 *
 * Every fixture here runs `resolveAssetQuote` -> `impliedQuotePrice` -> the
 * drift, exactly as the orchestrator does, and never hand-builds the stored
 * numbers. The first attempt at this feature did hand-build them, and the test
 * agreed with its author while the production path computed something else
 * entirely: the drift was a second copy of the quote-time feed compared against
 * a quote DERIVED from that same feed, so it always returned the configured
 * spread and could not go negative. A hand-built row hid that; composing the
 * real path cannot.
 *
 * The mark INCLUDES the spread by construction — it asks "what is this fill
 * worth against the market now", not "how far did the feed move". A flat market
 * therefore reads as `+feeBps`, and the number crossing ZERO is the signal: the
 * market has moved further than the margin, and the fill is under water.
 */
import { describe, it, expect } from 'vitest'
import { impliedQuotePrice, resolveAssetQuote, type AssetQuoteMarket } from '@arkade-os/solver-core/core/assetRfq.js'
import { economicsOf } from '@arkade-os/solver-core/analytics/economics.js'
import { byFxLeg } from '@arkade-os/solver-core/analytics/aggregate.js'

const USDT = 'a'.repeat(68)
const BTC = null

/** BTC/USDT, 8dp against 6dp, priced from a feed at `scale`. */
const market = (over: Partial<AssetQuoteMarket> = {}): AssetQuoteMarket => ({
  base: BTC,
  quote: USDT,
  baseDecimals: 8,
  quoteDecimals: 6,
  feeBps: 30,
  minPayout: 0n,
  maxPayout: 10n ** 30n,
  ...over,
})

/**
 * A fill, priced the way production prices one: resolve the quote against
 * `quoteFeed`, derive the implied price from the amounts that came back, then
 * mark it against `fillFeed`.
 */
const fill = (args: {
  quoteFeed: { mantissa: bigint; scale: number }
  fillFeed: { mantissa: bigint; scale: number } | null
  givesBase?: boolean
  amount?: bigint
  market?: AssetQuoteMarket
}) => {
  const m = args.market ?? market()
  const givesBase = args.givesBase ?? true
  const pair = givesBase ? { from: m.base, to: m.quote } : { from: m.quote, to: m.base }
  const amount = args.amount ?? (givesBase ? 10n ** 8n : 100_000_000n)

  const resolved = resolveAssetQuote({ pair, amount, amountSide: 'from', market: m, feed: args.quoteFeed })
  if (!resolved.ok) throw new Error(`the fixture did not resolve: ${resolved.reason}`)

  const implied = impliedQuotePrice({
    fromAmount: resolved.fromAmount,
    toAmount: resolved.toAmount,
    givesBase,
    baseDecimals: m.baseDecimals,
    quoteDecimals: m.quoteDecimals,
    scale: args.quoteFeed.scale,
  })

  return economicsOf({
    id: 'swap-1',
    corridor: 'arkade:BTC->arkade:USDT',
    state: 'filled',
    phase: 'done',
    quotedAt: 1_000,
    settledAt: 2_000,
    inbound: { assetId: pair.from, amount: resolved.fromAmount.toString(), decimals: null },
    outbound: { assetId: pair.to, amount: resolved.toAmount.toString(), decimals: null },
    quotePrice:
      implied === null ? null : { impliedMantissa: implied.mantissa.toString(), scale: implied.scale, givesBase },
    fillPrice:
      args.fillFeed === null ? null : { mantissa: args.fillFeed.mantissa.toString(), scale: args.fillFeed.scale },
  })
}

const FEED = { mantissa: 6_000_000n, scale: 2 } // $60,000.00

describe('the mark moves with the market, which is the whole point', () => {
  /**
   * The regression that matters. A flat market reads as the spread, so this
   * number alone proves nothing — but it MUST change when the fill price does,
   * and the old implementation could not, because both its observations came
   * from one instant.
   */
  it('reports a different figure for a market that moved than for one that did not', () => {
    const flat = fill({ quoteFeed: FEED, fillFeed: FEED })
    const moved = fill({ quoteFeed: FEED, fillFeed: { mantissa: 5_940_000n, scale: 2 } })
    expect(flat.marketDriftBps).not.toBe(moved.marketDriftBps)
    expect(flat.marketDriftBps).toBe(30)
  })

  /**
   * The flat-market baseline, pinned HONESTLY rather than at the one fee where
   * the convenient identity happens to hold.
   *
   * A flat market reads as the spread, and at ordinary fees that IS `feeBps` on
   * both legs. It is not an identity: the buying leg reads
   * `feeBps / (1 - feeBps/10_000)`, which is indistinguishable below 1% and
   * diverges above it. Documenting `+feeBps` as exact was wrong, and the earlier
   * test pinned `feeBps: 30` on the buying leg only — the single combination
   * where the claim survives.
   */
  it('reads the spread on a flat market, and both legs agree at ordinary fees', () => {
    for (const feeBps of [1, 30, 50, 99]) {
      const m = market({ feeBps })
      expect(fill({ quoteFeed: FEED, fillFeed: FEED, market: m, givesBase: true }).marketDriftBps).toBe(feeBps)
      expect(fill({ quoteFeed: FEED, fillFeed: FEED, market: m, givesBase: false }).marketDriftBps).toBe(feeBps)
    }
  })

  it('diverges from feeBps on the buying leg at a large fee, as the ratio says it must', () => {
    const big = market({ feeBps: 500 })
    // 500 / (1 - 0.05) = 526.3
    expect(fill({ quoteFeed: FEED, fillFeed: FEED, market: big, givesBase: true }).marketDriftBps).toBe(526)
    expect(fill({ quoteFeed: FEED, fillFeed: FEED, market: big, givesBase: false }).marketDriftBps).toBe(500)
  })

  /**
   * What IS exact on both legs at every fee, and the only claim the screens make
   * operationally: the number crosses zero when the market has moved exactly as
   * far as the margin.
   */
  it('puts breakeven at zero on both legs', () => {
    const m = market({ feeBps: 500 })
    for (const givesBase of [true, false]) {
      const flat = fill({ quoteFeed: FEED, fillFeed: FEED, market: m, givesBase }).marketDriftBps!
      expect(flat).toBeGreaterThan(0)
      // Move the market against the solver by more than the margin: it must flip.
      const against = givesBase ? { mantissa: 5_400_000n, scale: 2 } : { mantissa: 6_600_000n, scale: 2 }
      expect(fill({ quoteFeed: FEED, fillFeed: against, market: m, givesBase }).marketDriftBps!).toBeLessThan(0)
    }
  })

  /**
   * The case the whole feature exists for: the solver bought base, and by the
   * time the swap filled the market had fallen further than the margin covered.
   * The old mark could NOT produce a negative number at all.
   */
  it('goes NEGATIVE when the market runs further than the spread', () => {
    const ruined = fill({ quoteFeed: FEED, fillFeed: { mantissa: 5_700_000n, scale: 2 } })
    expect(ruined.marketDriftBps).toBeLessThan(0)
  })

  it('is more favourable the further the market moves the solver’s way', () => {
    const little = fill({ quoteFeed: FEED, fillFeed: { mantissa: 6_060_000n, scale: 2 } })
    const lots = fill({ quoteFeed: FEED, fillFeed: { mantissa: 6_600_000n, scale: 2 } })
    expect(lots.marketDriftBps!).toBeGreaterThan(little.marketDriftBps!)
  })
})

describe('the sign is the solver’s, on both legs', () => {
  /**
   * The solver BUYS base here, so a market above what it paid is favourable.
   * Selling is the mirror, and one unnormalised subtraction would report the
   * same move as good on one leg and bad on the other.
   */
  it('a rising market favours the leg that bought base and hurts the leg that sold it', () => {
    const rise = { mantissa: 6_600_000n, scale: 2 }
    expect(fill({ quoteFeed: FEED, fillFeed: rise, givesBase: true }).marketDriftBps!).toBeGreaterThan(0)
    expect(fill({ quoteFeed: FEED, fillFeed: rise, givesBase: false }).marketDriftBps!).toBeLessThan(0)
  })

  it('and a falling market is the mirror of that', () => {
    const fall = { mantissa: 5_400_000n, scale: 2 }
    expect(fill({ quoteFeed: FEED, fillFeed: fall, givesBase: true }).marketDriftBps!).toBeLessThan(0)
    expect(fill({ quoteFeed: FEED, fillFeed: fall, givesBase: false }).marketDriftBps!).toBeGreaterThan(0)
  })
})

describe('what cannot be marked says so', () => {
  it('is null when the fill carries no feed read', () => {
    expect(fill({ quoteFeed: FEED, fillFeed: null }).marketDriftBps).toBeNull()
  })

  /**
   * THE QUANTISATION DEFECT, and the reason the implied price carries headroom
   * rather than the feed's own scale.
   *
   * CoinGecko is a first-class provider here and returns unquoted JSON numbers,
   * so a $1.50 token arrives as `1.5` — `scale: 1`. Carried at that scale, an
   * implied price of 1.4955 truncated to `14`, and the drift read **+714bp on a
   * flat market and +607bp on a fill 70bp under water**: a loss rendered as a
   * large gain, and uncoloured, because `marketDriftBps < 0` was false.
   */
  it('does not quantise a coarse feed into a false gain', () => {
    const cheap = { mantissa: 15n, scale: 1 }
    const rich = { mantissa: 6_000_000n, scale: 2 }

    expect(fill({ quoteFeed: cheap, fillFeed: cheap }).marketDriftBps).toBe(30)
    // The same market move reads the same whatever precision the feed arrived in.
    expect(fill({ quoteFeed: cheap, fillFeed: { mantissa: 1_485n, scale: 3 } }).marketDriftBps).toBe(
      fill({ quoteFeed: rich, fillFeed: { mantissa: 5_940_000n, scale: 2 } }).marketDriftBps,
    )
    expect(fill({ quoteFeed: cheap, fillFeed: { mantissa: 1_485n, scale: 3 } }).marketDriftBps).toBeLessThan(0)
  })

  it('reports no implied price at all for a degenerate quote', () => {
    const degenerate = { givesBase: true, baseDecimals: 8, quoteDecimals: 6, scale: 2 }
    expect(impliedQuotePrice({ ...degenerate, fromAmount: 0n, toAmount: 1n })).toBeNull()
    expect(impliedQuotePrice({ ...degenerate, fromAmount: 1n, toAmount: 0n })).toBeNull()
    expect(impliedQuotePrice({ ...degenerate, fromAmount: 1n, toAmount: 1n, scale: -1 })).toBeNull()
  })

  it('compares across feeds that came back at different scales', () => {
    const coarse = fill({ quoteFeed: FEED, fillFeed: { mantissa: 5_940_000n, scale: 2 } })
    const fine = fill({ quoteFeed: FEED, fillFeed: { mantissa: 594_000_000_000n, scale: 7 } })
    expect(fine.marketDriftBps).toBe(coarse.marketDriftBps)
  })
})

describe('the leg reports how much of itself it marked', () => {
  it('counts the marked fills beside the median, never the median alone', () => {
    const marked = fill({ quoteFeed: FEED, fillFeed: { mantissa: 5_940_000n, scale: 2 } })
    const unmarked = fill({ quoteFeed: FEED, fillFeed: null })
    const [leg] = byFxLeg([marked, { ...unmarked, id: 'swap-2' }])
    expect(leg!.count).toBe(2)
    expect(leg!.markedCount).toBe(1)
    expect(leg!.medianMarketDriftBps).toBe(marked.marketDriftBps)
  })

  it('reports no median at all when nothing on the leg was marked', () => {
    const [leg] = byFxLeg([fill({ quoteFeed: FEED, fillFeed: null })])
    expect(leg!.markedCount).toBe(0)
    expect(leg!.medianMarketDriftBps).toBeNull()
  })
})
