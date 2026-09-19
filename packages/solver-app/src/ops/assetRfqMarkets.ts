/**
 * Which asset markets this deployment serves over RFQ, and under which env
 * stems.
 *
 * Console rows are the serve list, symbol included. `ASSET_MARKETS` is still
 * parsed — it seeds those columns once — but nothing below reads it.
 */
import { corridorEnabledFrom } from '@arkade-os/solver-core/core/corridorEnabled.js'
import { assetRfqEnvStem, type AssetRfqDirection } from '@arkade-os/solver-corridors/corridors/assetRfq.js'
import type { AssetRfqMarket } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import type { AssetMarketPricingView, CarrierMode } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { assetCardMarkets, type AssetCardMarket } from '@arkade-os/solver-core/core/registryCard.js'
import type { AssetMarket } from './assetOffers.js'

/** One served asset, its operator-facing label, and whether each direction is open. */
export interface AssetRfqToken {
  symbol: string
  /** Canonical 68-hex Arkade asset id — the identity, and what reaches the wire. */
  assetId: string
  enabled: Readonly<Record<AssetRfqDirection, boolean>>
}

const SYMBOL = /^[A-Z][A-Z0-9]{0,11}$/
const ASSET_ID = /^[0-9a-f]{68}$/

const DIRECTIONS: readonly AssetRfqDirection[] = ['sell_base', 'buy_base']

/** A direction an operator closed: registered, and refusing every amount. */
const CLOSED = { min: 0n, max: 0n }

/**
 * `SYMBOL:<asset id>`, comma separated. Empty or unset names no symbols; the
 * console rows are still the serve list.
 */
export const parseAssetRfqTokens = (
  raw: string | undefined,
  read: (name: string) => string | undefined,
): readonly AssetRfqToken[] => {
  const trimmed = raw?.trim()
  if (!trimmed) return []
  const seenSymbol = new Set<string>()
  const seenAsset = new Set<string>()
  return trimmed.split(',').map((entry) => {
    const [symbol, assetId, ...rest] = entry.trim().split(':')
    if (!symbol || !assetId || rest.length > 0) {
      throw new Error(`ASSET_MARKETS entry must be SYMBOL:<asset id>, got ${JSON.stringify(entry)}`)
    }
    if (!SYMBOL.test(symbol)) {
      throw new Error(`ASSET_MARKETS symbol must be 1-12 uppercase alphanumerics starting with a letter, got ${symbol}`)
    }
    if (!ASSET_ID.test(assetId)) {
      throw new Error(`ASSET_MARKETS asset id must be 68 lowercase hex characters, got ${JSON.stringify(assetId)}`)
    }
    // A repeated SYMBOL collides the env stems, so an operator closing one
    // direction would close another market's without being told. A repeated
    // ASSET would register one pair twice, which the registry refuses later and
    // at a point that names neither entry.
    if (seenSymbol.has(symbol)) throw new Error(`ASSET_MARKETS lists symbol ${symbol} twice`)
    if (seenAsset.has(assetId)) throw new Error(`ASSET_MARKETS lists asset ${assetId} twice`)
    seenSymbol.add(symbol)
    seenAsset.add(assetId)
    const enabled = Object.fromEntries(
      DIRECTIONS.map((direction) => {
        const name = `${assetRfqEnvStem({ symbol }, direction)}_ENABLED`
        return [direction, corridorEnabledFrom(name, read(name))]
      }),
    ) as Record<AssetRfqDirection, boolean>
    return { symbol, assetId, enabled }
  })
}

/** What `carrier_mode` resolves against: the chain's dust floor and the deployment default. */
export interface AssetRfqCarrier {
  dustSats: bigint
  /** `ASSET_CARRIER_PRICING`, which `'inherit'` follows. */
  pricedByDefault: boolean
}

export const carrierSatsFor = (mode: CarrierMode, carrier: AssetRfqCarrier): bigint => {
  const priced = mode === 'inherit' ? carrier.pricedByDefault : mode === 'priced'
  return priced ? carrier.dustSats : 0n
}

/**
 * A closed direction becomes `{ min: 0n, max: 0n }` — registered, refusing by
 * amount — not an unbounded payout. The reader for a hand-edited database:
 * `validateAssetMarket` already refuses an incoherent row at write time.
 */
export const assetRfqMarketsFrom = (
  pricing: readonly AssetMarketPricingView[],
  carrier: AssetRfqCarrier,
): readonly AssetRfqMarket[] =>
  pricing.flatMap((market) => {
    if (!market.servesRfq || market.symbol === null) return []
    if (market.base !== null && market.quote !== null) return []
    const sellBase = market.rfqSellBase ? (market.sellBase ?? CLOSED) : CLOSED
    const buyBase = market.rfqBuyBase ? (market.buyBase ?? CLOSED) : CLOSED
    if (sellBase.max === 0n && buyBase.max === 0n) return []
    return [
      {
        base: market.base,
        quote: market.quote,
        symbol: market.symbol,
        baseDecimals: market.baseDecimals,
        quoteDecimals: market.quoteDecimals,
        feeBps: market.feeBps,
        sellBaseFeeBps: market.sellBaseFeeBps,
        buyBaseFeeBps: market.buyBaseFeeBps,
        sellBaseFeeFlat: market.sellBaseFeeFlat,
        buyBaseFeeFlat: market.buyBaseFeeFlat,
        sellBase,
        buyBase,
        feedUrl: market.feedUrl,
        pricePath: market.pricePath,
        carrierSats: carrierSatsFor(market.carrierMode, carrier),
      },
    ]
  })

/** The offer path's serve list: the row IS the pricing, so the declaration is the whole filter. */
export const offerMarketsFrom = (pricing: readonly AssetMarketPricingView[]): readonly AssetMarket[] =>
  pricing.filter((market) => market.servesOffer).map((market) => ({ a: market.base, b: market.quote }))

/** Serving list plus previous markets that still have a non-terminal row. */
export const retainReadableMarkets = (
  serving: readonly AssetRfqMarket[],
  previous: readonly AssetRfqMarket[],
  live: readonly { fromAssetId: string | null; toAssetId: string | null }[],
): readonly AssetRfqMarket[] => [
  ...serving,
  ...previous.filter(
    (market) =>
      !serving.some((row) => row.base === market.base && row.quote === market.quote) &&
      live.some(
        (row) =>
          (row.fromAssetId === market.base && row.toAssetId === market.quote) ||
          (row.fromAssetId === market.quote && row.toAssetId === market.base),
      ),
  ),
]

type Bounds = { min: bigint; max: bigint }

const samePair = (market: AssetMarketPricingView, pair: AssetMarket): boolean =>
  (market.base === pair.a && market.quote === pair.b) || (market.base === pair.b && market.quote === pair.a)

const unionBounds = (...bounds: Array<Bounds | null | undefined>): Bounds | undefined => {
  const present = bounds.filter((bound): bound is Bounds => bound !== null && bound !== undefined)
  const enabled = present.filter((bound) => bound.max > 0n)
  if (enabled.length === 0) return present.length === 0 ? undefined : { min: 0n, max: 0n }
  return {
    min: enabled.reduce((value, bound) => (bound.min < value ? bound.min : value), enabled[0]!.min),
    max: enabled.reduce((value, bound) => (bound.max > value ? bound.max : value), enabled[0]!.max),
  }
}

/** Projects console rows onto the union of directions the offer and RFQ paths actually serve. */
export const assetCardMarketsFromPolicy = (args: {
  pricing: readonly AssetMarketPricingView[]
  offerMarkets: readonly AssetMarket[]
  offerBounds: Bounds
  rfqMarkets: readonly AssetRfqMarket[]
  /** @see Config.offerChargesDeliveredCarrier. REQUIRED, not optional: `cli card`
   * and `/api/card` both publish through here and the CLI silently omitted it once,
   * which prices a maker without a charge we apply — funded, then refused. */
  chargesDeliveredCarrier: boolean | undefined
}): AssetCardMarket[] =>
  assetCardMarkets(args.pricing, args.offerBounds).flatMap((market) => {
    const pricing = args.pricing.find(
      (candidate) => candidate.base === market.base && candidate.quote === market.quote,
    )!
    const servesOffers = args.offerMarkets.some((pair) => samePair(pricing, pair))
    const rfq = args.rfqMarkets.find((candidate) => candidate.base === market.base && candidate.quote === market.quote)
    if (!servesOffers && !rfq) return []

    const sellBase = unionBounds(servesOffers ? market.sellBase : undefined, rfq?.sellBase)
    const buyBase = unionBounds(servesOffers ? market.buyBase : undefined, rfq?.buyBase)
    return [
      {
        ...market,
        ...(servesOffers && args.chargesDeliveredCarrier === true ? { chargesDeliveredCarrier: true } : {}),
        sellBase,
        buyBase,
        sellBaseFeeFlat: sellBase && sellBase.max > 0n ? market.sellBaseFeeFlat : 0n,
        buyBaseFeeFlat: buyBase && buyBase.max > 0n ? market.buyBaseFeeFlat : 0n,
      },
    ]
  })
