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

/** The terms a swap was agreed on; Market computes them, the swap only keeps them. */
export class Quote {
  private constructor(
    /** The first second at which the quote no longer holds. Null for a standing offer, which never expires. */
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
