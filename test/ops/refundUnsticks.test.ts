/** A refused row with a pushed refund leaves the live queue and presents as refunded. */

import { describe, it, expect } from 'vitest'
import { LEGAL_EDGES_FOR_TEST } from '@arkade-os/solver-corridors/db/swaps.js'
import { phaseOf } from '../support/phaseOf.js'

describe('the lifecycle allows a refunded stuck row to close', () => {
  it('has an edge from stuck to refused', () => {
    expect(LEGAL_EDGES_FOR_TEST.stuck).toContain('refused')
  })

  it('keeps the operator claim edge alongside it', () => {
    // The two ways a human resolves a stuck row, and both must exist: claim
    // when the payment settled, refund when it did not.
    expect(LEGAL_EDGES_FOR_TEST.stuck).toContain('claiming')
  })

  it('stays forward-only — no path back into paying or paid', () => {
    // The invariant the whole table exists for. A row that reached `stuck` may
    // already have sent sats; an edge back into a payment state would let it
    // send them twice.
    expect(LEGAL_EDGES_FOR_TEST.stuck).not.toContain('paying')
    expect(LEGAL_EDGES_FOR_TEST.stuck).not.toContain('paid')
    expect(LEGAL_EDGES_FOR_TEST.refused).toEqual([])
  })
})

describe('a refunded row does not read as success', () => {
  it('presents as refunded, and refunded is not a delivered phase', () => {
    // `refused` + a refund outcome is presented as `refunded` by
    // `presentedState`, which is the word the other three corridors use. It
    // must land in `failed`: the swap ended safely, but it did not deliver.
    expect(phaseOf('arkade:BTC->lightning:BTC', 'refunded')).toBe('failed')
  })

  it('is not exposed and not live, so no sweep walks it again', () => {
    expect(phaseOf('arkade:BTC->lightning:BTC', 'refused')).toBe('failed')
  })
})
