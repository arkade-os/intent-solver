// Which paths fill a configured market — and whether any do. Offers are still
// named by `OFFER_MARKETS`; RFQ follows the live console serve list.

import { assetMarketKey, type AssetMarketConfig } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import type { AssetMarket } from '../ops/assetOffers.js'

export type ServingPath = 'offer' | 'rfq'

export interface BootServing {
  readonly offerMarkets: readonly AssetMarket[]
  readonly assetRfqMarkets?: readonly { base: string | null; quote: string | null }[]
}

export const servingOf = (services: {
  policy: { offerMarkets: readonly AssetMarket[] }
  liveOfferMarkets?: readonly AssetMarket[]
  assetRfqMarkets: readonly { base: string | null; quote: string | null }[]
}): BootServing => ({
  offerMarkets: services.liveOfferMarkets ?? services.policy.offerMarkets,
  assetRfqMarkets: services.assetRfqMarkets,
})

export const servedBy = (market: Pick<AssetMarketConfig, 'base' | 'quote'>, boot: BootServing): ServingPath[] => {
  const key = assetMarketKey(market.base, market.quote)
  const paths: ServingPath[] = []
  if (boot.offerMarkets.some((pair) => assetMarketKey(pair.a, pair.b) === key)) paths.push('offer')
  if (boot.assetRfqMarkets?.some((row) => row.base === market.base && row.quote === market.quote)) paths.push('rfq')
  return paths
}
