/**
 * The pure decision logic for `lightning:BTC<->arkade:<asset>` — the pair
 * grammar, the two quotes, and the inventory gate.
 *
 * The properties worth pinning hardest are the rounding DIRECTIONS, because
 * they are opposite on the two legs and each is at most one atomic unit: on
 * `receive` the solver pays the asset, so the payout floors and the fee ceils;
 * on `send` an invoice fixes the payout, so the client's give ceils and the fee
 * is added on top. Either one flipped is a leak the solver funds on every swap
 * in that direction, and no test that only checks "roughly the right size"
 * would see it.
 */

import { describe, it, expect } from 'vitest'
import {
  BTC_DECIMALS,
  evaluateLnAssetInventory,
  lnAssetDirectionOf,
  lnAssetEnvStem,
  lnAssetIdOf,
  lnAssetPairFor,
  LN_ASSET_QUOTE_WINDOW,
  resolveLnAssetReceiveQuote,
  resolveLnAssetSendQuote,
  type LnAssetMarket,
} from '@arkade-os/solver-core/core/lnAsset.js'
import { priceFrom } from '@arkade-os/solver-core/core/priceFeed.js'

const ASSET = `${'aa'.repeat(32)}0100`
const OTHER = `${'bb'.repeat(32)}0000`

/** 1 BTC = 100,000 whole units of a 6-decimal asset. */
const MARKET: LnAssetMarket = {
  assetId: ASSET,
  symbol: 'USDA',
  decimals: 6,
  feeBps: 0,
  limits: { minSats: 1, maxSats: 100_000_000 },
  inventoryCeiling: null,
  feedUrl: 'https://feed.example/price',
  pricePath: '/price',
}

const PRICE = priceFrom('100000')

describe('the pair grammar', () => {
  it('builds and reads both directions', () => {
    expect(lnAssetPairFor(ASSET, 'receive')).toBe(`lightning:BTC->arkade:${ASSET}`)
    expect(lnAssetPairFor(ASSET, 'send')).toBe(`arkade:${ASSET}->lightning:BTC`)
    expect(lnAssetDirectionOf(`lightning:BTC->arkade:${ASSET}`)).toBe('receive')
    expect(lnAssetDirectionOf(`arkade:${ASSET}->lightning:BTC`)).toBe('send')
    expect(lnAssetIdOf(`arkade:${ASSET}->lightning:BTC`)).toBe(ASSET)
  })

  /**
   * § 2 compares asset ids byte for byte and does not normalise. An uppercase
   * spelling accepted here would derive the right market and then be refused as
   * unserved somewhere downstream, with a stated reason that is a lie.
   */
  it('refuses an uppercase asset id rather than normalising it', () => {
    expect(() => lnAssetPairFor(ASSET.toUpperCase(), 'send')).toThrow(/lowercase hex/)
    expect(lnAssetDirectionOf(`arkade:${ASSET.toUpperCase()}->lightning:BTC`)).toBeNull()
  })

  it('does not answer for the corridors of another family', () => {
    for (const pair of [
      'arkade:BTC->lightning:BTC',
      'lightning:BTC->arkade:BTC',
      `arkade:${ASSET}->arkade:BTC`,
      'arkade:BTC->ethereum:0x0000000000000000000000000000000000000000',
    ]) {
      expect(lnAssetDirectionOf(pair)).toBeNull()
      expect(lnAssetIdOf(pair)).toBeNull()
    }
  })

  /** A 68-hex id is a legal shell identifier and an unusable one. */
  it('stems the env from the symbol, distinctly from the atomic-class stem', () => {
    expect(lnAssetEnvStem({ symbol: 'usda' }, 'receive')).toBe('LN_ASSET_USDA_RECEIVE')
    expect(lnAssetEnvStem({ symbol: 'USDA' }, 'send')).toBe('LN_ASSET_USDA_SEND')
    expect(lnAssetEnvStem({ symbol: 'USDA' }, 'send')).not.toBe('ASSET_USDA_SELL')
  })
})

describe('resolveLnAssetReceiveQuote — the client pays sats, the solver delivers the asset', () => {
  it('converts sats to atomic asset units at the feed rate', () => {
    // 100_000_000 sats = 1 BTC = 100_000 whole units = 100_000 * 10^6 atomic.
    const quote = resolveLnAssetReceiveQuote({ giveSats: 100_000_000, market: MARKET, feed: PRICE })
    expect(quote).toEqual({ ok: true, giveSats: 100_000_000, payoutAsset: 100_000_000_000n })
  })

  /**
   * The direction that decides money. A payout rounded UP hands the client a
   * sub-unit of the solver's asset on every swap that does not divide exactly.
   */
  it('floors the payout and ceils the fee out of it', () => {
    const market = { ...MARKET, feeBps: 30 }
    // 3 sats at this rate is 3000 atomic units mid; a 30bps fee is 9 exactly.
    const quote = resolveLnAssetReceiveQuote({ giveSats: 3, market, feed: PRICE })
    expect(quote).toEqual({ ok: true, giveSats: 3, payoutAsset: 2991n })

    // 1 sat is 1000 mid; 30bps of 1000 is 3 exactly, so pick a rate with a
    // remainder to prove the fee ceils rather than truncates.
    const odd = resolveLnAssetReceiveQuote({ giveSats: 1, market: { ...market, feeBps: 1 }, feed: PRICE })
    // 1000 * 1 / 10000 = 0.1, ceiled to 1.
    expect(odd).toEqual({ ok: true, giveSats: 1, payoutAsset: 999n })
  })

  it('refuses when the fee eats the whole payout, by its own name', () => {
    const market = { ...MARKET, decimals: 0, feeBps: 9_999 }
    // 1 sat at 100000 asset-per-BTC with 0 decimals is 0 atomic units mid.
    expect(resolveLnAssetReceiveQuote({ giveSats: 1, market, feed: PRICE })).toEqual({
      ok: false,
      reason: 'fee_consumes_swap',
    })
  })

  it('bounds the sats give', () => {
    const market = { ...MARKET, limits: { minSats: 1000, maxSats: 2000 } }
    expect(resolveLnAssetReceiveQuote({ giveSats: 999, market, feed: PRICE })).toEqual({
      ok: false,
      reason: 'amount_out_of_range',
    })
    expect(resolveLnAssetReceiveQuote({ giveSats: 2001, market, feed: PRICE })).toEqual({
      ok: false,
      reason: 'amount_out_of_range',
    })
  })

  /**
   * The second gate, in the asset's own unit. It is redundant while the price is
   * what the operator expects and stops being redundant exactly when it is not —
   * the case the sats bound cannot see.
   */
  it('bounds the asset payout additively to the sats bound', () => {
    const market = { ...MARKET, assetLimits: { minUnits: 1n, maxUnits: 1_000n } }
    // Inside the sats bound, far outside the asset bound.
    expect(resolveLnAssetReceiveQuote({ giveSats: 100_000_000, market, feed: PRICE })).toEqual({
      ok: false,
      reason: 'amount_out_of_range',
    })
    expect(resolveLnAssetReceiveQuote({ giveSats: 1, market, feed: PRICE })).toEqual({
      ok: true,
      giveSats: 1,
      payoutAsset: 1_000n,
    })
  })

  it('refuses an unusable feed or an unusable spread rather than pricing at nothing', () => {
    expect(resolveLnAssetReceiveQuote({ giveSats: 1000, market: MARKET, feed: { mantissa: 0n, scale: 0 } })).toEqual({
      ok: false,
      reason: 'price_unavailable',
    })
    expect(resolveLnAssetReceiveQuote({ giveSats: 1000, market: { ...MARKET, feeBps: 10_000 }, feed: PRICE })).toEqual({
      ok: false,
      reason: 'price_unavailable',
    })
    expect(resolveLnAssetReceiveQuote({ giveSats: 1000, market: { ...MARKET, feeBps: -1 }, feed: PRICE })).toEqual({
      ok: false,
      reason: 'price_unavailable',
    })
  })
})

describe('resolveLnAssetSendQuote — the client locks the asset, the solver pays the invoice', () => {
  it('solves the give up from the invoice amount', () => {
    const quote = resolveLnAssetSendQuote({ payoutSats: 100_000_000, market: MARKET, feed: PRICE })
    expect(quote).toEqual({ ok: true, payoutSats: 100_000_000, giveAsset: 100_000_000_000n })
  })

  /**
   * The MIRROR of the receive leg's direction, and it has to be: here the payout
   * is fixed by an invoice, so the only side left to round is the client's give,
   * and rounding it down would pay the invoice for less asset than the rate asks.
   */
  it('ceils the give and adds the fee on top', () => {
    // A rate with a remainder: 3 asset-per-BTC over 10^8 sats never divides.
    const feed = priceFrom('3')
    const market = { ...MARKET, feeBps: 100 }
    const quote = resolveLnAssetSendQuote({ payoutSats: 1, market, feed })
    // 1 sat -> 3 * 10^6 / 10^8 = 0.03 atomic units, ceiled to 1; +100bps of 1
    // ceiled to 1 = 2.
    expect(quote).toEqual({ ok: true, payoutSats: 1, giveAsset: 2n })
  })

  it('bounds the sats payout', () => {
    const market = { ...MARKET, limits: { minSats: 1000, maxSats: 2000 } }
    expect(resolveLnAssetSendQuote({ payoutSats: 2001, market, feed: PRICE })).toEqual({
      ok: false,
      reason: 'amount_out_of_range',
    })
  })

  it('bounds the asset give additively', () => {
    const market = { ...MARKET, assetLimits: { minUnits: 1n, maxUnits: 10n } }
    expect(resolveLnAssetSendQuote({ payoutSats: 100_000_000, market, feed: PRICE })).toEqual({
      ok: false,
      reason: 'amount_out_of_range',
    })
  })

  it('refuses a non-positive or non-integer payout', () => {
    for (const payoutSats of [0, -1, 1.5, Number.NaN]) {
      expect(resolveLnAssetSendQuote({ payoutSats, market: MARKET, feed: PRICE })).toEqual({
        ok: false,
        reason: 'amount_out_of_range',
      })
    }
  })
})

describe('evaluateLnAssetInventory — opposite questions in the two directions', () => {
  it('paying the asset out needs enough of it to pay', () => {
    expect(evaluateLnAssetInventory({ direction: 'receive', held: 99n, amount: 100n, ceiling: null })).toEqual({
      ok: false,
      reason: 'insufficient_inventory',
    })
    expect(evaluateLnAssetInventory({ direction: 'receive', held: 100n, amount: 100n, ceiling: null })).toEqual({
      ok: true,
    })
  })

  /**
   * The bound #21 § 6 argues for: the solver has already paid sats by the time
   * it claims the asset, so an unbounded position is an unbounded unhedged one.
   * A ceiling in the asset's own units is the only bound expressible without an
   * oracle.
   */
  it('taking the asset in needs room under the ceiling, and a ceiling of null is unbounded', () => {
    expect(evaluateLnAssetInventory({ direction: 'send', held: 90n, amount: 20n, ceiling: 100n })).toEqual({
      ok: false,
      reason: 'inventory_ceiling_reached',
    })
    expect(evaluateLnAssetInventory({ direction: 'send', held: 80n, amount: 20n, ceiling: 100n })).toEqual({ ok: true })
    expect(evaluateLnAssetInventory({ direction: 'send', held: 10n ** 30n, amount: 1n, ceiling: null })).toEqual({
      ok: true,
    })
  })

  /** The ceiling never gates the leg that DRAINS the position. */
  it('does not apply the ceiling to the receive direction', () => {
    expect(evaluateLnAssetInventory({ direction: 'receive', held: 1_000n, amount: 100n, ceiling: 1n })).toEqual({
      ok: true,
    })
  })
})

describe('the quote window', () => {
  /**
   * § 5's cross-asset rule. The BTC legs' 15-minute `DEFAULT_LOCKUP_TIMEOUT`
   * would be a free 15-minute option on the asset/BTC rate, which is exactly the
   * exposure this family has and the BTC legs do not.
   */
  it('is far shorter than the same-asset legs', () => {
    expect(LN_ASSET_QUOTE_WINDOW).toBeLessThan(15 * 60)
    expect(LN_ASSET_QUOTE_WINDOW).toBeGreaterThan(0)
  })

  it('prices BTC in whole units, so sats amounts are atomic', () => {
    expect(BTC_DECIMALS).toBe(8)
  })
})

describe('one market, both directions', () => {
  /**
   * The round trip a market maker cares about: quoting a give and then quoting
   * the mirror of that payout must never hand the client back MORE than they
   * started with at a zero spread. Rounding in one direction on both legs is
   * exactly how that invariant breaks.
   */
  it('never round-trips into a profit for the client at a zero spread', () => {
    for (const giveSats of [1, 7, 999, 100_003, 5_000_000]) {
      const out = resolveLnAssetReceiveQuote({ giveSats, market: MARKET, feed: PRICE })
      if (!out.ok) continue
      const back = resolveLnAssetSendQuote({ payoutSats: giveSats, market: MARKET, feed: PRICE })
      if (!back.ok) continue
      expect(back.giveAsset).toBeGreaterThanOrEqual(out.payoutAsset)
    }
  })

  it('keeps the two markets distinguishable by asset id', () => {
    expect(lnAssetIdOf(lnAssetPairFor(ASSET, 'send'))).toBe(ASSET)
    expect(lnAssetIdOf(lnAssetPairFor(OTHER, 'send'))).toBe(OTHER)
  })
})
