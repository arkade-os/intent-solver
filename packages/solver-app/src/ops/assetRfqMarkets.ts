/**
 * Which asset markets this deployment serves over RFQ, and under which env
 * stems.
 *
 * TWO SOURCES, joined here, and neither is redundant. The console's market rows
 * already hold everything about a market's ECONOMICS — the feed, each leg's
 * precision, the spread, the payout bounds — and `assetMarketConfig.ts` explains
 * why a second spelling of those would let two directions disagree about one
 * price. What they do not hold is a SYMBOL, and a symbol is what a corridor's
 * env stem is made of: `ASSET_<68 hex>_BUY` is legal shell and unusable, the
 * same argument `evmCorridorConfig.ts` makes for naming a token.
 *
 * So `ASSET_MARKETS` names the assets served and labels them, exactly as
 * `EVM_TOKENS` does; the console prices them. Unset serves none, which is the
 * default and leaves the deployment as it was.
 */
import { corridorEnabledFrom } from '@arkade-os/solver-core/core/corridorEnabled.js'
import { assetRfqEnvStem, type AssetRfqDirection } from '@arkade-os/solver-corridors/corridors/assetRfq.js'
import type { AssetRfqMarket } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import type { AssetMarketPricingView } from '@arkade-os/solver-core/core/assetMarketConfig.js'
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
 * `SYMBOL:<asset id>`, comma separated. Empty or unset means no asset RFQ
 * corridors.
 *
 * `read` supplies `<STEM>_ENABLED` per direction, defaulting to on, and takes
 * only the exact strings for the reason `corridorEnabledFrom` gives.
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

/**
 * The markets the corridors are built from: a named asset joined to the console
 * row that prices it.
 *
 * THROWS on a named asset the console does not price, rather than dropping it.
 * An operator who wrote `ASSET_MARKETS` meant to trade that pair, and a solver
 * that came up serving nothing would look like a quiet market instead of a
 * misconfiguration — the same call `assertMarketsPriced` makes for the packet
 * path, and for the same reason.
 *
 * Bounds are REQUIRED, with no deployment-wide fallback. The packet path has one
 * (`OFFER_MIN_FILL_AMOUNT`), and it is a sats figure: applying it to a payout leg
 * denominated in an asset's atomic units would bound one unit with another. An
 * operator states both directions or serves neither.
 */
export const assetRfqMarketsFrom = (
  tokens: readonly AssetRfqToken[],
  pricing: readonly AssetMarketPricingView[],
): readonly AssetRfqMarket[] =>
  tokens.map((token) => {
    const market = pricing.find((m) => m.base === token.assetId || m.quote === token.assetId)
    if (!market) {
      throw new Error(
        `ASSET_MARKETS names ${token.symbol} (${token.assetId}) but no enabled market in the console prices it. ` +
          `Add the market and its price feed in the console, or stop serving the asset.`,
      )
    }
    // Exactly one leg may be an asset: `parseAssetPair` refuses the rest, and
    // the offer packet cannot express an asset-to-asset swap at all. A market
    // configured that way is quotable on neither direction of this corridor.
    if (market.base !== null && market.quote !== null) {
      throw new Error(
        `the market for ${token.symbol} names an asset on both legs, which the offer covenant cannot express`,
      )
    }
    const boundsFor = (direction: AssetRfqDirection) => {
      if (!token.enabled[direction]) return CLOSED
      const bounds = direction === 'sell_base' ? market.sellBase : market.buyBase
      if (!bounds) {
        throw new Error(
          `the market for ${token.symbol} states no ${direction === 'sell_base' ? 'sellBase' : 'buyBase'} bounds, ` +
            `so ${assetRfqEnvStem(token, direction)} would quote an unbounded payout. Set them in the console, ` +
            `or close the direction with ${assetRfqEnvStem(token, direction)}_ENABLED=false.`,
        )
      }
      return bounds
    }
    return {
      base: market.base,
      quote: market.quote,
      symbol: token.symbol,
      baseDecimals: market.baseDecimals,
      quoteDecimals: market.quoteDecimals,
      feeBps: market.feeBps,
      sellBaseFeeFlat: market.sellBaseFeeFlat,
      buyBaseFeeFlat: market.buyBaseFeeFlat,
      sellBase: boundsFor('sell_base'),
      buyBase: boundsFor('buy_base'),
      feedUrl: market.feedUrl,
      pricePath: market.pricePath,
    }
  })

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
        sellBase,
        buyBase,
        sellBaseFeeFlat: sellBase && sellBase.max > 0n ? market.sellBaseFeeFlat : 0n,
        buyBaseFeeFlat: buyBase && buyBase.max > 0n ? market.buyBaseFeeFlat : 0n,
      },
    ]
  })
