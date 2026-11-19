import { checkBps } from '../shared/bps.js'
import type { UnixSeconds } from '../shared/time.js'
import { Inventory } from './inventory.js'
import { InvalidValue } from '../shared/error.js'

export interface RebalanceLimits {
  readonly enabled: boolean
  readonly reserve: bigint
  readonly maxDebit: bigint
  readonly dailyDebit: bigint
  readonly maxFee: bigint
  readonly maxFeeBps: number
  readonly minTransfer: bigint
  readonly cooldownSeconds: number
}

/** Binds AUTOMATIC transfers. A manual one is an operator's own decision and is not capped by it. */
export class RebalancePolicy {
  private constructor(readonly limits: RebalanceLimits) {}

  static of(limits: RebalanceLimits): RebalancePolicy {
    const { enabled, reserve, maxDebit, dailyDebit, maxFee, maxFeeBps, minTransfer, cooldownSeconds } = limits
    // Checked even when disabled: a negative reserve would quietly widen what may be spent once it is switched on.
    if ([reserve, maxDebit, dailyDebit, maxFee, minTransfer].some((limit) => limit < 0n)) {
      throw new InvalidValue('rebalance limits cannot be negative')
    }
    if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0) {
      throw new InvalidValue(`cooldown must be a whole number of seconds, got ${cooldownSeconds}`)
    }
    // A cap, not a fee taken from a payout: 100% is a legitimate "fees do not bind".
    checkBps('maxFeeBps', maxFeeBps, 10_000)
    if (enabled && !(maxDebit > 0n && dailyDebit > 0n && minTransfer > 0n)) {
      throw new InvalidValue('an enabled rebalance policy needs positive maxDebit, dailyDebit and minTransfer')
    }
    return new RebalancePolicy(limits)
  }

  /** The most depleted inventory worth a transfer, or null: disabled, cooling down, or nothing below its minimum. */
  select(
    inventories: readonly Inventory[],
    pending: ReadonlyMap<string, bigint>,
    now: UnixSeconds,
    lastAttempt: UnixSeconds | null,
  ): { readonly inventory: Inventory; readonly net: bigint } | null {
    const { enabled, cooldownSeconds, minTransfer } = this.limits
    if (!enabled) return null
    if (lastAttempt !== null && (now < lastAttempt || now - lastAttempt < cooldownSeconds)) return null
    const [first] = inventories
      .flatMap((inventory) => {
        const net = inventory.shortfall(pending.get(inventory.endpoint.key) ?? 0n)
        return net !== null && net >= minTransfer ? [{ inventory, net }] : []
      })
      .sort((a, b) => Inventory.byUrgency(a.inventory, b.inventory))
    return first ?? null
  }

  /** How much to ask for now, capped per transfer and by what the rolling day has left. Null when that is too little to move. */
  amountFor(net: bigint, debitedToday: bigint): bigint | null {
    const left = this.limits.dailyDebit - debitedToday
    const capped = [net, this.limits.maxDebit, left].reduce((a, b) => (b < a ? b : a))
    return capped >= this.limits.minTransfer && capped > 0n ? capped : null
  }

  /** The caps bind what actually leaves the source, which is the credit PLUS its fees. */
  debitAllowed(debit: bigint, debitedToday: bigint): boolean {
    return debit <= this.limits.maxDebit && debit + debitedToday <= this.limits.dailyDebit
  }

  feesAllowed(net: bigint, debit: bigint): boolean {
    if (net <= 0n || debit < net) throw new InvalidValue('source debit must cover a positive net credit')
    const fees = debit - net
    return fees <= this.limits.maxFee && fees * 10_000n <= net * BigInt(this.limits.maxFeeBps)
  }
}
