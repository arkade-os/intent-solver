import type { Amount } from '../shared/amount.js'
import type { Endpoint } from '../shared/endpoint.js'
import { DomainError, ErrorCode } from '../shared/error.js'

export interface InventoryTarget {
  /** Below this the inventory is refilled; zero never triggers... */
  readonly minimum: bigint
  /** ...up to this. */
  readonly target: bigint
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
      throw new DomainError(ErrorCode.Invalid, `${endpoint.key} cannot hold a balance in ${balance.asset}`)
    }
    if (target !== null && !(target.minimum >= 0n && target.minimum < target.target)) {
      throw new DomainError(ErrorCode.Invalid, `${endpoint.key}: target needs 0 <= minimum < target`)
    }
    return new Inventory(endpoint, balance, target)
  }

  /** What a refill must credit, counting transfers already on their way. Null when none is due. */
  shortfall(pending: bigint): bigint | null {
    if (this.balance === null || this.target === null || pending < 0n) return null
    if (this.balance.units >= this.target.minimum) return null
    const net = this.target.target - this.balance.units - pending
    return net > 0n ? net : null
  }

  /** Lower balance relative to its minimum is more urgent; cross-multiplied to stay exact. */
  static byUrgency(a: Inventory, b: Inventory): number {
    const left = (a.balance?.units ?? 0n) * (b.target?.minimum ?? 1n)
    const right = (b.balance?.units ?? 0n) * (a.target?.minimum ?? 1n)
    if (left !== right) return left < right ? -1 : 1
    return a.endpoint.key < b.endpoint.key ? -1 : a.endpoint.key > b.endpoint.key ? 1 : 0
  }
}
