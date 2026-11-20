import type { ValueOf } from '../shared/brand.js'
import { InvalidValue } from '../shared/error.js'

export const Rounding = {
  Down: 'down',
  Up: 'up',
} as const

export type Rounding = ValueOf<typeof Rounding>

const DECIMAL = /^(\d+)(?:\.(\d+))?$/
const MAX_DIGITS = 36
export const MAX_DECIMALS = 36

const TEN = 10n

const divRound = (numerator: bigint, denominator: bigint, rounding: Rounding): bigint => {
  const quotient = numerator / denominator
  return rounding === Rounding.Up && numerator % denominator !== 0n ? quotient + 1n : quotient
}

const checkDecimals = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DECIMALS) {
    throw new InvalidValue(`${name} must be an integer in 0..${MAX_DECIMALS}, got ${value}`)
  }
}

const check = (units: bigint, baseDecimals: number, quoteDecimals: number): void => {
  if (units < 0n) throw new InvalidValue(`amount must not be negative, got ${units}`)
  checkDecimals('baseDecimals', baseDecimals)
  checkDecimals('quoteDecimals', quoteDecimals)
}

/** Quote units per one whole base unit (1 BTC, not 1 sat), as an exact decimal. Amounts are in smallest units. */
export class Price {
  private constructor(
    readonly mantissa: bigint,
    readonly scale: number,
  ) {}

  static parse(text: string): Price {
    const match = DECIMAL.exec(text.trim())
    if (!match) throw new InvalidValue('price must be a plain decimal')
    const [, whole = '', fraction = ''] = match
    if (whole.length > MAX_DIGITS || fraction.length > MAX_DIGITS) {
      throw new InvalidValue(`price must have at most ${MAX_DIGITS} digits each side of the point`)
    }
    const mantissa = BigInt(whole + fraction)
    if (mantissa <= 0n) throw new InvalidValue('price must be positive')
    return new Price(mantissa, fraction.length)
  }

  // No default rounding: which way to round is a money decision the caller has to make.
  toQuote(baseUnits: bigint, baseDecimals: number, quoteDecimals: number, rounding: Rounding): bigint {
    check(baseUnits, baseDecimals, quoteDecimals)
    const numerator = baseUnits * this.mantissa * TEN ** BigInt(quoteDecimals)
    return divRound(numerator, TEN ** BigInt(this.scale) * TEN ** BigInt(baseDecimals), rounding)
  }

  toBase(quoteUnits: bigint, baseDecimals: number, quoteDecimals: number, rounding: Rounding): bigint {
    check(quoteUnits, baseDecimals, quoteDecimals)
    const numerator = quoteUnits * TEN ** BigInt(this.scale) * TEN ** BigInt(baseDecimals)
    return divRound(numerator, this.mantissa * TEN ** BigInt(quoteDecimals), rounding)
  }
}
