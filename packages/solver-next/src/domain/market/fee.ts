import { checkBps } from '../shared/bps.js'
import { InvalidValue } from '../shared/error.js'

const BPS = 10_000n

export class Fee {
  static readonly FREE = new Fee(0, 0n)

  private constructor(
    readonly bps: number,
    readonly flat: bigint,
  ) {}

  static of(bps: number, flat: bigint): Fee {
    checkBps('fee', bps)
    if (flat < 0n) throw new InvalidValue(`flat fee cannot be negative, got ${flat}`)
    return new Fee(bps, flat)
  }

  /**
   * The same fee with its flat part replaced by what the network charges right now, held inside `min..cap`.
   * An unknown cost falls back to the configured flat fee rather than to zero.
   */
  withNetworkCost(cost: number | null, cap: bigint, min = 0n): Fee {
    if (min > cap) throw new InvalidValue(`network fee floor ${min} exceeds its cap ${cap}, so the cap can never hold`)
    const known = cost === null || !Number.isFinite(cost) || cost < 0 ? this.flat : BigInt(Math.ceil(cost))
    const capped = known < cap ? known : cap
    return new Fee(this.bps, capped > min ? capped : min)
  }

  /** Rounded up, in the solver's favour. */
  on(give: bigint): bigint {
    const proportional = give * BigInt(this.bps)
    return proportional / BPS + (proportional % BPS === 0n ? 0n : 1n) + this.flat
  }

  /** Not clamped: zero or less means the fee consumes the swap, and the caller must refuse it. */
  payoutFor(give: bigint): bigint {
    return give - this.on(give)
  }

  // Corrected upward by search: a closed-form inverse lands one unit low where the fee rounds.
  giveFor(payout: bigint): bigint {
    const numerator = (payout + this.flat) * BPS
    const denominator = BPS - BigInt(this.bps)
    let give = numerator / denominator + (numerator % denominator === 0n ? 0n : 1n)
    while (this.payoutFor(give) < payout) give++
    return give
  }
}
