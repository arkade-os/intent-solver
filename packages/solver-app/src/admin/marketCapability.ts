/**
 * What fills a market, and where a row declares something this process cannot do.
 * `servedBy` warned only because its two inputs were INDEPENDENT; one row holds both now and
 * cannot disagree with itself, so this asks instead whether the RUNNING process can do what it declares.
 */
import { assetMarketKey, type AssetMarketConfig } from '@arkade-os/solver-core/core/assetMarketConfig.js'

export type ServingPath = 'offer' | 'rfq'

export type CapabilityGap = 'offer_path_not_built' | 'rfq_pair_unsupported' | 'rfq_both_directions_closed'

export interface MarketCapability {
  readonly serving: readonly ServingPath[]
  readonly gaps: readonly { readonly kind: CapabilityGap; readonly detail: string }[]
  /**
   * What the RUNNING process is open on, which `serving` cannot say: it reports
   * `rfq` whether one direction is closed or neither. `ASSET_<SYM>_<DIR>_ENABLED`
   * still closes a direction without touching the row, so this is the only place
   * that divergence shows.
   */
  readonly rfqDirections: { readonly sellBase: boolean; readonly buyBase: boolean }
}

interface RfqRuntimeMarket {
  readonly base: string | null
  readonly quote: string | null
  readonly sellBase?: { readonly max: bigint } | null
  readonly buyBase?: { readonly max: bigint } | null
}

export interface ServingRuntime {
  /** `Services.assetOffers`: null when this process booted with no offer path at all. */
  readonly assetOffers: unknown | null
  readonly liveOfferMarkets: readonly { a: string | null; b: string | null }[]
  readonly assetRfqMarkets: readonly RfqRuntimeMarket[]
}

type Market = Pick<
  AssetMarketConfig,
  'base' | 'quote' | 'enabled' | 'servesOffer' | 'servesRfq' | 'rfqSellBase' | 'rfqBuyBase'
>

export const marketCapability = (market: Market, runtime: ServingRuntime): MarketCapability => {
  const key = assetMarketKey(market.base, market.quote)
  const serving: ServingPath[] = []
  if (runtime.liveOfferMarkets.some((pair) => assetMarketKey(pair.a, pair.b) === key)) serving.push('offer')
  const live = runtime.assetRfqMarkets.find((row) => row.base === market.base && row.quote === market.quote)
  if (live) serving.push('rfq')
  // A direction the running process closed reads as `{min:0n,max:0n}` (ops/assetRfqMarkets.ts:31).
  const rfqDirections = { sellBase: (live?.sellBase?.max ?? 0n) > 0n, buyBase: (live?.buyBase?.max ?? 0n) > 0n }

  // Disabled is serving nothing BY REQUEST; a gap spends the alarm on a state the operator chose.
  if (!market.enabled) return { serving, gaps: [], rfqDirections }

  const gaps: { kind: CapabilityGap; detail: string }[] = []
  if (market.servesOffer && runtime.assetOffers === null) {
    gaps.push({
      kind: 'offer_path_not_built',
      detail:
        'this process booted with no offer path, so the flag reaches nothing. Restart with OFFER_MARKETS set, ' +
        'or with at least one enabled market row declaring serves_offer.',
    })
  }
  if (market.servesRfq && market.base !== null && market.quote !== null) {
    gaps.push({
      kind: 'rfq_pair_unsupported',
      detail: 'the offer covenant cannot express an asset on both legs, so RFQ drops this market.',
    })
  } else if (market.servesRfq && !market.rfqSellBase && !market.rfqBuyBase) {
    gaps.push({
      kind: 'rfq_both_directions_closed',
      detail: 'both directions are closed, so RFQ registers no corridor for this market.',
    })
  }
  return { serving, gaps, rfqDirections }
}
