export type Leg = 'base' | 'quote'

export interface MarketLegs {
  base: string | null
  quote: string | null
}

export interface Direction {
  wire: 'sell_base' | 'buy_base'
  gives: Leg
  receives: Leg
  open: 'rfqSellBase' | 'rfqBuyBase'
  bound: 'sellBase' | 'buyBase'
  min: 'sellBaseMin' | 'buyBaseMin'
  max: 'sellBaseMax' | 'buyBaseMax'
  flat: 'sellBaseFeeFlat' | 'buyBaseFeeFlat'
  bps: 'sellBaseFeeBps' | 'buyBaseFeeBps'
}

export interface AssetLabel {
  ticker?: string
  decimals?: number
}

export interface Range {
  min: string
  max: string
}

export declare const isBtcLeg: (leg: string | null | undefined) => boolean
export declare const assetLeg: (draft: MarketLegs) => Leg
export declare const pairKey: (base: string | null, quote: string | null) => string
export declare const decimalsOf: (value: unknown) => number | null
export declare const toAtomic: (text: string, decimals: unknown) => string | null
export declare const toHuman: (atomic: string, decimals: unknown) => string
export declare const configSymbol: (
  knobs: { key: string; value: unknown }[] | undefined,
  assetId: string,
) => string | null
export declare const tickerSymbol: (label: AssetLabel | null | undefined) => string | null
export declare const issuerDecimals: (label: AssetLabel | null | undefined) => number | null
export declare const carrierModeFor: (charged: boolean) => 'priced' | 'off'
export declare const carrierCharged: (mode: string, chargedByDefault: boolean) => boolean
export declare const directions: (draft: MarketLegs) => [Direction, Direction]
export declare const derivedPricePath: (feedUrl: string) => string | null
export declare const limitDefaults: (
  feed: { mantissa: string; scale: number } | null | undefined,
  assetDecimals: unknown,
) => { btc: Range; asset: Range } | null
