import type { ValueOf } from '../shared/brand.js'

/** Which amount the client fixed: what they give (`from`) or what they receive (`to`). */
export const QuoteSide = {
  From: 'from',
  To: 'to',
} as const

export type QuoteSide = ValueOf<typeof QuoteSide>

export const QuoteRefusal = {
  RouteDisabled: 'route_disabled',
  UnsupportedPair: 'unsupported_pair',
  PriceUnavailable: 'price_unavailable',
  FeeConsumesSwap: 'fee_consumes_swap',
  AmountOutOfRange: 'amount_out_of_range',
  PayoutBelowDust: 'payout_below_dust',
} as const

export type QuoteRefusal = ValueOf<typeof QuoteRefusal>

export type PricedQuote =
  | { readonly ok: true; readonly give: bigint; readonly payout: bigint }
  | { readonly ok: false; readonly reason: QuoteRefusal }

export const refuse = (reason: QuoteRefusal): PricedQuote => ({ ok: false, reason })
