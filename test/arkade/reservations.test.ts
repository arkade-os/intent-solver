import { describe, expect, it } from 'vitest'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'

const outpoint = (txid: string, vout = 0) => ({ txid, vout })

describe('createReservationLedger', () => {
  it('starts empty and pins what it is given', () => {
    const ledger = createReservationLedger()
    expect(ledger.reserved().size).toBe(0)
    ledger.reserve([outpoint('a'), outpoint('b', 1)])
    expect([...ledger.reserved()].sort()).toEqual(['a:0', 'b:1'])
  })

  it('releases exactly what that call pinned', () => {
    const ledger = createReservationLedger()
    const release = ledger.reserve([outpoint('a')])
    ledger.reserve([outpoint('b')])
    release()
    expect([...ledger.reserved()]).toEqual(['b:0'])
  })

  /**
   * The reason pins are counted rather than a plain Set. Two operations holding
   * the same coin is a caller bug, but if the first release freed it outright
   * the second holder would be spending an outpoint renewal now believes is
   * free — reintroducing the exact race the ledger exists to stop.
   */
  it('keeps a coin pinned until every holder releases', () => {
    const ledger = createReservationLedger()
    const first = ledger.reserve([outpoint('a')])
    const second = ledger.reserve([outpoint('a')])
    first()
    expect(ledger.reserved().has('a:0')).toBe(true)
    second()
    expect(ledger.reserved().has('a:0')).toBe(false)
  })

  it('is idempotent, so a finally-release and a later one do not double-free', () => {
    const ledger = createReservationLedger()
    const other = ledger.reserve([outpoint('a')])
    const release = ledger.reserve([outpoint('a')])
    release()
    release()
    // `other` still holds it; the doubled release must not have freed its pin.
    expect(ledger.reserved().has('a:0')).toBe(true)
    other()
    expect(ledger.reserved().has('a:0')).toBe(false)
  })

  it('hands out a snapshot, not a live view', () => {
    const ledger = createReservationLedger()
    ledger.reserve([outpoint('a')])
    const snapshot = ledger.reserved()
    ledger.reserve([outpoint('b')])
    expect(snapshot.has('b:0')).toBe(false)
  })
})
