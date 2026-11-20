import { describe, expect, it } from 'vitest'
import { Leg, LegMachine } from '@arkade-os/solver-core/domain/swap/leg.js'
import { btc, ref, t } from '../support.js'

describe('leg state machine', () => {
  it('has the edges of the domain model', () => {
    expect(LegMachine.edges).toEqual({
      pending: ['locking', 'locked', 'claiming', 'claimed'],
      locking: ['pending', 'locked', 'claiming', 'claimed', 'refunding'],
      locked: ['claiming', 'claimed', 'refunding', 'refunded'],
      claiming: ['claimed', 'refunded'],
      refunding: ['claiming', 'claimed', 'refunded'],
      claimed: [],
      refunded: [],
    })
    expect(LegMachine.terminal).toEqual(['claimed', 'refunded'])
  })

  it('never locks or refunds a Lightning payment we send, nor the payment of an offer', () => {
    for (const contract of ['lightning', 'payment'] as const) {
      const send = { side: 'to', contract } as const
      expect(Leg.canTransition(send, 'pending', 'locking')).toBe(true)
      expect(Leg.canTransition(send, 'locking', 'claimed')).toBe(true)
      expect(Leg.canTransition(send, 'pending', 'locked')).toBe(false)
      expect(Leg.canTransition(send, 'locking', 'refunding')).toBe(false)
    }
    expect(Leg.canTransition({ side: 'from', contract: 'lightning' }, 'pending', 'locked')).toBe(true)
  })

  it('never refunds an offer', () => {
    const offer = { side: 'from', contract: 'offer' } as const
    expect(Leg.canTransition(offer, 'locked', 'claimed')).toBe(true)
    expect(Leg.canTransition(offer, 'locked', 'refunding')).toBe(false)
    expect(Leg.canTransition(offer, 'locked', 'refunded')).toBe(false)
  })
})

describe('leg', () => {
  const open = (): Leg =>
    Leg.open('from', { rail: 'arkade', amount: btc(1_000n), contract: 'vhtlc', version: null }, t(1))

  it('opens pending and refuses an empty amount', () => {
    expect(open().state).toBe('pending')
    expect(() => Leg.open('to', { rail: 'arkade', amount: btc(0n), contract: 'vhtlc', version: null }, t(1))).toThrow(
      'must be positive',
    )
  })

  it('moves along its edges without mutating', () => {
    const leg = open()
    const locked = leg.moveTo('locked', t(2), { funding: ref('txid') })
    expect(leg.state).toBe('pending')
    expect(locked.reference('funding')).toBe('txid')
    expect(() => leg.moveTo('refunded', t(2))).toThrow('from leg cannot go pending -> refunded')
  })

  it('keeps every version of a reference, the last one current', () => {
    const refunding = open()
      .moveTo('locked', t(2), { funding: ref('txid') })
      .moveTo('refunding', t(3), { refund: ref('refund-1') })
    const bumped = refunding.record({ refund: ref('refund-2') }).record({ refund: ref('refund-2') })
    expect(bumped.references.refund).toEqual(['refund-1', 'refund-2'])
    expect(bumped.reference('refund')).toBe('refund-2')
    expect(bumped.reference('claim')).toBeNull()
    expect(bumped.state).toBe('refunding')
    expect([refunding.since, bumped.since]).toEqual([3, 3])
  })
})
