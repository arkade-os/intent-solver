import { describe, it, expect } from 'vitest'
import { LnReceiveMachine } from '@arkade-os/solver-corridors/machines/lnReceive.js'
import { NON_TERMINAL, EXPOSED } from '@arkade-os/solver-corridors/db/receiveSwaps.js'

describe('LnReceiveMachine', () => {
  it('declares the whole lifecycle in forward-only order', () => {
    expect(LnReceiveMachine.states).toEqual([
      'quoted',
      'armed',
      'funded',
      'claimed',
      'refunding',
      'settled',
      'refunded',
      'refused',
      'stuck',
    ])
  })

  it('marks live and exposed exactly where the provider lockup is at risk', () => {
    expect(LnReceiveMachine.live).toEqual(['quoted', 'armed', 'funded', 'claimed', 'refunding'])
    // Exposed: the provider's own Arkade lockup may be funded and not yet made whole.
    expect(LnReceiveMachine.exposed).toEqual(['funded', 'claimed', 'refunding'])
  })

  it('transcribes the legal edges, with the lost-funding armed -> stuck escalation', () => {
    expect(LnReceiveMachine.edges).toEqual({
      quoted: ['armed', 'refused'],
      armed: ['funded', 'refused', 'stuck'],
      funded: ['claimed', 'refunding', 'refunded', 'stuck'],
      claimed: ['settled', 'stuck'],
      refunding: ['refunded', 'claimed', 'stuck'],
      settled: [],
      refunded: [],
      refused: [],
      stuck: [],
    })
  })

  it('is the single lifecycle source the store reads from', () => {
    expect(NON_TERMINAL).toEqual(LnReceiveMachine.live)
    expect(EXPOSED).toEqual(LnReceiveMachine.exposed)
  })
})
