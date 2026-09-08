/** The refusal tail: the only trace a declined offer leaves. */
import { describe, it, expect } from 'vitest'
import { createOfferRefusalTail, OFFER_REFUSAL_TAIL_CAPACITY } from '@arkade-os/solver-app/admin/offerRefusals.js'

const refusal = (over: Record<string, unknown> = {}) => ({
  at: 1_000,
  outpoint: `${'ab'.repeat(32)}:0`,
  reason: 'price_out_of_tolerance' as const,
  detail: 'wants 5000 BTC for 1000000 USDT',
  ...over,
})

describe('the offer refusal tail', () => {
  it('hands back what was recorded, reason and detail intact', () => {
    const tail = createOfferRefusalTail()
    tail.record(refusal())
    expect(tail.recent().entries).toEqual([refusal()])
  })

  it('is newest first, so the reason an operator just triggered is at the top', () => {
    const tail = createOfferRefusalTail()
    tail.record(refusal({ outpoint: 'first:0', at: 1 }))
    tail.record(refusal({ outpoint: 'second:0', at: 2 }))
    expect(tail.recent().entries.map((entry) => entry.outpoint)).toEqual(['second:0', 'first:0'])
  })

  it('drops the oldest past its capacity rather than growing without bound', () => {
    const tail = createOfferRefusalTail(2)
    tail.record(refusal({ outpoint: 'a:0' }))
    tail.record(refusal({ outpoint: 'b:0' }))
    tail.record(refusal({ outpoint: 'c:0' }))
    expect(tail.recent().entries.map((entry) => entry.outpoint)).toEqual(['c:0', 'b:0'])
    expect(tail.recent().capacity).toBe(2)
  })

  it('declares itself ephemeral, so an empty list is not read as "none refused"', () => {
    const tail = createOfferRefusalTail()
    expect(tail.recent()).toEqual({ entries: [], ephemeral: true, capacity: OFFER_REFUSAL_TAIL_CAPACITY })
  })

  it('hands back a copy, so a caller that sorts it cannot reshape the buffer', () => {
    const tail = createOfferRefusalTail()
    tail.record(refusal())
    tail.recent().entries.length = 0
    expect(tail.recent().entries).toHaveLength(1)
  })
})
