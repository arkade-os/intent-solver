import { Amount } from '../shared/amount.js'
import type { Endpoint } from '../shared/endpoint.js'
import { InvalidValue } from '../shared/error.js'

export interface InventoryTarget {
  /** Below this the inventory is refilled; zero never triggers... */
  readonly minimum: Amount
  /** ...up to this. */
  readonly target: Amount
}

export class Inventory {
  private constructor(
    readonly endpoint: Endpoint,
    /** Null is UNKNOWN, never zero: a rail that cannot be read is blind, not broke. */
    readonly balance: Amount | null,
    readonly target: InventoryTarget | null,
  ) {}

  static of(endpoint: Endpoint, balance: Amount | null, target: InventoryTarget | null): Inventory {
    if (balance !== null && balance.asset !== endpoint.asset) {
      throw new InvalidValue(`${endpoint.key} cannot hold a balance in ${balance.asset}`)
    }
    for (const bound of target === null ? [] : [target.minimum, target.target]) {
      if (bound.asset !== endpoint.asset) throw new InvalidValue(`${endpoint.key} cannot target ${bound.asset}`)
    }
    if (target !== null && !target.target.gt(target.minimum)) {
      throw new InvalidValue(`${endpoint.key}: target needs minimum < target`)
    }
    return new Inventory(endpoint, balance, target)
  }

  /** What a refill must credit, counting transfers already on their way. Null when none is due. */
  shortfall(pending: Amount): Amount | null {
    if (this.balance === null || this.target === null) return null
    if (this.balance.gte(this.target.minimum)) return null
    const expected = this.balance.plus(pending)
    return this.target.target.gt(expected) ? this.target.target.minus(expected) : null
  }

  /** Lower balance relative to its minimum is more urgent; cross-multiplied to stay exact. */
  static byUrgency(a: Inventory, b: Inventory): number {
    const left = (a.balance?.units ?? 0n) * (b.target?.minimum.units ?? 1n)
    const right = (b.balance?.units ?? 0n) * (a.target?.minimum.units ?? 1n)
    if (left !== right) return left < right ? -1 : 1
    return a.endpoint.key < b.endpoint.key ? -1 : a.endpoint.key > b.endpoint.key ? 1 : 0
  }
}
