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
  assetCardMarketsFromPolicy,
  assetRfqMarketsFrom,
  parseAssetRfqTokens,
  retainReadableMarkets,
} from '@arkade-os/solver-app/ops/assetRfqMarkets.js'
import { assetRfqDescriptor, assetRfqEnvStem } from '@arkade-os/solver-corridors/corridors/assetRfq.js'
import { DEFAULT_SERVING, type AssetMarketPricingView } from '@arkade-os/solver-core/core/assetMarketConfig.js'

const USDA = '1a'.repeat(34)
const OTHER = '2b'.repeat(34)
const none = () => undefined

const pricing = (over: Partial<AssetMarketPricingView> = {}): AssetMarketPricingView => ({
  ...DEFAULT_SERVING,
  base: null,
  quote: USDA,
  baseDecimals: 8,
  quoteDecimals: 6,
  feedUrl: 'https://feed.test/price',
  pricePath: '/price',
  toleranceBps: 10,
  feeBps: 25,
  sellBaseFeeFlat: 330n,
  buyBaseFeeFlat: 1_000_000n,
  sellBase: { min: 1n, max: 10n ** 12n },
  buyBase: { min: 2n, max: 10n ** 9n },
  ...over,
})

describe('parseAssetRfqTokens', () => {
  it('serves nothing when unset or empty, which is the default', () => {
    expect(parseAssetRfqTokens(undefined, none)).toEqual([])
    expect(parseAssetRfqTokens('   ', none)).toEqual([])
  })

  it('reads SYMBOL:<asset id>, both directions on', () => {
    expect(parseAssetRfqTokens(`USDA:${USDA}`, none)).toEqual([
      { symbol: 'USDA', assetId: USDA, enabled: { sell_base: true, buy_base: true } },
    ])
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
      sellBaseFeeFlat: 330n,
      buyBaseFeeFlat: 1_000_000n,
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

  it('serves the console row when nothing is named in ASSET_MARKETS', () => {
    const [market] = assetRfqMarketsFrom([], [pricing()])
    expect(market?.quote).toBe(USDA)
    expect(market?.symbol).toMatch(/^A[0-9A-F]{11}$/)
  })

  it('omits a named asset the console does not price, so a first dashboard row can land', () => {
    expect(assetRfqMarketsFrom([token()], [])).toEqual([])
  })

  it('still serves a console row when ASSET_MARKETS names a different asset', () => {
    expect(assetRfqMarketsFrom([token()], [pricing({ quote: OTHER })])[0]?.quote).toBe(OTHER)
  })

  it('omits a market with an asset on both legs, which no offer packet expresses', () => {
    expect(assetRfqMarketsFrom([token()], [pricing({ base: OTHER, quote: USDA })])).toEqual([])
  })

  it('closes a served direction the console left unbounded rather than quoting without a ceiling', () => {
    const [market] = assetRfqMarketsFrom([token()], [pricing({ sellBase: undefined })])
    expect(market!.sellBase).toEqual({ min: 0n, max: 0n })
    expect(market!.buyBase).toEqual({ min: 2n, max: 10n ** 9n })
  })

  it('drops a market whose directions are both closed', () => {
    expect(assetRfqMarketsFrom([token()], [pricing({ sellBase: undefined, buyBase: undefined })])).toEqual([])
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

describe('assetCardMarketsFromPolicy', () => {
  const token = (enabled: { sell_base: boolean; buy_base: boolean }) => ({
    symbol: 'USDA',
    assetId: USDA,
    enabled,
  })

  it('drops a disabled RFQ direction and its flat fee from the card projection', () => {
    const rfq = assetRfqMarketsFrom([token({ sell_base: false, buy_base: true })], [pricing()])
    const [card] = assetCardMarketsFromPolicy({
      pricing: [pricing()],
      offerMarkets: [],
      offerBounds: { min: 0n, max: 0n },
      rfqMarkets: rfq,
      chargesDeliveredCarrier: undefined,
    })
    expect(card).toMatchObject({
      sellBase: { min: 0n, max: 0n },
      buyBase: { min: 2n, max: 10n ** 9n },
      sellBaseFeeFlat: 0n,
      buyBaseFeeFlat: 1_000_000n,
    })
  })

  /** A maker pricing from the card nets the same charge we do — where we take offers. */
  it('advertises the delivered-carrier charge only when offers are served and it is on', () => {
    const served = { pricing: [pricing()], offerMarkets: [{ a: null, b: USDA }], offerBounds: { min: 5n, max: 20n } }
    expect(
      assetCardMarketsFromPolicy({ ...served, rfqMarkets: [], chargesDeliveredCarrier: true })[0]!
        .chargesDeliveredCarrier,
    ).toBe(true)
    expect(
      assetCardMarketsFromPolicy({ ...served, rfqMarkets: [], chargesDeliveredCarrier: undefined })[0]!
        .chargesDeliveredCarrier,
    ).toBeUndefined()

    const rfqOnly = assetRfqMarketsFrom([token({ sell_base: true, buy_base: true })], [pricing()])
    expect(
      assetCardMarketsFromPolicy({
        pricing: [pricing()],
        offerMarkets: [],
        offerBounds: { min: 0n, max: 0n },
        rfqMarkets: rfqOnly,
        chargesDeliveredCarrier: true,
      })[0]!.chargesDeliveredCarrier,
    ).toBeUndefined()
  })

  it('keeps a direction served by offers when the RFQ policy disables it', () => {
    const rfq = assetRfqMarketsFrom([token({ sell_base: false, buy_base: true })], [pricing()])
    const [card] = assetCardMarketsFromPolicy({
      pricing: [pricing()],
      offerMarkets: [{ a: null, b: USDA }],
      offerBounds: { min: 5n, max: 20n },
      rfqMarkets: rfq,
      chargesDeliveredCarrier: undefined,
    })
    expect(card).toMatchObject({
      sellBase: { min: 1n, max: 10n ** 12n },
      sellBaseFeeFlat: 330n,
    })
  })
})

describe('auto-symbols', () => {
  it('distinguishes two assets of the same issuance', () => {
    const tx = 'ab'.repeat(32)
    const a = assetRfqMarketsFrom([], [pricing({ quote: `${tx}0100` })])[0]!
    const b = assetRfqMarketsFrom([], [pricing({ quote: `${tx}0200` })])[0]!
    expect(a.symbol).not.toBe(b.symbol)
    expect(a.symbol).toMatch(/^A[0-9A-F]{11}$/)
  })
})

describe('retainReadableMarkets', () => {
  const served = () => assetRfqMarketsFrom([], [pricing()])[0]!
  const other = () => assetRfqMarketsFrom([], [pricing({ quote: OTHER })])[0]!

  it('keeps a dropped market while a live row still names its pair', () => {
    const dropped = served()
    expect(retainReadableMarkets([], [dropped], [{ fromAssetId: null, toAssetId: USDA }])).toEqual([dropped])
  })

  it('still keeps it after a later write whose serving list has forgotten it', () => {
    const dropped = served()
    const next = other()
    const afterDelete = retainReadableMarkets([], [dropped], [{ fromAssetId: null, toAssetId: USDA }])
    const afterOther = retainReadableMarkets([next], afterDelete, [{ fromAssetId: null, toAssetId: USDA }])
    expect(afterOther).toEqual([next, dropped])
  })

  it('drops it once nothing is in flight', () => {
    expect(retainReadableMarkets([], [served()], [])).toEqual([])
  })
})
