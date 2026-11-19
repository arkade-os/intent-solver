import { Amount } from '../shared/amount.js'
import type { Asset } from '../shared/asset.js'
import { InvalidValue, RuleViolated } from '../shared/error.js'

const positive = (name: string, value: Amount): void => {
  if (value.isZero) throw new InvalidValue(`${name} must be positive, got ${value.units}`)
}

/**
 * What quotes in flight have claimed but no stored swap accounts for yet.
 * Immutable: a reservation returns the next value, or null when it does not fit.
 */
export class Exposure {
  private constructor(
    readonly reserved: Amount,
    // One counter for every payout rail, as today: it over-counts rather than under-counts.
    readonly reservedFloat: Amount,
    private readonly pools: ReadonlyMap<string, Amount>,
  ) {}

  /** Counted in one asset: the cap, the float and every pool are measured in it. */
  static none(asset: Asset): Exposure {
    return new Exposure(Amount.zero(asset), Amount.zero(asset), new Map())
  }

  inventory(pool: string): Amount {
    return this.pools.get(pool) ?? Amount.zero(this.reserved.asset)
  }

  /** `committed`: what stored live swaps already hold against the cap. */
  reserve(size: Amount, committed: Amount, cap: Amount): Exposure | null {
    positive('reservation', size)
    if (committed.plus(this.reserved).plus(size).gt(cap)) return null
    return new Exposure(this.reserved.plus(size), this.reservedFloat, this.pools)
  }

  /** `available` null is an unreadable balance, and that refuses. */
  reserveFloat(required: Amount, owed: Amount, available: Amount | null): Exposure | null {
    positive('float requirement', required)
    if (available === null || owed.plus(this.reservedFloat).plus(required).gt(available)) return null
    return new Exposure(this.reserved, this.reservedFloat.plus(required), this.pools)
  }

  reserveInventory(pool: string, required: Amount, owed: Amount, available: Amount | null): Exposure | null {
    positive('inventory requirement', required)
    if (available === null || owed.plus(this.inventory(pool)).plus(required).gt(available)) return null
    return this.withPool(pool, this.inventory(pool).plus(required))
  }

  /** A hold that outlived a restart is put back as it was: it was admitted once and is not asked again. */
  restoreInventory(pool: string, required: Amount): Exposure {
    positive('inventory requirement', required)
    return this.withPool(pool, this.inventory(pool).plus(required))
  }

  release(size: Amount): Exposure {
    if (size.gt(this.reserved)) throw new RuleViolated('exposure reservation would go negative')
    return new Exposure(this.reserved.minus(size), this.reservedFloat, this.pools)
  }

  releaseFloat(required: Amount): Exposure {
    if (required.gt(this.reservedFloat)) throw new RuleViolated('float reservation would go negative')
    return new Exposure(this.reserved, this.reservedFloat.minus(required), this.pools)
  }

  releaseInventory(pool: string, required: Amount): Exposure {
    if (required.gt(this.inventory(pool))) {
      throw new RuleViolated(`inventory reservation for ${pool} would go negative`)
    }
    return this.withPool(pool, this.inventory(pool).minus(required))
  }

  private withPool(pool: string, held: Amount): Exposure {
    return new Exposure(this.reserved, this.reservedFloat, new Map(this.pools).set(pool, held))
  }
}
