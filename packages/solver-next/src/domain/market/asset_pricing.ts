import type { Asset } from '../shared/asset.js'
import { checkBps } from '../shared/bps.js'
import type { Pair } from './pair.js'
import type { Price } from './price.js'
import { PricedQuote, QuoteRefusal, QuoteSide } from './quote_terms.js'
import { InvalidValue } from '../shared/error.js'

const BPS = 10_000n
const pow10 = (n: number): bigint => 10n ** BigInt(n)

export interface AssetPricingProps {
  readonly pair: Pair
  /** The asset that carries an Arkade output (BTC): a leg in it needs no carrier. */
  readonly native: Asset
  readonly feeBps: number
  /** Per direction, when it differs from `feeBps`. "Sell base" is the client giving the base asset. */
  readonly sellBaseFeeBps?: number
  readonly buyBaseFeeBps?: number
  /** In units of the asset the client gives in that direction. */
  readonly sellBaseFeeFlat?: bigint
  readonly buyBaseFeeFlat?: bigint
  /** How far an offer may sit from the feed price and still be taken. Quotes do not use it. */
  readonly toleranceBps: number
  /** Limits on what the solver pays out. A `maxPayout` of zero closes the market. */
  readonly minPayout: bigint
  readonly maxPayout: bigint
}

export interface AssetQuoteRequest {
  readonly from: Asset
  readonly to: Asset
  readonly amount: bigint
  readonly side: QuoteSide
  readonly price: Price
  /** What an Arkade output must carry for the asset to exist on it. */
  readonly carrier: bigint
  readonly dust: bigint
  /** The smallest output Arkade can fund. Floors a payout in the native asset only. */
  readonly minOutput?: bigint
}

export interface OfferTerms {
  readonly deposit: Asset
  readonly depositAmount: bigint
  readonly want: Asset
  readonly wantAmount: bigint
  readonly price: Price
  readonly carrierCharged?: bigint
  readonly carrierReturned?: bigint
}

/** Two assets: the client's input is converted at the feed price, then the fee comes off the result. */
export class AssetPricing {
  readonly kind = 'asset'

  private constructor(private readonly props: AssetPricingProps) {}

  static of(props: AssetPricingProps): AssetPricing {
    const { feeBps, sellBaseFeeBps = feeBps, buyBaseFeeBps = feeBps, toleranceBps } = props
    for (const bps of [feeBps, sellBaseFeeBps, buyBaseFeeBps, toleranceBps]) checkBps('asset pricing', bps)
    if ((props.sellBaseFeeFlat ?? 0n) < 0n || (props.buyBaseFeeFlat ?? 0n) < 0n) {
      throw new InvalidValue('asset pricing: a flat fee cannot be negative')
    }
    if (props.minPayout < 0n || props.maxPayout < 0n)
      throw new InvalidValue('asset pricing: payout bounds cannot be negative')
    return new AssetPricing(props)
  }

  get pair(): Pair {
    return this.props.pair
  }

  quote(request: AssetQuoteRequest): PricedQuote {
    const priced = this.priced(request)
    if (!priced.ok || request.to !== this.props.native) return priced
    return priced.payout < (request.minOutput ?? 0n) ? PricedQuote.refused(QuoteRefusal.PayoutBelowDust) : priced
  }

  private priced({ from, to, amount, side, price, carrier, dust }: AssetQuoteRequest): PricedQuote {
    const givesBase = this.givesBase(from, to)
    if (givesBase === null) return PricedQuote.refused(QuoteRefusal.UnsupportedPair)
    if (amount <= 0n) return PricedQuote.refused(QuoteRefusal.AmountOutOfRange)
    if (carrier < 0n || dust < 0n) return PricedQuote.refused(QuoteRefusal.PriceUnavailable)

    const { native, minPayout, maxPayout } = this.props
    const solverDelivers = to !== native
    const clientFronts = from !== native
    // The carrier is the solver's cost when it delivers an asset, and the client's own when they front one.
    const offInput = this.flatFee(givesBase) + (solverDelivers && !clientFronts ? carrier : 0n)
    const ontoPayout = clientFronts && !solverDelivers ? carrier : 0n
    const outOfRange = (payout: bigint): boolean => payout < minPayout || payout > maxPayout
    const feeBps = this.feeBps(givesBase)

    if (side === QuoteSide.To) {
      const wanted = amount - ontoPayout
      if (wanted <= 0n) return PricedQuote.refused(QuoteRefusal.FeeConsumesSwap)
      if (outOfRange(wanted)) return PricedQuote.refused(QuoteRefusal.AmountOutOfRange)
      const net = this.inputFor(wanted, givesBase, feeBps, 0, price)
      if (net === null) return PricedQuote.refused(QuoteRefusal.PriceUnavailable)
      if (!solverDelivers && amount < dust) return PricedQuote.refused(QuoteRefusal.AmountOutOfRange)
      return { ok: true, give: net + offInput, payout: amount }
    }

    const net = amount - offInput
    if (net <= 0n) return PricedQuote.refused(QuoteRefusal.FeeConsumesSwap)
    const converted = this.payoutFor(net, givesBase, feeBps, 0, price)
    if (converted <= 0n) return PricedQuote.refused(QuoteRefusal.FeeConsumesSwap)
    if (outOfRange(converted)) return PricedQuote.refused(QuoteRefusal.AmountOutOfRange)
    const payout = converted + ontoPayout
    if (!solverDelivers && payout < dust) return PricedQuote.refused(QuoteRefusal.AmountOutOfRange)
    return { ok: true, give: amount, payout }
  }

  /** Whether an offer asks for no more than this market would pay for its deposit, within tolerance. */
  acceptsOffer(offer: OfferTerms): boolean {
    const { depositAmount, wantAmount, price, carrierCharged = 0n, carrierReturned = 0n } = offer
    const givesBase = this.givesBase(offer.deposit, offer.want)
    if (givesBase === null || carrierCharged < 0n || carrierReturned < 0n) return false
    if (depositAmount <= 0n || wantAmount <= 0n) return false
    const net = depositAmount - this.flatFee(givesBase) - carrierCharged
    if (net <= 0n) return false
    const payout = this.payoutFor(net, givesBase, this.feeBps(givesBase), this.props.toleranceBps, price)
    return wantAmount <= payout + carrierReturned
  }

  private givesBase(from: Asset, to: Asset): boolean | null {
    const { base, quote } = this.props.pair
    if (from === base.asset && to === quote.asset) return true
    if (from === quote.asset && to === base.asset) return false
    return null
  }

  private flatFee(givesBase: boolean): bigint {
    return (givesBase ? this.props.sellBaseFeeFlat : this.props.buyBaseFeeFlat) ?? 0n
  }

  private feeBps(givesBase: boolean): number {
    return (givesBase ? this.props.sellBaseFeeBps : this.props.buyBaseFeeBps) ?? this.props.feeBps
  }

  // Conversion rounds down and the fee rounds up: both in the solver's favour.
  private payoutFor(net: bigint, givesBase: boolean, feeBps: number, toleranceBps: number, price: Price): bigint {
    const { base, quote } = this.props.pair
    const scale = pow10(price.scale)
    const baseUnit = pow10(base.decimals)
    const quoteUnit = pow10(quote.decimals)
    const tolerance = BigInt(toleranceBps)
    const mid = givesBase
      ? (net * price.mantissa * (BPS + tolerance) * quoteUnit) / (baseUnit * scale * BPS)
      : (net * baseUnit * scale * BPS) / (quoteUnit * price.mantissa * (BPS - tolerance))
    return mid - (mid * BigInt(feeBps) + BPS - 1n) / BPS
  }

  // The least input that pays out enough, by search: two rounding steps have no exact inverse.
  private inputFor(
    payout: bigint,
    givesBase: boolean,
    feeBps: number,
    toleranceBps: number,
    price: Price,
  ): bigint | null {
    const reaches = (net: bigint): boolean => this.payoutFor(net, givesBase, feeBps, toleranceBps, price) >= payout
    let high = 1n
    for (let i = 0; i < 256 && !reaches(high); i++) high *= 2n
    if (!reaches(high)) return null
    let low = 1n
    while (low < high) {
      const mid = (low + high) / 2n
      if (reaches(mid)) high = mid
      else low = mid + 1n
    }
    return low
  }
}
