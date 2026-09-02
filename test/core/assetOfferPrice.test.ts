/**
 * The price gate the Arkade Swap Protocol § 5.2 lists third, and which this
 * solver had no implementation of at all.
 *
 * Amounts are atomic units: USDT at 6 decimals against sats at 8.
 */
import { describe, it, expect } from 'vitest'
import {
  offerWithinTolerance,
  offerDirectionOn,
  type OfferPriceMarket,
} from '@arkade-os/solver-core/core/assetOfferPrice.js'
import { priceFrom } from '@arkade-os/solver-core/core/priceFeed.js'

/** BTC/USDT: base is BTC (8 decimals), quote is USDT (6). Feed is USDT per BTC. */
const market = (over: Partial<OfferPriceMarket> = {}): OfferPriceMarket => ({
  baseDecimals: 8,
  quoteDecimals: 6,
  toleranceBps: 10,
  feeBps: 0,
  ...over,
})

/** 100 000 USDT per BTC. */
const feed = priceFrom('100000')

/** A maker depositing 1 BTC and wanting `usdt` whole USDT. */
const sell = (usdt: number, over: Partial<OfferPriceMarket> = {}) =>
  offerWithinTolerance({
    depositAmount: 100_000_000n,
    wantAmount: BigInt(Math.round(usdt * 1e6)),
    direction: 'sell_base',
    market: market(over),
    feed,
  })

/** A maker depositing `usdt` whole USDT and wanting 1 BTC. */
const buy = (usdt: number, over: Partial<OfferPriceMarket> = {}) =>
  offerWithinTolerance({
    depositAmount: BigInt(Math.round(usdt * 1e6)),
    wantAmount: 100_000_000n,
    direction: 'buy_base',
    market: market(over),
    feed,
  })

describe('sell_base — the maker sells BTC, we pay USDT', () => {
  it('takes an offer at the feed price', () => {
    expect(sell(100_000)).toBe(true)
  })

  it('takes one asking slightly under the feed — better for us', () => {
    expect(sell(99_000)).toBe(true)
  })

  it('takes one at exactly the tolerance edge', () => {
    // 10 bps of 100 000 is 100.
    expect(sell(100_100)).toBe(true)
  })

  it('refuses one just past it', () => {
    expect(sell(100_101)).toBe(false)
  })
})

describe('buy_base — the maker buys BTC, we pay BTC', () => {
  it('takes an offer at the feed price', () => {
    expect(buy(100_000)).toBe(true)
  })

  it('takes one paying above the feed — better for us', () => {
    expect(buy(101_000)).toBe(true)
  })

  it('refuses one paying too little', () => {
    expect(buy(99_899)).toBe(false)
  })

  it('takes one at the tolerance edge', () => {
    expect(buy(99_900)).toBe(true)
  })
})

describe('the fee is folded in against the maker', () => {
  it('narrows what a sell may ask', () => {
    // 100 bps fee: an offer at the feed no longer clears, because the fee
    // inflates the offer price before tolerance is applied.
    expect(sell(100_100, { feeBps: 100 })).toBe(false)
    expect(sell(100_000, { feeBps: 100 })).toBe(false)
    expect(sell(99_000, { feeBps: 100 })).toBe(true)
  })

  it('raises what a buy must pay', () => {
    // Symmetric with the sell side: at a 100 bps fee an offer at exactly the
    // feed no longer clears, because the fee deflates it below the tolerance
    // floor (100 000 × 0.99 = 99 000, floor 99 900). The maker must pay more.
    expect(buy(100_000, { feeBps: 100 })).toBe(false)
    expect(buy(101_000, { feeBps: 100 })).toBe(true)
    expect(buy(98_000, { feeBps: 100 })).toBe(false)
  })
})

describe('refusals that would otherwise accept anything', () => {
  it('refuses a non-positive feed price', () => {
    // A zeroed margin makes buy_base accept any offer at all.
    expect(
      offerWithinTolerance({
        depositAmount: 1n,
        wantAmount: 1n,
        direction: 'buy_base',
        market: market(),
        feed: { mantissa: 0n, scale: 0 },
      }),
    ).toBe(false)
  })

  it('refuses a tolerance of 100% or more, which switches the gate off', () => {
    // buy_base compares against `feed * (BPS - tolerance)`. At BPS that factor
    // is zero and beyond it is negative, so `right` goes non-positive while
    // `left` stays positive and `left >= right` is trivially true — every
    // buy_base offer accepted at any price, however far below the feed.
    const wildlyUnderpriced = (toleranceBps: number) =>
      offerWithinTolerance({
        depositAmount: 1n,
        wantAmount: 1_000_000_000n,
        direction: 'buy_base',
        market: market({ toleranceBps }),
        feed,
      })
    expect(wildlyUnderpriced(9_999)).toBe(false)
    expect(wildlyUnderpriced(10_000)).toBe(false)
    expect(wildlyUnderpriced(20_000)).toBe(false)

    // Refused on the sell side too. There the factor only grows, so nothing is
    // degenerate — but a 100% tolerance is the gate disabled either way, and a
    // bound that held on one direction only would invite exactly that reading.
    expect(
      offerWithinTolerance({
        depositAmount: 1_000_000_000n,
        wantAmount: 1n,
        direction: 'sell_base',
        market: market({ toleranceBps: 10_000 }),
        feed,
      }),
    ).toBe(false)
  })

  it('refuses zero amounts rather than dividing by them', () => {
    expect(sell(0)).toBe(false)
    expect(
      offerWithinTolerance({
        depositAmount: 0n,
        wantAmount: 1n,
        direction: 'sell_base',
        market: market(),
        feed,
      }),
    ).toBe(false)
  })

  it('refuses a fee of 100% or more, which would zero the buy bound', () => {
    expect(buy(1, { feeBps: 10_000 })).toBe(false)
  })
})

describe('exactness', () => {
  it('does not lose a sub-unit to floating point at the tolerance edge', () => {
    // The edge is exact: 100 100.000000 USDT clears, one atomic unit more does
    // not. A float64 path rounds these together.
    const at = offerWithinTolerance({
      depositAmount: 100_000_000n,
      wantAmount: 100_100_000_000n,
      direction: 'sell_base',
      market: market(),
      feed,
    })
    const over = offerWithinTolerance({
      depositAmount: 100_000_000n,
      wantAmount: 100_100_000_001n,
      direction: 'sell_base',
      market: market(),
      feed,
    })
    expect([at, over]).toEqual([true, false])
  })

  it('handles a fractional feed price exactly', () => {
    // 0.5 USDT per unit, scale 1.
    expect(
      offerWithinTolerance({
        depositAmount: 1_000_000n,
        wantAmount: 500_000n,
        direction: 'sell_base',
        market: market({ baseDecimals: 6, toleranceBps: 0 }),
        feed: priceFrom('0.5'),
      }),
    ).toBe(true)
  })
})

describe('offerDirectionOn', () => {
  const USDT = '11'.repeat(34)
  const m = { base: null, quote: USDT }

  it('reads null as the BTC leg', () => {
    expect(offerDirectionOn(m, null, USDT)).toBe('sell_base')
    expect(offerDirectionOn(m, USDT, null)).toBe('buy_base')
  })

  it('answers null for a pair off this market', () => {
    expect(offerDirectionOn(m, '22'.repeat(34), null)).toBeNull()
  })

  it('supports asset-for-asset, where neither leg is BTC', () => {
    const EURC = '22'.repeat(34)
    expect(offerDirectionOn({ base: USDT, quote: EURC }, USDT, EURC)).toBe('sell_base')
    expect(offerDirectionOn({ base: USDT, quote: EURC }, EURC, USDT)).toBe('buy_base')
  })
})
