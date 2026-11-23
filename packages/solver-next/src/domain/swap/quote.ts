import type { Amount } from '../shared/amount.js'
import { checkBps } from '../shared/bps.js'
import type { ValueOf } from '../shared/brand.js'
import type { UnixSeconds } from '../shared/time.js'

export const AmountMode = {
  ExactIn: 'exactIn',
  ExactOut: 'exactOut',
} as const

export type AmountMode = ValueOf<typeof AmountMode>

export interface Pricing {
  readonly fee: Amount
  readonly spreadBps: number
}

export class Quote {
  private constructor(
    readonly validUntil: UnixSeconds | null,
    readonly pricing: Pricing,
  ) {}

  static of(validUntil: UnixSeconds | null, pricing: Pricing): Quote {
    checkBps('spread', pricing.spreadBps)
    return new Quote(validUntil, pricing)
  }

  expiredAt(now: UnixSeconds): boolean {
    return this.validUntil !== null && now >= this.validUntil
  }
}
