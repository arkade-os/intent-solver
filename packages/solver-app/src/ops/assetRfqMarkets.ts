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

/** One served asset, its operator-facing label, and whether each direction is open. */
export interface AssetRfqToken {
  symbol: string
  /** Canonical 68-hex Arkade asset id — the identity, and what reaches the wire. */
  assetId: string
  enabled: Readonly<Record<AssetRfqDirection, boolean>>
  /** `ASSET_<SYMBOL>_APPROVAL_THRESHOLD`, ATOMIC units; null carries no gate. */
  approvalThresholdUnits: bigint | null
}

const SYMBOL = /^[A-Z][A-Z0-9]{0,11}$/
const ASSET_ID = /^[0-9a-f]{68}$/
const WHOLE = /^[0-9]+$/

/** At BOOT, never a runtime `unreadable`. No sign is admitted; `0` gates every swap. */
const approvalThresholdFrom = (symbol: string, raw: string | undefined): bigint | null => {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  if (!WHOLE.test(trimmed)) {
    throw new Error(
      `ASSET_${symbol}_APPROVAL_THRESHOLD must be a whole number of the asset's atomic units, got ${JSON.stringify(raw)}`,
    )
  }
  return BigInt(trimmed)
}

const DIRECTIONS: readonly AssetRfqDirection[] = ['sell_base', 'buy_base']

/** A direction an operator closed: registered, and refusing every amount. */
const CLOSED = { min: 0n, max: 0n }

/**
 * Payable assets carrying no approval threshold. Boot logs these: one corridor
 * pays several assets through one gate, so adding an asset leaves it ungated.
 */
export const ungatedAssetSymbols = (tokens: readonly AssetRfqToken[]): readonly string[] =>
  tokens.filter((token) => token.approvalThresholdUnits === null).map((token) => token.symbol)

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
    const thresholdName = `ASSET_${symbol}_APPROVAL_THRESHOLD`
    return { symbol, assetId, enabled, approvalThresholdUnits: approvalThresholdFrom(symbol, read(thresholdName)) }
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
      sellBase: boundsFor('sell_base'),
      buyBase: boundsFor('buy_base'),
      feedUrl: market.feedUrl,
      pricePath: market.pricePath,
    }
  })
