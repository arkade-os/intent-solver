import { DomainError, ErrorCode } from './error.js'

// 10000 is refused by default: a 100% fee leaves nothing to pay out, and inverting it divides by zero.
export const checkBps = (name: string, value: number, max = 9_999): number => {
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new DomainError(ErrorCode.Invalid, `${name} must be 0..${max} bps, got ${value}`)
  return value
}
