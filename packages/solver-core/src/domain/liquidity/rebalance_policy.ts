import { Amount } from '../shared/amount.js'
import { checkBps } from '../shared/bps.js'
import type { UnixSeconds } from '../shared/time.js'
import { Inventory } from './inventory.js'
import { InvalidValue } from '../shared/error.js'

export interface RebalanceLimits {
  readonly enabled: boolean
  readonly reserve: Amount
  readonly maxDebit: Amount
  readonly dailyDebit: Amount
  readonly maxFee: Amount
  readonly maxFeeBps: number
  readonly minTransfer: Amount
  readonly cooldownSeconds: number
}

/** Binds AUTOMATIC transfers. A manual one is an operator's own decision and is not capped by it. */
export class RebalancePolicy {
  private constructor(readonly limits: RebalanceLimits) {}

  static of(limits: RebalanceLimits): RebalancePolicy {
    const { enabled, reserve, maxDebit, dailyDebit, maxFee, maxFeeBps, minTransfer, cooldownSeconds } = limits
    if ([maxDebit, dailyDebit, maxFee, minTransfer].some((limit) => limit.asset !== reserve.asset)) {
      throw new InvalidValue('rebalance limits must all be in one asset')
    }
    if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0) {
      throw new InvalidValue(`cooldown must be a whole number of seconds, got ${cooldownSeconds}`)
    }
    // A cap, not a fee taken from a payout: 100% is a legitimate "fees do not bind".
    checkBps('maxFeeBps', maxFeeBps, 10_000)
    if (enabled && (maxDebit.isZero || dailyDebit.isZero || minTransfer.isZero)) {
      throw new InvalidValue('an enabled rebalance policy needs positive maxDebit, dailyDebit and minTransfer')
    }
    return new RebalancePolicy(limits)
  }

  /** The most depleted inventory worth a transfer, or null: disabled, cooling down, or nothing below its minimum. */
  select(
    inventories: readonly Inventory[],
    pending: ReadonlyMap<string, Amount>,
    now: UnixSeconds,
    lastAttempt: UnixSeconds | null,
  ): { readonly inventory: Inventory; readonly net: Amount } | null {
    const { enabled, cooldownSeconds, minTransfer } = this.limits
    if (!enabled) return null
    if (lastAttempt !== null && (now < lastAttempt || now - lastAttempt < cooldownSeconds)) return null
    const [first] = inventories
      .flatMap((inventory) => {
        const { key, asset } = inventory.endpoint
        const net = inventory.shortfall(pending.get(key) ?? Amount.zero(asset))
        return net !== null && net.gte(minTransfer) ? [{ inventory, net }] : []
      })
      .sort((a, b) => Inventory.byUrgency(a.inventory, b.inventory))
    return first ?? null
  }

  /** How much to ask for now, capped per transfer and by what the rolling day has left. Null when that is too little to move. */
  amountFor(net: Amount, debitedToday: Amount): Amount | null {
    const { dailyDebit, maxDebit, minTransfer } = this.limits
    if (!dailyDebit.gt(debitedToday)) return null
    const capped = [net, maxDebit, dailyDebit.minus(debitedToday)].reduce((a, b) => (a.gt(b) ? b : a))
    return capped.gte(minTransfer) && !capped.isZero ? capped : null
  }

  /** The caps bind what actually leaves the source, which is the credit PLUS its fees. */
  debitAllowed(debit: Amount, debitedToday: Amount): boolean {
    return this.limits.maxDebit.gte(debit) && this.limits.dailyDebit.gte(debit.plus(debitedToday))
  }

  feesAllowed(net: Amount, debit: Amount): boolean {
    if (net.isZero || !debit.gte(net)) throw new InvalidValue('source debit must cover a positive net credit')
    const fees = debit.minus(net)
    return this.limits.maxFee.gte(fees) && fees.units * 10_000n <= net.units * BigInt(this.limits.maxFeeBps)
  }
}
