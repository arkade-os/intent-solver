import { describe, it, expect, beforeEach } from 'vitest'
import { RateLimiter, QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS } from '@arkade-os/solver-core/core/rateLimit.js'
import { DEFAULT_LOCKUP_TIMEOUT } from '@arkade-os/solver-core/core/send.js'

let clock: number
let limiter: RateLimiter

beforeEach(() => {
  clock = 1_000_000
  limiter = new RateLimiter(3, 100, () => clock)
})

describe('RateLimiter', () => {
  it('allows up to the limit within a window, then refuses', () => {
    expect(limiter.take('k')).toBe(true)
    expect(limiter.take('k')).toBe(true)
    expect(limiter.take('k')).toBe(true)
    expect(limiter.take('k')).toBe(false)
  })

  it('resets the budget once the window has passed', () => {
    for (let i = 0; i < 3; i++) limiter.take('k')
    expect(limiter.take('k')).toBe(false)
    clock += 100
    expect(limiter.take('k')).toBe(true)
  })

  it('tracks keys independently', () => {
    for (let i = 0; i < 3; i++) limiter.take('a')
    expect(limiter.take('a')).toBe(false)
    expect(limiter.take('b')).toBe(true)
  })

  it('a refused take consumes nothing — the next window starts clean', () => {
    for (let i = 0; i < 3; i++) limiter.take('k')
    expect(limiter.take('k')).toBe(false)
    clock += 100
    // Full budget again, not budget-minus-the-refusals.
    for (let i = 0; i < 3; i++) expect(limiter.take('k')).toBe(true)
    expect(limiter.take('k')).toBe(false)
  })

  it('bounds memory by evicting under key-spray pressure', () => {
    const wide = new RateLimiter(1, 1_000_000, () => clock)
    // More distinct keys than the internal bound, none of them expiring.
    for (let i = 0; i < 10_500; i++) expect(wide.take(`k${i}`)).toBe(true)
    // The earliest keys were evicted, so their budget is fresh again — the
    // observable proof that the map shed entries instead of growing forever.
    expect(wide.take('k0')).toBe(true)
  })

  it('the quote quota matches the lockup timeout, so a squatter is refused for as long as their quotes would have held capacity', () => {
    expect(QUOTE_RATE_WINDOW_SECONDS).toBe(DEFAULT_LOCKUP_TIMEOUT)
  })
})
