import { InvalidValue } from './error.js'

// 10000 is refused: a 100% fee leaves nothing to pay out, and inverting it divides by zero.
export const checkBps = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value < 0 || value > 9_999)
    throw new InvalidValue(`${name} must be 0..9999 bps, got ${value}`)
  return value
}
