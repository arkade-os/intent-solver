import { Amount } from '../shared/amount.js'
import { Rail, type Endpoint } from '../shared/endpoint.js'
import type { AssetPricing } from './asset_pricing.js'
import type { Price } from './price.js'
import { QuoteRefusal, type QuoteSide } from './quote_terms.js'
import type { SpreadPricing } from './spread_pricing.js'
import { DomainError, ErrorCode } from '../shared/error.js'

export interface RouteTerms {
  readonly give: Amount
  readonly payout: Amount
}

export type RouteQuote =
  { readonly ok: true; readonly terms: RouteTerms } | { readonly ok: false; readonly reason: QuoteRefusal }

export interface RouteProps {
  readonly from: Endpoint
  readonly to: Endpoint
  readonly enabled: boolean
  readonly pricing: SpreadPricing | AssetPricing
}

/** What only a route that changes asset needs to price a request. */
export interface MarketConditions {
  readonly price: Price | null
  readonly carrier: bigint
  readonly dust: bigint
}

export interface Destination {
  /** The smallest output the payout rail can hold; absent where it has no such floor. */
  readonly minOutput?: bigint
}

export class Route {
  private constructor(private readonly props: RouteProps) {}

  static of(props: RouteProps): Route {
    const { from, to, pricing } = props
    if (from.equals(to)) throw new DomainError(ErrorCode.Invalid, `route ${from.key} leads back to itself`)
    const changesAsset = from.asset !== to.asset
    if (changesAsset !== (pricing.kind === 'asset')) {
      throw new DomainError(ErrorCode.Invalid, 'a route is priced by a market exactly when it changes asset')
    }
    if (pricing.kind === 'asset' && !(pricing.pair.has(from.asset) && pricing.pair.has(to.asset))) {
      throw new DomainError(ErrorCode.Invalid, `market does not price ${from.asset} against ${to.asset}`)
    }
    return new Route(props)
  }

  get from(): Endpoint {
    return this.props.from
  }
  get to(): Endpoint {
    return this.props.to
  }
  get enabled(): boolean {
    return this.props.enabled
  }
  get key(): string {
    return `${this.from.key}->${this.to.key}`
  }
  /** A corridor is a route leaving Arkade. */
  get isCorridor(): boolean {
    return this.from.rail === Rail.Arkade
  }

  quote(amount: bigint, side: QuoteSide, market?: MarketConditions, { minOutput }: Destination = {}): RouteQuote {
    const { from, to, enabled, pricing } = this.props
    if (!enabled) return { ok: false, reason: QuoteRefusal.RouteDisabled }
    const priced =
      pricing.kind === 'spread'
        ? pricing.quote(amount, side, minOutput)
        : !market || market.price === null
          ? ({ ok: false, reason: QuoteRefusal.PriceUnavailable } as const)
          : pricing.quote({ from: from.asset, to: to.asset, amount, side, ...market, price: market.price, minOutput })
    if (!priced.ok) return priced
    return { ok: true, terms: { give: Amount.of(from.asset, priced.give), payout: Amount.of(to.asset, priced.payout) } }
  }
}
