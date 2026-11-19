import { Amount } from '../shared/amount.js'
import { Rail, type Endpoint } from '../shared/endpoint.js'
import type { AssetPricing } from './asset_pricing.js'
import type { Price } from './price.js'
import { QuoteRefusal, QuoteSide } from './quote_terms.js'
import type { SpreadPricing } from './spread_pricing.js'
import { InvalidValue } from '../shared/error.js'

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
  readonly carrier: Amount
  readonly dust: Amount
}

export interface Destination {
  /** The smallest output the payout rail can hold; absent where it has no such floor. */
  readonly minOutput?: Amount
}

export class Route {
  private constructor(private readonly props: RouteProps) {}

  static of(props: RouteProps): Route {
    const { from, to, pricing } = props
    if (from.equals(to)) throw new InvalidValue(`route ${from.key} leads back to itself`)
    const changesAsset = from.asset !== to.asset
    if (changesAsset !== (pricing.kind === 'asset')) {
      throw new InvalidValue('a route is priced by a market exactly when it changes asset')
    }
    if (pricing.kind === 'asset' && !(pricing.pair.has(from.asset) && pricing.pair.has(to.asset))) {
      throw new InvalidValue(`market does not price ${from.asset} against ${to.asset}`)
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

  /** `amount` is in the asset of the side it fixes; a floor is in the asset paid out. */
  quote(amount: Amount, side: QuoteSide, market?: MarketConditions, { minOutput }: Destination = {}): RouteQuote {
    const { from, to, enabled, pricing } = this.props
    const fixed = side === QuoteSide.From ? from : to
    if (amount.asset !== fixed.asset)
      throw new InvalidValue(`route ${this.key} takes ${fixed.asset} on its ${side} side`)
    if (minOutput !== undefined && minOutput.asset !== to.asset) {
      throw new InvalidValue(`route ${this.key} pays out ${to.asset}, not ${minOutput.asset}`)
    }
    if (!enabled) return { ok: false, reason: QuoteRefusal.RouteDisabled }
    const priced =
      pricing.kind === 'spread'
        ? pricing.quote(amount.units, side, minOutput?.units)
        : !market || market.price === null
          ? ({ ok: false, reason: QuoteRefusal.PriceUnavailable } as const)
          : pricing.quote({
              from: from.asset,
              to: to.asset,
              amount: amount.units,
              side,
              price: market.price,
              carrier: market.carrier.units,
              dust: market.dust.units,
              minOutput: minOutput?.units,
            })
    if (!priced.ok) return priced
    return { ok: true, terms: { give: Amount.of(from.asset, priced.give), payout: Amount.of(to.asset, priced.payout) } }
  }
}
