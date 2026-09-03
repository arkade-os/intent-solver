/**
 * What an operator may declare as a market, and what is refused.
 *
 * The bps bounds get their own describe block and the most attention, because
 * they are the one rule here whose failure is a fund loss rather than a refusal:
 * at 10000 the `buy_base` price comparison goes non-positive and every offer is
 * accepted at any price. That shipped once. `offerWithinTolerance` refuses it at
 * run time and these tests exist to make sure the WRITE path is never weaker,
 * so a market that would be refused on every offer cannot be stored looking
 * healthy.
 */
import { describe, it, expect } from 'vitest'
import {
  assetMarketKey,
  assetMarketPolicy,
  validateAssetMarket,
  type AssetMarketConfig,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { BPS_DENOMINATOR, offerWithinTolerance } from '@arkade-os/solver-core/core/assetOfferPrice.js'
import { priceFrom } from '@arkade-os/solver-core/core/priceFeed.js'

/** 68 hex characters — `serializeAssetId` is a 32-byte txid plus a u16 index. */
const USDT = 'aa'.repeat(34)
const OTHER = 'bb'.repeat(34)

const market = (over: Partial<AssetMarketConfig> = {}): AssetMarketConfig => ({
  base: null,
  quote: USDT,
  baseDecimals: 8,
  quoteDecimals: 6,
  feedUrl: 'https://feed.test/api/v3/ticker/price?symbol=BTCUSDT',
  pricePath: '/price',
  toleranceBps: 10,
  feeBps: 0,
  sellBase: null,
  buyBase: null,
  enabled: true,
  ...over,
})

describe('legs', () => {
  it('takes BTC against an asset, with null as the BTC leg', () => {
    expect(() => validateAssetMarket(market())).not.toThrow()
  })

  it('takes an asset against another asset', () => {
    expect(() => validateAssetMarket(market({ base: USDT, quote: OTHER }))).not.toThrow()
  })

  it('refuses a leg that is not a 68-character asset id', () => {
    expect(() => validateAssetMarket(market({ quote: 'aa'.repeat(32) }))).toThrow(/68-character/)
  })

  it('refuses an UPPERCASE asset id, which § 2 says is a different string', () => {
    // Hex is case-insensitive and the wire is not: `decideOpenRfqBid` compares
    // pair strings byte for byte, so an upper-case id would derive a market key
    // nothing subscribes to.
    expect(() => validateAssetMarket(market({ quote: USDT.toUpperCase() }))).toThrow(/lowercase/)
  })

  it('refuses a market whose two legs are the same thing', () => {
    expect(() => validateAssetMarket(market({ base: USDT, quote: USDT }))).toThrow(/both legs/)
    expect(() => validateAssetMarket(market({ base: null, quote: null }))).toThrow(/BTC on both legs/)
  })
})

describe('the market key is derived and order-free', () => {
  it('gives one key whichever way round the legs are stated', () => {
    // The property that makes a pair unrepresentable twice. Without it the
    // primary key admits two rows for one market, and `pricing.find()` resolves
    // which feed applies by row order.
    expect(assetMarketKey(null, USDT)).toBe(assetMarketKey(USDT, null))
  })

  it('is the canonical § 2 market key, so it matches what the wire subscribes under', () => {
    // Both legs are on the arkade corridor, so § 2's "arkade first" clause does
    // not apply and the ordering is lexicographic — which puts a leading-`a`
    // asset id before the literal `btc`. Pinned as the real derivation rather
    // than the intuitive "BTC comes first", because the console shows this
    // string and a reader has to be able to recognise it.
    expect(assetMarketKey(null, USDT)).toBe(`arkade:${USDT}/arkade:btc`)
    expect(assetMarketKey(null, OTHER)).toBe(`arkade:${OTHER}/arkade:btc`)
  })

  it('orders two asset legs lexicographically, not by which was typed first', () => {
    expect(assetMarketKey(OTHER, USDT)).toBe(`arkade:${USDT}/arkade:${OTHER}`)
    expect(assetMarketKey(USDT, OTHER)).toBe(`arkade:${USDT}/arkade:${OTHER}`)
  })
})

describe('bps bounds — the gate that must never be switched off', () => {
  for (const key of ['toleranceBps', 'feeBps'] as const) {
    it(`refuses ${key} at exactly ${BPS_DENOMINATOR}, which is the gate disabled`, () => {
      expect(() => validateAssetMarket(market({ [key]: BPS_DENOMINATOR }))).toThrow(/switched off/)
    })

    it(`refuses ${key} above ${BPS_DENOMINATOR}`, () => {
      expect(() => validateAssetMarket(market({ [key]: 25_000 }))).toThrow(/must be an integer/)
    })

    it(`refuses a negative ${key}`, () => {
      expect(() => validateAssetMarket(market({ [key]: -1 }))).toThrow(/must be an integer/)
    })

    it(`refuses a fractional ${key}`, () => {
      expect(() => validateAssetMarket(market({ [key]: 12.5 }))).toThrow(/must be an integer/)
    })

    it(`admits ${key} at ${BPS_DENOMINATOR - 1}, one below the ceiling`, () => {
      expect(() => validateAssetMarket(market({ [key]: BPS_DENOMINATOR - 1 }))).not.toThrow()
    })
  }

  /**
   * The bound this file checks and the bound the money path checks are ONE
   * value, not two that happen to agree.
   *
   * Asserted by construction rather than by comparing two literals: every value
   * `validateAssetMarket` admits must also be one `offerWithinTolerance` will
   * act on. A config bound loosened past the runtime guard would store markets
   * that are refused on every offer; loosened the other way it would store the
   * fund-loss case.
   */
  it('never admits a spread the runtime price gate refuses outright', () => {
    for (const bps of [0, 1, 9_998, 9_999, BPS_DENOMINATOR, BPS_DENOMINATOR + 1]) {
      let admitted = true
      try {
        validateAssetMarket(market({ toleranceBps: bps, feeBps: bps }))
      } catch {
        admitted = false
      }
      // A wildly underpriced buy_base offer: it clears only if the gate is off.
      const gateIsOff = offerWithinTolerance({
        depositAmount: 1n,
        wantAmount: 100_000_000n,
        direction: 'buy_base',
        market: { baseDecimals: 8, quoteDecimals: 6, toleranceBps: bps, feeBps: bps },
        feed: priceFrom('100000'),
      })
      expect(admitted && gateIsOff).toBe(false)
    }
  })
})

describe('decimals', () => {
  it('refuses a precision past what convertAmount can carry', () => {
    expect(() => validateAssetMarket(market({ quoteDecimals: 37 }))).toThrow(/0\.\.36/)
  })

  it('refuses a fractional or negative precision', () => {
    expect(() => validateAssetMarket(market({ baseDecimals: 8.5 }))).toThrow(/0\.\.36/)
    expect(() => validateAssetMarket(market({ baseDecimals: -1 }))).toThrow(/0\.\.36/)
  })

  it('admits zero decimals, which is a legitimate asset', () => {
    expect(() => validateAssetMarket(market({ quoteDecimals: 0 }))).not.toThrow()
  })
})

describe('the feed', () => {
  it('refuses a market with no feed at all', () => {
    expect(() => validateAssetMarket(market({ feedUrl: '   ' }))).toThrow(/cannot be priced/)
  })

  it('refuses a relative URL', () => {
    expect(() => validateAssetMarket(market({ feedUrl: '/api/price' }))).toThrow(/absolute URL/)
  })

  it('refuses a file: URL, which would read the solver’s own disk', () => {
    // The admin port has no authentication of its own; a feed scheme that
    // reaches the filesystem turns a pricing knob into a file read.
    expect(() => validateAssetMarket(market({ feedUrl: 'file:///etc/passwd', pricePath: '/x' }))).toThrow(
      /http or https/,
    )
  })

  it('refuses a price path that is not an RFC 6901 pointer', () => {
    expect(() => validateAssetMarket(market({ pricePath: 'price' }))).toThrow(/JSON pointer/)
  })

  it('refuses an empty price path when it cannot be derived from the URL', () => {
    expect(() => validateAssetMarket(market({ feedUrl: 'https://unknown.test/x', pricePath: '' }))).toThrow(
      /pricePath is required/,
    )
  })

  it('admits an empty price path for a provider whose shape is known', () => {
    expect(() =>
      validateAssetMarket(market({ feedUrl: 'https://api.binance.test/ticker?symbol=BTCUSDT', pricePath: '' })),
    ).not.toThrow()
  })
})

describe('payout bounds', () => {
  it('admits a direction closed with a zero maximum', () => {
    // The documented way to make a market one-way without splitting it in two.
    expect(() => validateAssetMarket(market({ buyBase: { min: 0n, max: 0n } }))).not.toThrow()
  })

  it('refuses a minimum above its maximum, which admits no amount at all', () => {
    expect(() => validateAssetMarket(market({ sellBase: { min: 10n, max: 5n } }))).toThrow(/may not exceed/)
  })

  it('refuses a negative bound', () => {
    expect(() => validateAssetMarket(market({ sellBase: { min: -1n, max: 5n } }))).toThrow(/not be negative/)
  })
})

describe('assetMarketPolicy', () => {
  it('produces nothing at all from no markets, which is the untouched default', () => {
    expect(assetMarketPolicy([])).toEqual({ pairs: [], pricing: [] })
  })

  it('produces the pair and the pricing for a served market', () => {
    const { pairs, pricing } = assetMarketPolicy([market()])
    expect(pairs).toEqual([{ a: null, b: USDT }])
    expect(pricing[0]).toMatchObject({ base: null, quote: USDT, toleranceBps: 10, feeBps: 0 })
  })

  /**
   * The reason both lists come out of one function.
   *
   * `AssetOfferService` reads an empty `pricing` as "not opted into price
   * gating" and fills at any price, while an empty `markets` refuses
   * everything. A disabled market that left one list but not the other would
   * turn the gate off; this pins that it leaves both.
   */
  it('drops a disabled market from BOTH lists, so disabling cannot switch the price gate off', () => {
    const { pairs, pricing } = assetMarketPolicy([market({ enabled: false })])
    expect(pairs).toEqual([])
    expect(pricing).toEqual([])
  })

  it('keeps the enabled ones when only some are disabled', () => {
    const { pairs, pricing } = assetMarketPolicy([market(), market({ base: USDT, quote: OTHER, enabled: false })])
    expect(pairs).toEqual([{ a: null, b: USDT }])
    expect(pricing).toHaveLength(1)
  })

  it('omits an absent bound rather than passing an explicit undefined', () => {
    // `AssetOfferService.boundsFor` returns `bounds ?? null`, and a `max: 0n`
    // read means "direction closed" — so the difference between an absent key
    // and a present-but-undefined one is load-bearing.
    expect('sellBase' in assetMarketPolicy([market()]).pricing[0]!).toBe(false)
    expect(assetMarketPolicy([market({ sellBase: { min: 1n, max: 2n } })]).pricing[0]!.sellBase).toEqual({
      min: 1n,
      max: 2n,
    })
  })

  it('refuses two rows describing the same pair, even with the legs swapped', () => {
    // Unreachable through the store, whose primary key forbids it. Checked
    // because startup reads whatever is on disk and a hand-edited database must
    // not be able to make `pricing.find()` pick a feed by row order.
    expect(() => assetMarketPolicy([market(), market({ base: USDT, quote: null })])).toThrow(/only once/)
  })

  it('validates a DISABLED market too, rather than waving it through unread', () => {
    // A paused market is one an operator intends to resume; discovering on that
    // morning that it never loaded is discovering it at the worst moment.
    expect(() => assetMarketPolicy([market({ enabled: false, toleranceBps: BPS_DENOMINATOR })])).toThrow(/switched off/)
  })
})
