import type { Asset } from './asset.js'

export class Amount {
  private constructor(
    readonly asset: Asset,
    readonly units: bigint,
  ) {}

  static of(asset: Asset, units: bigint): Amount {
    if (units < 0n) throw new Error(`amount of ${asset} cannot be negative: ${units}`)
    return new Amount(asset, units)
  }

  static zero(asset: Asset): Amount {
    return new Amount(asset, 0n)
  }

  get isZero(): boolean {
    return this.units === 0n
  }

  equals(other: Amount): boolean {
    return this.asset === other.asset && this.units === other.units
  }

  plus(other: Amount): Amount {
    return new Amount(this.asset, this.units + this.sameAsset(other).units)
  }

  minus(other: Amount): Amount {
    return Amount.of(this.asset, this.units - this.sameAsset(other).units)
  }

  gte(other: Amount): boolean {
    return this.units >= this.sameAsset(other).units
  }

  private sameAsset(other: Amount): Amount {
    if (other.asset !== this.asset) throw new Error(`cannot combine ${this.asset} with ${other.asset}`)
    return other
  }
}
