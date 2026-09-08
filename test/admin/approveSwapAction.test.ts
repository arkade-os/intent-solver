// An approval arrives as an armed console action, never an inbound webhook.
import { describe, it, expect, vi } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { ACTIONS } from '@arkade-os/solver-app/admin/routes/actions.js'

const services = (approveSwap = vi.fn().mockResolvedValue(true)) => ({
  adminStore: {
    approveSwap,
    recordAction: vi.fn().mockResolvedValue(undefined),
    listActions: vi.fn().mockResolvedValue([]),
    getOverrides: vi.fn().mockResolvedValue({}),
  },
  corridors: { get: () => undefined, size: 0, [Symbol.iterator]: () => [][Symbol.iterator]() },
})

const post = (body: unknown, svc = services()) =>
  buildAdminApp({ services: svc as never, startedAt: 1, mode: 'relay' }).fetch(
    new Request('http://admin/api/actions/approve-swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

describe('the approve-swap action', () => {
  it('is ARMED and confirmed by the swap id', () => {
    const definition = ACTIONS['approve-swap']
    expect(definition?.tier).toBe('armed')
    expect(definition?.tier === 'armed' && definition.confirmKind).toBe('swap-id')
  })

  it('says in its warning that it authorises a payout', () => {
    expect(ACTIONS['approve-swap']?.warning).toMatch(/authoris|approv/i)
  })

  it('refuses without a matching confirm, and approves nothing', async () => {
    const approveSwap = vi.fn()
    const response = await post({ id: 'swap-1', confirm: 'nope' }, services(approveSwap))
    expect(response.status).toBe(400)
    expect(approveSwap).not.toHaveBeenCalled()
  })

  it('approves the named swap when the confirmation matches', async () => {
    const approveSwap = vi.fn().mockResolvedValue(true)
    const response = await post({ id: 'swap-1', confirm: 'swap-1' }, services(approveSwap))
    expect(response.status).toBe(200)
    expect(approveSwap).toHaveBeenCalledWith('swap-1')
  })

  // Answering ok would let an operator believe a payout was authorised when
  // nothing was, and would pre-authorise an id nobody has seen.
  it('FAILS when there was no held swap by that id', async () => {
    const response = await post({ id: 'ghost', confirm: 'ghost' }, services(vi.fn().mockResolvedValue(false)))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ ok: false })
  })
})
