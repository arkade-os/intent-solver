const positive = (name: string, value: bigint): void => {
  if (value <= 0n) throw new Error(`${name} must be positive, got ${value}`)
}

// A negative reading is a broken input, not a small balance: letting it through would widen the cap.
const readable = (name: string, value: bigint): void => {
  if (value < 0n) throw new Error(`${name} cannot be negative, got ${value}`)
}

/**
 * What quotes in flight have claimed but no stored swap accounts for yet.
 * Immutable: a reservation returns the next value, or null when it does not fit.
 */
export class Exposure {
  static readonly NONE = new Exposure(0n, 0n, new Map())

  private constructor(
    readonly reserved: bigint,
    // One counter for every payout rail, as today: it over-counts rather than under-counts.
    readonly reservedFloat: bigint,
    private readonly pools: ReadonlyMap<string, bigint>,
  ) {}

  inventory(pool: string): bigint {
    return this.pools.get(pool) ?? 0n
  }

  /** `committed`: what stored live swaps already hold against the cap. */
  reserve(size: bigint, committed: bigint, cap: bigint): Exposure | null {
    positive('reservation', size)
    readable('committed', committed)
    if (committed + this.reserved + size > cap) return null
    return new Exposure(this.reserved + size, this.reservedFloat, this.pools)
  }

  /** `available` null is an unreadable balance, and that refuses. */
  reserveFloat(required: bigint, owed: bigint, available: bigint | null): Exposure | null {
    positive('float requirement', required)
    readable('owed float', owed)
    if (available !== null) readable('available float', available)
    if (available === null || owed + this.reservedFloat + required > available) return null
    return new Exposure(this.reserved, this.reservedFloat + required, this.pools)
  }

  reserveInventory(pool: string, required: bigint, owed: bigint, available: bigint | null): Exposure | null {
    positive('inventory requirement', required)
    readable('owed inventory', owed)
    if (available !== null) readable('available inventory', available)
    if (available === null || owed + this.inventory(pool) + required > available) return null
    return this.withPool(pool, this.inventory(pool) + required)
  }

  /** A hold that outlived a restart is put back as it was: it was admitted once and is not asked again. */
  restoreInventory(pool: string, required: bigint): Exposure {
    positive('inventory requirement', required)
    return this.withPool(pool, this.inventory(pool) + required)
  }

  release(size: bigint): Exposure {
    if (size > this.reserved) throw new Error('exposure reservation would go negative')
    return new Exposure(this.reserved - size, this.reservedFloat, this.pools)
  }

  releaseFloat(required: bigint): Exposure {
    if (required > this.reservedFloat) throw new Error('float reservation would go negative')
    return new Exposure(this.reserved, this.reservedFloat - required, this.pools)
  }

  releaseInventory(pool: string, required: bigint): Exposure {
    return this.withPool(pool, this.inventory(pool) - required)
  }

  private withPool(pool: string, held: bigint): Exposure {
    if (held < 0n) throw new Error(`inventory reservation for ${pool} would go negative`)
    return new Exposure(this.reserved, this.reservedFloat, new Map(this.pools).set(pool, held))
  }
}
