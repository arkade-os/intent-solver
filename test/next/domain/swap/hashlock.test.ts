import { describe, expect, it } from 'vitest'
import { InvalidValue } from '@arkade-os/solver-next/domain/shared/error.js'
import { Hashlock, Preimage } from '@arkade-os/solver-next/domain/swap/hashlock.js'

const SECRET = Preimage.of('11'.repeat(32))
const LOCK = Hashlock.of('02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc')

describe('Hashlock and Preimage', () => {
  it('is the sha256 of its preimage, and only that preimage opens it', () => {
    expect(Hashlock.ofPreimage(SECRET)).toBe(LOCK)
    expect(Preimage.opens(SECRET, LOCK)).toBe(true)
    expect(Preimage.opens(Preimage.of('22'.repeat(32)), LOCK)).toBe(false)
  })

  it('takes 32 bytes of lowercase hex and nothing else', () => {
    for (const bad of [
      '',
      'zz'.repeat(32),
      '11'.repeat(31),
      '11'.repeat(33),
      'AA'.repeat(32),
      `0x${'11'.repeat(31)}`,
    ]) {
      expect(() => Hashlock.of(bad)).toThrow(InvalidValue)
      expect(() => Preimage.of(bad)).toThrow(InvalidValue)
    }
  })
})
