// Which paths fill a configured market — and whether any do. Offers are the
// live priced OFFER_MARKETS intersection; RFQ follows the live console list.

import { assetMarketKey, type AssetMarketConfig } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import type { AssetMarket } from '../ops/assetOffers.js'

export type ServingPath = 'offer' | 'rfq'

export interface Serving {
  readonly liveOfferMarkets: readonly AssetMarket[]
  readonly assetRfqMarkets: readonly { base: string | null; quote: string | null }[]
}

export const servedBy = (market: Pick<AssetMarketConfig, 'base' | 'quote'>, serving: Serving): ServingPath[] => {
  const key = assetMarketKey(market.base, market.quote)
  const paths: ServingPath[] = []
  if (serving.liveOfferMarkets.some((pair) => assetMarketKey(pair.a, pair.b) === key)) paths.push('offer')
  if (serving.assetRfqMarkets.some((row) => row.base === market.base && row.quote === market.quote)) paths.push('rfq')
  return paths
}
