import { describe, expect, it } from 'vitest'
import { resolveAssetQuote, type AssetQuoteMarket } from '@arkade-os/solver-core/core/assetRfq.js'
import { offerWithinTolerance } from '@arkade-os/solver-core/core/assetOfferPrice.js'
import { feeSatsFor, giveSatsFor, payoutSatsFor } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { withBounds } from '@arkade-os/solver-core/core/limits.js'
import { networkFeePricing } from '@arkade-os/solver-core/core/pricing.js'
import { decomposeCorridorQuote } from '@arkade-os/solver-core/core/pricingPreview.js'
import { convertAmount, convertQuoteToBase, priceFrom } from '@arkade-os/solver-core/core/priceFeed.js'
import { Fee } from '@arkade-os/solver-core/domain/market/fee.js'
import { Limits } from '@arkade-os/solver-core/domain/market/limits.js'
import { Pair } from '@arkade-os/solver-core/domain/market/pair.js'
import { Price } from '@arkade-os/solver-core/domain/market/price.js'
import { AssetPricing } from '@arkade-os/solver-core/domain/market/asset_pricing.js'
import { Route } from '@arkade-os/solver-core/domain/market/route.js'
import { SpreadPricing } from '@arkade-os/solver-core/domain/market/spread_pricing.js'
import { Endpoint } from '@arkade-os/solver-core/domain/shared/endpoint.js'
import { ARKADE, BTC, btc, LIGHTNING, USDT, usdt } from '../support.js'

describe('fee', () => {
  it('matches the corridor fee arithmetic it replaces', () => {
    for (const [bps, flat] of [
      [0, 0],
      [25, 0],
      [0, 150],
      [99, 7],
      [9_999, 1],
    ] as const) {
      const fee = Fee.of(bps, BigInt(flat))
      const legacy = { bps, flatSats: flat }
      for (const amount of [1, 2, 399, 400, 401, 10_000, 123_457, 50_000_000]) {
        expect(fee.on(BigInt(amount))).toBe(BigInt(feeSatsFor(amount, legacy)))
        expect(fee.payoutFor(BigInt(amount))).toBe(BigInt(payoutSatsFor(amount, legacy)))
        expect(fee.giveFor(BigInt(amount))).toBe(BigInt(giveSatsFor(amount, legacy)))
      }
    }
  })

  it('gives the least input that still pays out the amount asked for', () => {
    const fee = Fee.of(37, 11n)
    for (const payout of [1n, 999n, 12_345n]) {
      const give = fee.giveFor(payout)
      expect(fee.payoutFor(give)).toBeGreaterThanOrEqual(payout)
      expect(fee.payoutFor(give - 1n)).toBeLessThan(payout)
    }
  })

  it('refuses 100% and negative fees', () => {
    expect(() => Fee.of(10_000, 0n)).toThrow('0..9999 bps')
    expect(() => Fee.of(1, -1n)).toThrow('negative')
  })
})

describe('limits', () => {
  const limits = Limits.of(500n, 50_000n)

  it('names which side an amount breaches', () => {
    expect(limits.breach(499n)).toBe('below_min')
    expect(limits.breach(500n)).toBeNull()
    expect(limits.breach(50_001n)).toBe('above_max')
  })

  it('takes an override exactly as the bounds it replaces', () => {
    const base = { minSats: 500, maxSats: 50_000 }
    const bounds = [undefined, -1, 0, 100, 500, 1_000, 50_000, 60_000, 99_999]
    for (const min of bounds) {
      for (const max of bounds) {
        const attempt = <T>(run: () => T): T | 'throws' => {
          try {
            return run()
          } catch {
            return 'throws'
          }
        }
        const legacy = attempt(() => withBounds(base, { minSats: min, maxSats: max }))
        const actual = attempt(() =>
          limits.withBounds({
            ...(min === undefined ? {} : { min: BigInt(min) }),
            ...(max === undefined ? {} : { max: BigInt(max) }),
          }),
        )
        expect(actual, `${min}..${max}`).toEqual(
          legacy === 'throws' ? 'throws' : Limits.of(BigInt(legacy.minSats), BigInt(legacy.maxSats)),
        )
      }
    }
  })
})

describe('price', () => {
  it('converts both ways exactly as the feed arithmetic it replaces', () => {
    for (const text of ['97123.45', '0.00001029', '1', '3']) {
      const price = Price.parse(text)
      const legacy = priceFrom(text)
      for (const units of [1n, 7n, 100_000_000n, 123_456_789n]) {
        for (const rounding of ['down', 'up'] as const) {
          const args = { price: legacy, baseDecimals: 8, quoteDecimals: 6, rounding }
          expect(price.toQuote(units, 8, 6, rounding)).toBe(convertAmount({ ...args, baseAmount: units }))
          expect(price.toBase(units, 8, 6, rounding)).toBe(convertQuoteToBase({ ...args, quoteAmount: units }))
        }
      }
    }
  })

  it.each(['0', '-1', '1e5', 'abc', '1.', `${'9'.repeat(37)}`])('refuses %s', (text) => {
    expect(() => Price.parse(text)).toThrow()
  })
})

describe('spread pricing', () => {
  it('quotes and refuses exactly as the corridor preview it replaces', () => {
    for (const [bps, flat] of [
      [0, 0],
      [25, 2],
      [0, 600],
      [9_999, 0],
    ] as const) {
      for (const [min, max] of [
        [500, 50_000],
        [1, 1_000_000],
      ] as const) {
        const pricing = SpreadPricing.of(Fee.of(bps, BigInt(flat)), Limits.of(BigInt(min), BigInt(max)))
        for (const side of ['from', 'to'] as const) {
          for (const amount of [1, 499, 500, 600, 601, 10_000, 50_000, 50_001, 2_000_000]) {
            const legacy = decomposeCorridorQuote({
              amountSats: amount,
              amountSide: side,
              fee: { bps, flatSats: flat },
              limits: { minSats: min, maxSats: max },
            })
            const expected = legacy.ok
              ? { ok: true, give: BigInt(legacy.giveSats), payout: BigInt(legacy.payoutSats) }
              : { ok: false, reason: legacy.reason === 'fee_consumes_swap' ? legacy.reason : 'amount_out_of_range' }
            expect(pricing.quote(BigInt(amount), side), `${bps}/${flat} ${side} ${amount}`).toEqual(expected)
          }
        }
      }
    }
  })

  it('replaces the flat fee with the network cost exactly as the strategy it replaces', () => {
    const base = { bps: 30, flatSats: 200 }
    for (const cost of [null, Number.NaN, -1, 0, 149.2, 150, 4_000]) {
      for (const [cap, min] of [
        [1_000, 0],
        [1_000, 250],
        [100, 100],
      ] as const) {
        const legacy = networkFeePricing({ base, costSats: () => cost, capSats: cap, minSats: min })
        const fee = Fee.of(base.bps, BigInt(base.flatSats)).withNetworkCost(cost, BigInt(cap), BigInt(min))
        for (const amount of [1_000, 77_777]) {
          expect(fee.payoutFor(BigInt(amount))).toBe(BigInt(legacy.payoutFor({ pair: 'p', giveSats: amount })))
          expect(fee.giveFor(BigInt(amount))).toBe(BigInt(legacy.giveFor({ pair: 'p', payoutSats: amount })))
        }
      }
    }
    expect(() => Fee.FREE.withNetworkCost(1, 10n, 11n)).toThrow('exceeds its cap')
  })
})

describe('the destination floor', () => {
  const pricing = SpreadPricing.of(Fee.of(100, 10n), Limits.of(1n, 1_000_000n))

  it('refuses a payout the destination cannot hold, after the fee check', () => {
    expect(pricing.quote(1_000n, 'from', 980n)).toEqual({ ok: true, give: 1_000n, payout: 980n })
    expect(pricing.quote(1_000n, 'from', 981n)).toEqual({ ok: false, reason: 'payout_below_dust' })
    expect(pricing.quote(329n, 'to', 330n)).toEqual({ ok: false, reason: 'payout_below_dust' })
    expect(pricing.quote(10n, 'from', 330n)).toEqual({ ok: false, reason: 'fee_consumes_swap' })
  })
})

describe('asset pricing', () => {
  const ASSET = USDT
  const feeds = ['97123.45', '0.00001029', '1']
  const markets: (Omit<AssetQuoteMarket, 'base' | 'quote'> & { baseIsBtc: boolean })[] = [
    { baseIsBtc: true, baseDecimals: 8, quoteDecimals: 6, feeBps: 30, minPayout: 1n, maxPayout: 10n ** 15n },
    {
      baseIsBtc: false,
      baseDecimals: 6,
      quoteDecimals: 8,
      feeBps: 50,
      sellBaseFeeBps: 10,
      buyBaseFeeBps: 80,
      sellBaseFeeFlat: 7n,
      buyBaseFeeFlat: 330n,
      minPayout: 1_000n,
      maxPayout: 5_000_000n,
    },
    { baseIsBtc: true, baseDecimals: 8, quoteDecimals: 0, feeBps: 0, minPayout: 0n, maxPayout: 0n },
  ]

  const build = ({ baseIsBtc, ...market }: (typeof markets)[number], toleranceBps = 0) => {
    const [base, quote] = baseIsBtc ? [BTC, ASSET] : [ASSET, BTC]
    const pair = Pair.of(
      { asset: base, decimals: market.baseDecimals },
      { asset: quote, decimals: market.quoteDecimals },
      'feed',
    )
    const pricing = AssetPricing.of({ ...market, pair, native: BTC, toleranceBps })
    const legacy: AssetQuoteMarket = { ...market, base: baseIsBtc ? null : ASSET, quote: baseIsBtc ? ASSET : null }
    return { pricing, legacy }
  }

  it('quotes and refuses exactly as resolveAssetQuote', () => {
    let compared = 0
    for (const spec of markets) {
      const { pricing, legacy } = build(spec)
      for (const feed of feeds) {
        for (const [from, to] of [
          [BTC, ASSET],
          [ASSET, BTC],
          [ASSET, ASSET],
        ] as const) {
          for (const side of ['from', 'to'] as const) {
            for (const amount of [0n, 1n, 329n, 331n, 1_000n, 54_321n, 9_999_999n, 10n ** 13n]) {
              for (const [carrier, dust] of [
                [0n, 0n],
                [330n, 546n],
                [-1n, 0n],
              ] as const) {
                const expected = resolveAssetQuote({
                  pair: { from: from === BTC ? null : from, to: to === BTC ? null : to },
                  amount,
                  amountSide: side,
                  market: legacy,
                  feed: priceFrom(feed),
                  carrierSats: carrier,
                  dustSats: dust,
                })
                for (const minOutput of [0n, 1_000n]) {
                  const request = { from, to, amount, side, price: Price.parse(feed), carrier, dust, minOutput }
                  // The floor as the asset orchestrator applies it, after the quote resolved.
                  const floored = expected.ok && to === BTC && expected.toAmount < minOutput
                  expect(pricing.quote(request), `${feed} ${from}->${to} ${side} ${amount} c${carrier}`).toEqual(
                    floored
                      ? { ok: false, reason: 'payout_below_dust' }
                      : expected.ok
                        ? { ok: true, give: expected.fromAmount, payout: expected.toAmount }
                        : expected,
                  )
                  compared++
                }
              }
            }
          }
        }
      }
    }
    expect(compared).toBe(3 * 3 * 3 * 2 * 8 * 3 * 2)
  })

  it('accepts an offer exactly as offerWithinTolerance', () => {
    for (const spec of markets.slice(0, 2)) {
      for (const toleranceBps of [0, 150]) {
        const { pricing, legacy } = build(spec, toleranceBps)
        for (const feed of feeds) {
          for (const direction of ['sell_base', 'buy_base'] as const) {
            const [base, quote] = spec.baseIsBtc ? [BTC, ASSET] : [ASSET, BTC]
            const [deposit, want] = direction === 'sell_base' ? [base, quote] : [quote, base]
            for (const depositAmount of [0n, 500n, 100_000n]) {
              for (const wantAmount of [1n, 480n, 97_000n, 10n ** 9n]) {
                for (const [carrierCharged, carrierReturned] of [
                  [0n, 0n],
                  [330n, 0n],
                  [0n, 330n],
                ] as const) {
                  const args = { depositAmount, wantAmount, carrierCharged, carrierReturned }
                  expect(pricing.acceptsOffer({ ...args, deposit, want, price: Price.parse(feed) })).toBe(
                    offerWithinTolerance({
                      ...args,
                      direction,
                      market: { ...legacy, toleranceBps },
                      feed: priceFrom(feed),
                    }),
                  )
                }
              }
            }
          }
        }
      }
    }
  })

  it('refuses a market that could not be configured', () => {
    const { baseIsBtc: _, ...market } = markets[0]!
    const pair = Pair.of({ asset: BTC, decimals: 8 }, { asset: ASSET, decimals: 6 }, 'feed')
    const make = (override: object) => AssetPricing.of({ ...market, pair, native: BTC, toleranceBps: 0, ...override })
    expect(() => make({ feeBps: 10_000 })).toThrow('0..9999')
    expect(() => make({ buyBaseFeeFlat: -1n })).toThrow('negative')
    expect(() => Pair.of({ asset: BTC, decimals: 8 }, { asset: BTC, decimals: 8 }, 'feed')).toThrow('two assets')
  })
})

describe('route', () => {
  const spread = SpreadPricing.of(Fee.of(25, 2n), Limits.of(500n, 50_000n))
  const route = Route.of({ from: ARKADE, to: LIGHTNING, enabled: true, pricing: spread })

  it('is a corridor when it leaves Arkade', () => {
    expect(route.id).toBe('arkade:btc->lightning:btc')
    expect(route.isCorridor).toBe(true)
    expect(Route.of({ from: LIGHTNING, to: ARKADE, enabled: true, pricing: spread }).isCorridor).toBe(false)
  })

  it('quotes in amounts of its two endpoints', () => {
    expect(route.quote(btc(10_000n), 'from')).toEqual({ ok: true, terms: { give: btc(10_000n), payout: btc(9_973n) } })
    expect(route.quote(btc(499n), 'from')).toEqual({ ok: false, reason: 'amount_out_of_range' })
    const closed = Route.of({ from: ARKADE, to: LIGHTNING, enabled: false, pricing: spread })
    expect(closed.quote(btc(10_000n), 'from')).toEqual({ ok: false, reason: 'route_disabled' })
  })

  it('is priced by a market exactly when it changes asset', () => {
    const usdtOnArkade = Endpoint.of('arkade', USDT)
    const pair = Pair.of({ asset: BTC, decimals: 8 }, { asset: USDT, decimals: 6 }, 'feed:btcusdt')
    const market = AssetPricing.of({
      pair,
      native: BTC,
      feeBps: 30,
      toleranceBps: 0,
      minPayout: 1n,
      maxPayout: 10n ** 12n,
    })
    expect(() => Route.of({ from: ARKADE, to: usdtOnArkade, enabled: true, pricing: spread })).toThrow('exactly when')
    expect(() => Route.of({ from: ARKADE, to: LIGHTNING, enabled: true, pricing: market })).toThrow('exactly when')
    expect(() => Route.of({ from: ARKADE, to: ARKADE, enabled: true, pricing: spread })).toThrow('back to itself')
    const cross = Route.of({ from: ARKADE, to: usdtOnArkade, enabled: true, pricing: market })
    expect(cross.quote(btc(10_000n), 'from')).toEqual({ ok: false, reason: 'price_unavailable' })
    const quote = cross.quote(btc(10_000n), 'from', {
      price: Price.parse('97123.45'),
      carrier: btc(330n),
      dust: btc(546n),
    })
    expect(quote).toMatchObject({ ok: true, terms: { give: btc(10_000n) } })
    expect(quote.ok && quote.terms.payout.asset).toBe(USDT)
    expect(() => cross.quote(btc(10_000n), 'to')).toThrow('takes usdt on its to side')
    expect(() => route.quote(btc(10_000n), 'from', undefined, { minOutput: usdt(330n) })).toThrow('pays out btc')
    expect(route.quote(btc(10_000n), 'from', undefined, { minOutput: btc(9_974n) })).toEqual({
      ok: false,
      reason: 'payout_below_dust',
    })
  })
})
