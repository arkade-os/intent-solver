import type { Asset } from '../shared/asset.js'
import { MAX_DECIMALS } from './price.js'

export interface Denomination {
  readonly asset: Asset
  readonly decimals: number
}

export class Pair {
  private constructor(
    readonly base: Denomination,
    readonly quote: Denomination,
    /** Which feed prices it; opaque here, resolved by the price port. */
    readonly priceSource: string,
  ) {}

  static of(base: Denomination, quote: Denomination, priceSource: string): Pair {
    if (base.asset === quote.asset) throw new Error(`a pair needs two assets, got ${base.asset} twice`)
    for (const { asset, decimals } of [base, quote]) {
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
        throw new Error(`${asset} decimals must be an integer in 0..${MAX_DECIMALS}, got ${decimals}`)
      }
    }
    return new Pair(base, quote, priceSource)
  }

  has(asset: Asset): boolean {
    return asset === this.base.asset || asset === this.quote.asset
  }
}
