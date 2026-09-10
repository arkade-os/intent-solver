/**
 * The join that turns `ASSET_MARKETS` plus the console's market rows into the
 * corridors a deployment serves.
 *
 * Two failure directions, and only one of them is loud on its own: a symbol that
 * cannot be a stem is caught by the registry at composition, while a market
 * served with no bounds would quote an unbounded payout out of the float.
 */
import { describe, it, expect } from 'vitest'
import {
  assetRfqMarketsFrom,
  parseAssetRfqTokens,
  ungatedAssetSymbols,
} from '@arkade-os/solver-app/ops/assetRfqMarkets.js'
import { assetRfqDescriptor, assetRfqEnvStem } from '@arkade-os/solver-corridors/corridors/assetRfq.js'
import type { AssetMarketPricingView } from '@arkade-os/solver-core/core/assetMarketConfig.js'

const USDA = '1a'.repeat(34)
const OTHER = '2b'.repeat(34)
const none = () => undefined

const pricing = (over: Partial<AssetMarketPricingView> = {}): AssetMarketPricingView => ({
  base: null,
  quote: USDA,
  baseDecimals: 8,
  quoteDecimals: 6,
  feedUrl: 'https://feed.test/price',
  pricePath: '/price',
  toleranceBps: 10,
  feeBps: 25,
  sellBase: { min: 1n, max: 10n ** 12n },
  buyBase: { min: 2n, max: 10n ** 9n },
  ...over,
})

describe('parseAssetRfqTokens', () => {
  it('serves nothing when unset or empty, which is the default', () => {
    expect(parseAssetRfqTokens(undefined, none)).toEqual([])
    expect(parseAssetRfqTokens('   ', none)).toEqual([])
  })

  it('reads SYMBOL:<asset id>, both directions on and no approval threshold', () => {
    expect(parseAssetRfqTokens(`USDA:${USDA}`, none)).toEqual([
      { symbol: 'USDA', assetId: USDA, enabled: { sell_base: true, buy_base: true }, approvalThresholdUnits: null },
    ])
  })

  it('reads ASSET_<SYMBOL>_APPROVAL_THRESHOLD as atomic units, past what a double holds', () => {
    const read = (name: string) => (name === 'ASSET_USDA_APPROVAL_THRESHOLD' ? '18446744073709551617' : undefined)
    expect(parseAssetRfqTokens(`USDA:${USDA}`, read)[0]!.approvalThresholdUnits).toBe(2n ** 64n + 1n)
  })

  // At BOOT, so a malformed threshold can never become a runtime `unreadable`.
  it.each([['-1'], ['1.5'], ['1e6'], ['many']])('refuses %s as an approval threshold', (raw) => {
    const read = (name: string) => (name === 'ASSET_USDA_APPROVAL_THRESHOLD' ? raw : undefined)
    expect(() => parseAssetRfqTokens(`USDA:${USDA}`, read)).toThrow(/ASSET_USDA_APPROVAL_THRESHOLD/)
  })

  it('treats a blank threshold as unset rather than zero, which would gate everything', () => {
    const read = (name: string) => (name === 'ASSET_USDA_APPROVAL_THRESHOLD' ? '   ' : undefined)
    expect(parseAssetRfqTokens(`USDA:${USDA}`, read)[0]!.approvalThresholdUnits).toBeNull()
  })

  it('closes exactly the direction whose stem says so', () => {
    // The stems are the corridor's own, not restated here: a rename there must
    // change which variable an operator sets, not silently stop being read.
    const read = (name: string) =>
      name === `${assetRfqEnvStem({ symbol: 'USDA' }, 'buy_base')}_ENABLED` ? 'false' : undefined
    expect(parseAssetRfqTokens(`USDA:${USDA}`, read)[0]!.enabled).toEqual({ sell_base: true, buy_base: false })
  })

  it('refuses a direction flag that is neither true nor false', () => {
    const stem = `${assetRfqEnvStem({ symbol: 'USDA' }, 'buy_base')}_ENABLED`
    for (const bad of ['flase', 'FALSE', '0', 'no']) {
      expect(() => parseAssetRfqTokens(`USDA:${USDA}`, (name) => (name === stem ? bad : undefined))).toThrow(
        /_ENABLED must be 'true' or 'false'/,
      )
    }
  })

  it('refuses an entry that is not SYMBOL:<asset id>', () => {
    expect(() => parseAssetRfqTokens(USDA, none)).toThrow(/must be SYMBOL/)
    expect(() => parseAssetRfqTokens(`USDA:${USDA}:6`, none)).toThrow(/must be SYMBOL/)
  })

  it('refuses a symbol that is not a legal stem fragment', () => {
    expect(() => parseAssetRfqTokens(`usda:${USDA}`, none)).toThrow(/uppercase alphanumerics/)
    expect(() => parseAssetRfqTokens(`US-DA:${USDA}`, none)).toThrow(/uppercase alphanumerics/)
  })

  it('refuses an asset id that is not the canonical 68-hex form', () => {
    // Uppercase hex is refused rather than normalised, the § 2 rule: a pair is
    // compared byte for byte, so a spelling accepted here is refused later as
    // unserved, with a stated reason that is a lie.
    expect(() => parseAssetRfqTokens(`USDA:${USDA.toUpperCase()}`, none)).toThrow(/68 lowercase hex/)
    expect(() => parseAssetRfqTokens('USDA:beef', none)).toThrow(/68 lowercase hex/)
  })

  it('refuses a repeated symbol, which would collide two markets onto one stem', () => {
    expect(() => parseAssetRfqTokens(`USDA:${USDA},USDA:${OTHER}`, none)).toThrow(/symbol USDA twice/)
  })

  it('refuses a repeated asset, which would register one pair twice', () => {
    expect(() => parseAssetRfqTokens(`USDA:${USDA},USDB:${USDA}`, none)).toThrow(/asset .* twice/)
  })
})

describe('assetRfqMarketsFrom', () => {
  const token = (over = {}) => ({
    symbol: 'USDA',
    assetId: USDA,
    enabled: { sell_base: true, buy_base: true },
    approvalThresholdUnits: null,
    ...over,
  })

  it('carries the console row through, market for market', () => {
    const [market] = assetRfqMarketsFrom([token()], [pricing()])
    expect(market).toEqual({
      base: null,
      quote: USDA,
      symbol: 'USDA',
      baseDecimals: 8,
      quoteDecimals: 6,
      feeBps: 25,
      sellBase: { min: 1n, max: 10n ** 12n },
      buyBase: { min: 2n, max: 10n ** 9n },
      feedUrl: 'https://feed.test/price',
      pricePath: '/price',
    })
  })

  it('produces the pair the corridor will be registered under', () => {
    const [market] = assetRfqMarketsFrom([token()], [pricing()])
    expect(assetRfqDescriptor(market!, 'sell_base').pair).toBe(`arkade:BTC->arkade:${USDA}`)
    expect(assetRfqDescriptor(market!, 'buy_base').pair).toBe(`arkade:${USDA}->arkade:BTC`)
  })

  it('finds the row whichever leg the asset sits on', () => {
    const [market] = assetRfqMarketsFrom([token()], [pricing({ base: USDA, quote: null })])
    expect([market!.base, market!.quote]).toEqual([USDA, null])
  })

  it('serves nothing when nothing is named, whatever the console holds', () => {
    expect(assetRfqMarketsFrom([], [pricing()])).toEqual([])
  })

  it('refuses to start on an asset the console does not price', () => {
    // Dropping it would come up serving nothing, which reads as a quiet market
    // rather than as the misconfiguration it is.
    expect(() => assetRfqMarketsFrom([token()], [])).toThrow(/no enabled market in the console prices it/)
    expect(() => assetRfqMarketsFrom([token()], [pricing({ quote: OTHER })])).toThrow(/prices it/)
  })

  it('refuses a market with an asset on both legs, which no offer packet expresses', () => {
    expect(() => assetRfqMarketsFrom([token()], [pricing({ base: OTHER, quote: USDA })])).toThrow(/asset on both legs/)
  })

  it('refuses a served direction the console left unbounded', () => {
    // No fallback to the packet path's `OFFER_MIN_FILL_AMOUNT`: that is a sats
    // figure, and this payout leg can be an asset's atomic units.
    expect(() => assetRfqMarketsFrom([token()], [pricing({ sellBase: undefined })])).toThrow(
      /states no sellBase bounds/,
    )
    expect(() => assetRfqMarketsFrom([token()], [pricing({ buyBase: undefined })])).toThrow(/states no buyBase bounds/)
  })

  it('closes a direction to zero rather than darkening the pair', () => {
    // `corridorSet.ts` argues the honest answer for a paused direction is to
    // register and refuse by amount: the pair IS served, at no size.
    const [market] = assetRfqMarketsFrom([token({ enabled: { sell_base: false, buy_base: true } })], [pricing()])
    expect(market!.sellBase).toEqual({ min: 0n, max: 0n })
    expect(market!.buyBase).toEqual({ min: 2n, max: 10n ** 9n })
  })

  it('lets a closed direction stand in for bounds the console never set', () => {
    const [market] = assetRfqMarketsFrom(
      [token({ enabled: { sell_base: false, buy_base: true } })],
      [pricing({ sellBase: undefined })],
    )
    expect(market!.sellBase).toEqual({ min: 0n, max: 0n })
  })
})

describe('ungatedAssetSymbols', () => {
  const token = (symbol: string, approvalThresholdUnits: bigint | null) => ({
    symbol,
    assetId: symbol.toLowerCase().padEnd(68, '0'),
    enabled: { sell_base: true, buy_base: true },
    approvalThresholdUnits,
  })

  it('names the payable assets no threshold covers, which boot logs', () => {
    expect(ungatedAssetSymbols([token('USDA', 1_000n), token('EURA', null)])).toEqual(['EURA'])
  })

  it('is empty when every served asset is gated', () => {
    expect(ungatedAssetSymbols([token('USDA', 1_000n), token('EURA', 0n)])).toEqual([])
  })

  // Zero is a THRESHOLD, not an absence: it gates every swap of that asset.
  it('does not mistake a zero threshold for an unset one', () => {
    expect(ungatedAssetSymbols([token('USDA', 0n)])).toEqual([])
  })
})
