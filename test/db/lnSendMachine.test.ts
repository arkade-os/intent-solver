import { describe, it, expect } from 'vitest'
import { LnSendMachine } from '@arkade-os/solver-corridors/machines/lnSend.js'
import { NON_TERMINAL, EXPOSED, LEGAL_EDGES_FOR_TEST } from '@arkade-os/solver-corridors/db/swaps.js'

describe('LnSendMachine', () => {
  it('declares the whole lifecycle in forward-only order', () => {
    expect(LnSendMachine.states).toEqual([
      'quoted',
      'funded',
      'paying',
      'paid',
      'claiming',
      'claimed',
      'refused',
      'stuck',
    ])
  })

  it('marks live and exposed exactly where capital is committed', () => {
    expect(LnSendMachine.live).toEqual(['quoted', 'funded', 'paying', 'paid', 'claiming'])
    // Exposed: a Lightning payment may be out and the Arkade side not yet claimed.
    expect(LnSendMachine.exposed).toEqual(['paying', 'paid', 'claiming'])
  })

  it('is the single lifecycle source the store reads from', () => {
    expect(NON_TERMINAL).toEqual(LnSendMachine.live)
    expect(EXPOSED).toEqual(LnSendMachine.exposed)
    expect(LEGAL_EDGES_FOR_TEST).toEqual(LnSendMachine.edges)
  })
})
