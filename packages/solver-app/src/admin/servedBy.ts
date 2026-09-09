// Which paths fill a configured market — and whether any do. `OFFER_MARKETS`
// and `ASSET_MARKETS` are DIFFERENT variables for different paths, and a market
// can be served by neither, one or both. Unset, `servesOffers` is false and
// nothing watches for an offer, which the markets tab rendered exactly like a
// market that works. `trading` there is its OWN enabled state; this is a second
// axis.

import { assetMarketKey, type AssetMarketConfig } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import type { AssetMarket } from '../ops/assetOffers.js'
import type { AssetRfqToken } from '../ops/assetRfqMarkets.js'

export type ServingPath = 'offer' | 'rfq'

export interface BootServing {
  readonly offerMarkets: readonly AssetMarket[]
  readonly assetRfqTokens: readonly AssetRfqToken[]
}

// Canonical key, so leg order does not matter. RFQ matches an asset id against
// a leg, as `assetRfqMarketsFrom` does.
export const servedBy = (market: Pick<AssetMarketConfig, 'base' | 'quote'>, boot: BootServing): ServingPath[] => {
  const key = assetMarketKey(market.base, market.quote)
  const legs = new Set([market.base, market.quote].filter((leg): leg is string => leg !== null))
  const paths: ServingPath[] = []
  if (boot.offerMarkets.some((pair) => assetMarketKey(pair.a, pair.b) === key)) paths.push('offer')
  if (boot.assetRfqTokens.some((token) => legs.has(token.assetId))) paths.push('rfq')
  return paths
}
