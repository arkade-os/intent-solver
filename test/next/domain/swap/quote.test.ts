import { describe, expect, it } from 'vitest'
import { InvalidValue } from '@arkade-os/solver-next/domain/shared/error.js'
import { Quote } from '@arkade-os/solver-next/domain/swap/quote.js'
import { btc, t } from '../support.js'

describe('Quote', () => {
  it('stops holding at its last second, not after it', () => {
    const quote = Quote.of(t(1_000), { fee: btc(10n), spreadBps: 25 })
    expect([quote.expiredAt(t(999)), quote.expiredAt(t(1_000)), quote.expiredAt(t(1_001))]).toEqual([false, true, true])
  })

  it('never expires when it is a standing offer', () => {
    expect(Quote.of(null, { fee: btc(0n), spreadBps: 0 }).expiredAt(t(4_000_000_000))).toBe(false)
  })

  it('refuses a spread that is not whole basis points below the whole amount', () => {
    for (const spreadBps of [-1, 0.5, 10_000]) {
      expect(() => Quote.of(null, { fee: btc(0n), spreadBps })).toThrow(InvalidValue)
    }
  })
})
