import { describe, it, expect } from 'vitest'
import {
  BTC_DECIMALS,
  assetOfOnchainAssetReceivePair,
  evaluateOnchainAssetInventory,
  onchainAssetReceivePairFor,
  resolveOnchainAssetPayout,
  type OnchainAssetMarket,
} from '@arkade-os/solver-core/core/onchainAssetReceive.js'

const ASSET = 'ab'.repeat(32) + '0100'
const OTHER = 'cd'.repeat(32) + '0000'

/** A 6-decimal asset at 100_000 units per whole BTC, no spread. */
const market = (over: Partial<OnchainAssetMarket> = {}): OnchainAssetMarket => ({
  symbol: 'USDA',
  assetId: ASSET,
  decimals: 6,
  feedUrl: 'https://feed.example/price',
  pricePath: '/price',
  feeBps: 0,
  minPayout: 1n,
  maxPayout: 10n ** 18n,
  ...over,
})

/** mantissa/10^scale quote units per whole BTC. */
const feed = (mantissa: bigint, scale = 0) => ({ mantissa, scale })

describe('the pair grammar', () => {
  it('round-trips an asset id', () => {
    expect(assetOfOnchainAssetReceivePair(onchainAssetReceivePairFor(ASSET))).toBe(ASSET)
  })

  it('refuses an uppercase id rather than normalising it', () => {
    // § 2 compares ids byte for byte. Normalising here would derive the right
    // market and then be refused downstream as unserved.
    expect(() => onchainAssetReceivePairFor(ASSET.toUpperCase())).toThrow(/LOWERCASE/)
  })

  it('does not claim pairs belonging to another corridor', () => {
    expect(assetOfOnchainAssetReceivePair('onchain:BTC->arkade:BTC')).toBeNull()
    expect(assetOfOnchainAssetReceivePair(`arkade:${ASSET}->onchain:BTC`)).toBeNull()
    expect(assetOfOnchainAssetReceivePair(`arkade:BTC->arkade:${ASSET}`)).toBeNull()
  })

  it('refuses an id of the wrong length', () => {
    expect(assetOfOnchainAssetReceivePair(`onchain:BTC->arkade:${'ab'.repeat(30)}`)).toBeNull()
  })
})

describe('the payout a give of sats resolves to', () => {
  it('prices a whole BTC through the feed at the asset precision', () => {
    // 100_000_000 sats is one whole BTC; at 50_000 quote units per BTC and 6
    // decimals that is 50_000 * 10^6 atomic units.
    const payout = resolveOnchainAssetPayout({ giveSats: 100_000_000, market: market(), feed: feed(50_000n) })
    expect(payout).toEqual({ ok: true, payoutUnits: 50_000n * 10n ** 6n })
  })

  it('scales with the give rather than being fixed', () => {
    const payout = resolveOnchainAssetPayout({ giveSats: 1_000_000, market: market(), feed: feed(50_000n) })
    expect(payout).toEqual({ ok: true, payoutUnits: 500n * 10n ** 6n })
  })

  it('takes the spread out of the payout, rounded against the client', () => {
    const payout = resolveOnchainAssetPayout({
      giveSats: 100_000_000,
      market: market({ feeBps: 100 }),
      feed: feed(50_000n),
    })
    // 1% of 50_000_000_000, rounded UP out of the floored mid.
    expect(payout).toEqual({ ok: true, payoutUnits: 50_000n * 10n ** 6n - 500_000_000n })
  })

  it('is decided by the asset decimals, not by a default', () => {
    // The misprice `evmCorridorConfig.ts` names: a 6-decimal asset read as
    // 18-decimal moves a million million times the right amount.
    const six = resolveOnchainAssetPayout({ giveSats: 100_000_000, market: market(), feed: feed(1n) })
    const eighteen = resolveOnchainAssetPayout({
      giveSats: 100_000_000,
      market: market({ decimals: 18 }),
      feed: feed(1n),
    })
    expect(six).toEqual({ ok: true, payoutUnits: 10n ** 6n })
    expect(eighteen).toEqual({ ok: true, payoutUnits: 10n ** 18n })
  })

  it('refuses an unusable price rather than quoting everything at nothing', () => {
    expect(resolveOnchainAssetPayout({ giveSats: 100_000, market: market(), feed: feed(0n) })).toEqual({
      ok: false,
      reason: 'price_unavailable',
    })
  })

  it('refuses when the fee eats the whole payout', () => {
    const payout = resolveOnchainAssetPayout({
      giveSats: 1,
      market: market({ feeBps: 9_999 }),
      feed: feed(1n),
    })
    expect(payout).toEqual({ ok: false, reason: 'fee_consumes_swap' })
  })

  it('bounds the payout in the asset own units, not in sats', () => {
    const tight = market({ maxPayout: 10n })
    expect(resolveOnchainAssetPayout({ giveSats: 100_000_000, market: tight, feed: feed(50_000n) })).toEqual({
      ok: false,
      reason: 'amount_out_of_range',
    })
  })

  it('refuses a payout under the market floor', () => {
    const floored = market({ minPayout: 10n ** 12n })
    expect(resolveOnchainAssetPayout({ giveSats: 1_000, market: floored, feed: feed(50_000n) })).toEqual({
      ok: false,
      reason: 'amount_out_of_range',
    })
  })

  it('prices the BTC leg in whole BTC', () => {
    expect(BTC_DECIMALS).toBe(8)
  })
})

describe('the inventory gate', () => {
  it('funds when the named asset covers the payout', () => {
    const available = new Map([[ASSET, 10n]])
    expect(evaluateOnchainAssetInventory({ payoutUnits: 10n, assetId: ASSET, available })).toEqual({ fund: true })
  })

  it('refuses one unit short', () => {
    const available = new Map([[ASSET, 9n]])
    expect(evaluateOnchainAssetInventory({ payoutUnits: 10n, assetId: ASSET, available })).toEqual({
      fund: false,
      reason: 'insufficient_inventory',
    })
  })

  it('counts only the NAMED asset, however much of another is held', () => {
    // A float rich in some other asset funds nothing on this market.
    const available = new Map([[OTHER, 10n ** 18n]])
    expect(evaluateOnchainAssetInventory({ payoutUnits: 1n, assetId: ASSET, available })).toEqual({
      fund: false,
      reason: 'insufficient_inventory',
    })
  })

  it('treats an absent balance as zero rather than as unknown', () => {
    expect(evaluateOnchainAssetInventory({ payoutUnits: 1n, assetId: ASSET, available: new Map() })).toEqual({
      fund: false,
      reason: 'insufficient_inventory',
    })
  })
})
