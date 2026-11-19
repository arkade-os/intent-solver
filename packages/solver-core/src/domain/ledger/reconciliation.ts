import type { Amount } from '../shared/amount.js'
import type { Endpoint } from '../shared/endpoint.js'
import { DomainError, ErrorCode } from '../shared/error.js'

export class Reconciliation {
  private constructor(
    readonly endpoint: Endpoint,
    readonly ledgerBalance: bigint,
    /** Null when the rail could not be read: unknown, never zero. */
    readonly actualBalance: Amount | null,
  ) {}

  static of(endpoint: Endpoint, ledgerBalance: bigint, actualBalance: Amount | null): Reconciliation {
    if (actualBalance !== null && actualBalance.asset !== endpoint.asset) {
      throw new DomainError(ErrorCode.Invalid, `${endpoint.key} cannot be reconciled against ${actualBalance.asset}`)
    }
    return new Reconciliation(endpoint, ledgerBalance, actualBalance)
  }

  /** Actual minus ledger: positive is value the books do not explain, negative is value they expect and is missing. */
  get difference(): bigint | null {
    return this.actualBalance === null ? null : this.actualBalance.units - this.ledgerBalance
  }

  get balanced(): boolean {
    return this.difference === 0n
  }
}
