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

  const impliedMantissa = impliedQuotePrice({
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
      impliedMantissa === null
        ? null
        : { impliedMantissa: impliedMantissa.toString(), scale: args.quoteFeed.scale, givesBase },
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
    // Flat reads as the configured spread, and nothing else does.
    expect(flat.marketDriftBps).toBe(30)
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
   * A feed reporting `1.0` parses to `scale: 0`, and the implied price then
   * truncates to `0n`. Stored as valid it reported +10000bp in the solver's
   * favour — a swap that made 100% — which is how the old bug would have looked
   * on a real screen.
   */
  it('refuses a degenerate implied price rather than reporting +10000bp', () => {
    const degenerate = fill({
      quoteFeed: { mantissa: 1n, scale: 0 },
      fillFeed: { mantissa: 1n, scale: 0 },
      market: market({ baseDecimals: 8, quoteDecimals: 6 }),
    })
    expect(degenerate.marketDriftBps).not.toBe(10_000)
    expect(degenerate.marketDriftBps).toBeNull()
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
