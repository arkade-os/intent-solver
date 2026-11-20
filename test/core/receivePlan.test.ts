import { describe, expect, it } from 'vitest'
import { planReceive, RECEIVE_INVOICE_NEVER_ARMED } from '@arkade-os/solver-core/core/receivePlan.js'
import type { HoldState } from '@arkade-os/solver-core/ports/lightning.js'

const EXPIRES = 2_000
const quoted = { state: 'quoted', invoiceExpiresAt: EXPIRES }
const pending: HoldState = { status: 'pending', expiresAt: null }
const armed: HoldState = { status: 'armed', expiresAt: 9_000 }
const seen = (over: { hold?: HoldState; coupled?: boolean; nowSeconds?: number } = {}) => ({
  hold: pending,
  coupled: false,
  nowSeconds: EXPIRES - 1,
  ...over,
})

describe('planReceive: quoted', () => {
  it('waits while the invoice is unpaid and not expired', () => {
    expect(planReceive(quoted, seen())).toEqual({ do: 'wait' })
  })

  it('arms on a held payment, with the deadline the node reports', () => {
    expect(planReceive(quoted, seen({ hold: armed }))).toEqual({ do: 'arm', htlcExpiresAt: 9_000 })
  })

  it('lets a held payment win over a coupled send and over an expired invoice', () => {
    const late = seen({ hold: armed, coupled: true, nowSeconds: EXPIRES + 1 })
    expect(planReceive(quoted, late)).toEqual({ do: 'arm', htlcExpiresAt: 9_000 })
  })

  it('hands a coupled send to its own rules, even past the invoice expiry', () => {
    expect(planReceive(quoted, seen({ coupled: true, nowSeconds: EXPIRES + 1 }))).toEqual({ do: 'couple' })
  })

  it('refuses from the first second the invoice is expired', () => {
    expect(planReceive(quoted, seen({ nowSeconds: EXPIRES }))).toEqual({
      do: 'refuse',
      reason: RECEIVE_INVOICE_NEVER_ARMED,
    })
  })

  it('acts only on an exact armed status', () => {
    for (const status of ['pending', 'settled', 'cancelled', 'unknown'] as const) {
      expect(planReceive(quoted, seen({ hold: { status, expiresAt: null } }))).toEqual({ do: 'wait' })
    }
  })

  it('plans nothing yet for the other states', () => {
    expect(planReceive({ ...quoted, state: 'armed' }, seen({ hold: armed }))).toEqual({ do: 'wait' })
  })
})
