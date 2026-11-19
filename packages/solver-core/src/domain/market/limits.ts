import type { ValueOf } from '../shared/brand.js'
import { InvalidValue } from '../shared/error.js'

export const LimitBreach = {
  BelowMin: 'below_min',
  AboveMax: 'above_max',
} as const

export type LimitBreach = ValueOf<typeof LimitBreach>

export class Limits {
  private constructor(
    readonly min: bigint,
    readonly max: bigint,
  ) {}

  static of(min: bigint, max: bigint): Limits {
    if (min <= 0n || max <= 0n) throw new InvalidValue(`limits must be positive, got ${min}..${max}`)
    if (min > max) throw new InvalidValue(`limits are empty: min ${min} above max ${max}`)
    return new Limits(min, max)
  }

  /** An override replaces a bound in either direction: what caps the money at risk is the exposure cap, not this range. */
  withBounds(override: { readonly min?: bigint; readonly max?: bigint }): Limits {
    return Limits.of(override.min ?? this.min, override.max ?? this.max)
  }

  breach(units: bigint): LimitBreach | null {
    if (units < this.min) return LimitBreach.BelowMin
    return units > this.max ? LimitBreach.AboveMax : null
  }
}
