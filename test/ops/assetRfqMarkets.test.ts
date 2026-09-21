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
  carrierSatsFor,
  offerMarketsFrom,
  parseAssetRfqTokens,
  recoverReadableMarkets,
  retainReadableMarkets,
} from '@arkade-os/solver-app/ops/assetRfqMarkets.js'
import { assetRfqDescriptor, assetRfqEnvStem } from '@arkade-os/solver-corridors/corridors/assetRfq.js'
import {
  DEFAULT_SERVING,
  rfqSymbolFor,
  type AssetMarketPricingView,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'

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

const CARRIER = { dustSats: 330n, pricedByDefault: false }

const view = (over: Partial<AssetMarketPricingView> = {}): AssetMarketPricingView =>
  pricing({ symbol: 'USDA', servesRfq: true, rfqSellBase: true, rfqBuyBase: true, servesOffer: false, ...over })

describe('assetRfqMarketsFrom reads the row', () => {
  it('takes the symbol off the row rather than synthesising one', () => {
    expect(assetRfqMarketsFrom([view()], CARRIER)[0]!.symbol).toBe('USDA')
  })

  it('drops a market the row does not declare for RFQ', () => {
    expect(assetRfqMarketsFrom([view({ servesRfq: false })], CARRIER)).toEqual([])
  })

  it('closes the direction the row closed, without touching the other', () => {
    const [market] = assetRfqMarketsFrom([view({ rfqSellBase: false })], CARRIER)
    expect(market!.sellBase).toEqual({ min: 0n, max: 0n })
    expect(market!.buyBase.max).toBeGreaterThan(0n)
  })
})

describe('offerMarketsFrom', () => {
  it('is exactly the rows declared for offers', () => {
    expect(offerMarketsFrom([view({ servesOffer: true }), view({ base: null, quote: OTHER })])).toEqual([
      { a: null, b: USDA },
    ])
  })
})

describe('carrierSatsFor', () => {
  it('lets a market override the deployment default in both directions', () => {
    expect(carrierSatsFor('priced', { dustSats: 330n, pricedByDefault: false })).toBe(330n)
    expect(carrierSatsFor('off', { dustSats: 330n, pricedByDefault: true })).toBe(0n)
  })

  it('follows ASSET_CARRIER_PRICING on inherit', () => {
    expect(carrierSatsFor('inherit', { dustSats: 330n, pricedByDefault: true })).toBe(330n)
    expect(carrierSatsFor('inherit', { dustSats: 330n, pricedByDefault: false })).toBe(0n)
  })
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
  it('carries the console row through, market for market', () => {
    const [market] = assetRfqMarketsFrom([view()], CARRIER)
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
      carrierSats: 0n,
    })
  })

  it('produces the pair the corridor will be registered under', () => {
    const [market] = assetRfqMarketsFrom([view()], CARRIER)
    expect(assetRfqDescriptor(market!, 'sell_base').pair).toBe(`arkade:BTC->arkade:${USDA}`)
    expect(assetRfqDescriptor(market!, 'buy_base').pair).toBe(`arkade:${USDA}->arkade:BTC`)
  })

  it('finds the row whichever leg the asset sits on', () => {
    const [market] = assetRfqMarketsFrom([view({ base: USDA, quote: null })], CARRIER)
    expect([market!.base, market!.quote]).toEqual([USDA, null])
  })

  it('drops a row carrying no symbol, which is the stem the corridor registers under', () => {
    // Unreachable through `validateAssetMarket`; this is the hand-edited-file reader.
    expect(assetRfqMarketsFrom([view({ symbol: null })], CARRIER)).toEqual([])
  })

  it('serves nothing when the console holds no row, so a first dashboard row can land', () => {
    expect(assetRfqMarketsFrom([], CARRIER)).toEqual([])
  })

  it('serves whichever asset the row carries, no second list consulted', () => {
    expect(assetRfqMarketsFrom([view({ quote: OTHER })], CARRIER)[0]?.quote).toBe(OTHER)
  })

  it('omits a market with an asset on both legs, which no offer packet expresses', () => {
    expect(assetRfqMarketsFrom([view({ base: OTHER, quote: USDA })], CARRIER)).toEqual([])
  })

  it('closes a served direction the console left unbounded rather than quoting without a ceiling', () => {
    const [market] = assetRfqMarketsFrom([view({ sellBase: undefined })], CARRIER)
    expect(market!.sellBase).toEqual({ min: 0n, max: 0n })
    expect(market!.buyBase).toEqual({ min: 2n, max: 10n ** 9n })
  })

  it('drops a market whose directions are both closed', () => {
    expect(assetRfqMarketsFrom([view({ sellBase: undefined, buyBase: undefined })], CARRIER)).toEqual([])
  })

  it('closes a direction to zero rather than darkening the pair', () => {
    // `corridorSet.ts` argues the honest answer for a paused direction is to
    // register and refuse by amount: the pair IS served, at no size.
    const [market] = assetRfqMarketsFrom([view({ rfqSellBase: false })], CARRIER)
    expect(market!.sellBase).toEqual({ min: 0n, max: 0n })
    expect(market!.buyBase).toEqual({ min: 2n, max: 10n ** 9n })
  })

  it('lets a closed direction stand in for bounds the console never set', () => {
    const [market] = assetRfqMarketsFrom([view({ rfqSellBase: false, sellBase: undefined })], CARRIER)
    expect(market!.sellBase).toEqual({ min: 0n, max: 0n })
  })
})

describe('assetCardMarketsFromPolicy', () => {
  it('drops a disabled RFQ direction and its flat fee from the card projection', () => {
    const rfq = assetRfqMarketsFrom([view({ rfqSellBase: false })], CARRIER)
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

    const rfqOnly = assetRfqMarketsFrom([view()], CARRIER)
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
    const rfq = assetRfqMarketsFrom([view({ rfqSellBase: false })], CARRIER)
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
    expect(rfqSymbolFor(`${tx}0100`)).not.toBe(rfqSymbolFor(`${tx}0200`))
    expect(rfqSymbolFor(`${tx}0100`)).toMatch(/^A[0-9A-F]{11}$/)
  })

  it('is what the serve list carries when that is the symbol on the row', () => {
    expect(assetRfqMarketsFrom([view({ symbol: rfqSymbolFor(USDA) })], CARRIER)[0]!.symbol).toBe(rfqSymbolFor(USDA))
  })
})

describe('retainReadableMarkets', () => {
  const served = () => assetRfqMarketsFrom([view()], CARRIER)[0]!
  const other = () => assetRfqMarketsFrom([view({ quote: OTHER })], CARRIER)[0]!

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

  it('matches a serving market whichever way round the readable entry runs', () => {
    const flipped = { base: USDA, quote: null, symbol: rfqSymbolFor(USDA) }
    expect(retainReadableMarkets([served()], [flipped], [{ fromAssetId: USDA, toAssetId: null }])).toEqual([served()])
  })
})

describe('recoverReadableMarkets', () => {
  const served = () => assetRfqMarketsFrom([view()], CARRIER)[0]!
  const row = (fromAssetId: string | null, toAssetId: string | null) => ({ fromAssetId, toAssetId })

  it('recovers a pair no configured market covers, which is the boot-after-delete case', () => {
    expect(recoverReadableMarkets([], [row(null, USDA)])).toEqual([
      { base: null, quote: USDA, symbol: rfqSymbolFor(USDA) },
    ])
  })

  it('recovers BOTH directions of that pair from the one row', () => {
    const [recovered] = recoverReadableMarkets([], [row(USDA, null)])
    expect(recovered).toBeDefined()
    expect([assetRfqDescriptor(recovered!, 'sell_base').pair, assetRfqDescriptor(recovered!, 'buy_base').pair]).toEqual(
      [`arkade:${USDA}->arkade:BTC`, `arkade:BTC->arkade:${USDA}`],
    )
  })

  it('skips a pair the readable set already covers, whichever way round the row runs', () => {
    expect(recoverReadableMarkets([served()], [row(null, USDA)])).toEqual([served()])
    expect(recoverReadableMarkets([served()], [row(USDA, null)])).toEqual([served()])
  })

  it('recovers ONE entry from two rows on opposite legs of one pair', () => {
    expect(recoverReadableMarkets([], [row(null, USDA), row(USDA, null)])).toHaveLength(1)
  })

  it('leaves the readable set alone when nothing is in flight', () => {
    expect(recoverReadableMarkets([served()], [])).toEqual([served()])
  })

  it('has nowhere to put pricing, which is why the reader set took a narrower type', () => {
    expect(Object.keys(recoverReadableMarkets([], [row(null, USDA)])[0]!).sort()).toEqual(['base', 'quote', 'symbol'])
  })

  it('ignores a row with BTC on both legs — no asset market ever served that pair', () => {
    expect(recoverReadableMarkets([], [row(null, null)])).toEqual([])
  })
})
