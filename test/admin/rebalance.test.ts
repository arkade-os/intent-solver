import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { registerRebalanceRoutes } from '../../packages/solver-app/src/admin/routes/rebalance.js'

const transfer = {
  id: 'q1',
  poolId: 'rail:shared',
  state: 'quoted',
  deposit: { kind: 'onchain', destination: 'private-destination', data: { secret: 'secret' } },
  routeData: { secret: 'secret' },
  netSats: 100,
  feeSats: 5,
  debitSats: 105,
}
const setup = () => {
  const service = {
    overview: vi.fn().mockResolvedValue({ pools: [], policy: {}, transfers: [transfer] }),
    quote: vi.fn().mockResolvedValue(transfer),
    submit: vi.fn().mockResolvedValue(transfer),
    cancel: vi.fn().mockResolvedValue(transfer),
    setPolicy: vi.fn().mockResolvedValue({ enabled: false }),
    tick: vi.fn(),
  }
  const recordAction = vi.fn().mockResolvedValue(undefined)
  const app = new Hono()
  registerRebalanceRoutes(app, { services: { rebalance: service, adminStore: { recordAction } } } as never)
  const post = (action: string, body: unknown) =>
    app.request(`/api/rebalance/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { service, recordAction, app, post }
}

describe('rebalance administration', () => {
  it('reads status without ticking or spending and strips private route data', async () => {
    const { app, service } = setup()
    const response = await app.request('/api/rebalance')
    expect(response.status).toBe(200)
    expect(await response.text()).not.toMatch(/private-destination|secret|routeData/)
    expect(service.tick).not.toHaveBeenCalled()
    expect(service.submit).not.toHaveBeenCalled()
  })
  it.each(['submit', 'cancel', 'policy'])('requires explicit confirmation for %s', async (action) => {
    const { post, service, recordAction } = setup()
    expect((await post(action, { id: 'q1', policy: {} })).status).toBe(400)
    expect(service.submit).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
    expect(service.setPolicy).not.toHaveBeenCalled()
    expect(recordAction).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }))
  })
  it('rejects arbitrary destinations before preparing a deposit', async () => {
    const { post, service } = setup()
    expect(
      (
        await post('quote', {
          poolId: 'rail:shared',
          amount: '100',
          requestKey: '11111111-1111-4111-8111-111111111111',
          destination: 'address',
        })
      ).status,
    ).toBe(400)
    expect(service.quote).not.toHaveBeenCalled()
  })
  it('parses amount and audits only summaries', async () => {
    const { post, service, recordAction } = setup()
    const response = await post('quote', {
      poolId: 'rail:shared',
      amount: '100',
      requestKey: '11111111-1111-4111-8111-111111111111',
    })
    expect(response.status).toBe(200)
    expect(service.quote).toHaveBeenCalledWith(expect.objectContaining({ amountSats: 100 }))
    expect(JSON.stringify(recordAction.mock.calls)).not.toMatch(/private-destination|secret|routeData/)
  })
  it('audits an unknown confirmed submit without leaking the error', async () => {
    const { post, service, recordAction } = setup()
    service.submit.mockRejectedValue(new Error('secret transport credentials'))
    const response = await post('submit', { id: 'unknown', confirm: 'unknown' })
    expect(response.status).toBe(400)
    expect(recordAction).toHaveBeenCalledWith(expect.objectContaining({ target: 'unknown', outcome: 'error' }))
    expect(await response.text()).not.toContain('secret')
    expect(JSON.stringify(recordAction.mock.calls)).not.toContain('secret')
  })
})
