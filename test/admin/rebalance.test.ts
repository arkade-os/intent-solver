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
    transfersPage: vi.fn().mockResolvedValue({ transfers: [transfer], nextCursor: null }),
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
  it('pages safe transfer summaries and rejects malformed page requests', async () => {
    const { app, service } = setup()
    const cursor = Buffer.from(JSON.stringify([100, 'q1'])).toString('base64url')
    const response = await app.request(`/api/rebalance/transfers?limit=20&before=${cursor}`)
    expect(response.status).toBe(200)
    expect(service.transfersPage).toHaveBeenCalledWith(20, { createdAt: 100, id: 'q1' })
    expect(await response.text()).not.toMatch(/private-destination|secret|routeData/)
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'before=bad', 'before=%21%21%21']) {
      expect((await app.request(`/api/rebalance/transfers?${query}`)).status).toBe(400)
    }
    expect(service.transfersPage).toHaveBeenCalledTimes(1)
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
  it('returns safe transfer evidence for the history and quote review', async () => {
    const { app, service } = setup()
    const fundingTxid = 'ab'.repeat(32)
    const sourceTxid = 'cd'.repeat(32)
    const destination = `bc1q${'q'.repeat(38)}`
    service.overview.mockResolvedValue({
      pools: [],
      policy: {},
      transfers: [
        {
          ...transfer,
          chargedAt: 100,
          fundingTxid,
          receivingFeeAllowanceSats: 1000,
          inputs: [
            { txid: sourceTxid, vout: 2, value: 5000 },
            { txid: 'secret', vout: -1, value: 1 },
          ],
          deposit: {
            ...transfer.deposit,
            destination,
            amountSats: 103,
            netSats: 100,
            feeSats: 3,
            paymentHash: 'secret',
          },
        },
      ],
    } as never)
    const response = await app.request('/api/rebalance')
    const body = (await response.json()) as { transfers: Record<string, unknown>[] }
    expect(body.transfers[0]).toMatchObject({
      chargedAt: 100,
      fundingTxid,
      receivingFeeAllowanceSats: 1000,
      inputs: [{ txid: sourceTxid, vout: 2 }],
      deposit: { kind: 'onchain', destination, amountSats: 103, netSats: 100, feeSats: 3 },
    })
    expect(JSON.stringify(body)).not.toMatch(/secret|paymentHash|routeData|"value"/)
  })
  it('never exposes a Lightning invoice or private transfer failure in the summary', async () => {
    const { app, service } = setup()
    service.overview.mockResolvedValue({
      pools: [],
      policy: {},
      transfers: [
        {
          ...transfer,
          error: 'secret Lightning invoice lnbc1private',
          fundingTxid: 'secret',
          deposit: { ...transfer.deposit, kind: 'lightning', destination: 'lnbc1private', paymentHash: 'secret' },
        },
      ],
    } as never)
    const response = await app.request('/api/rebalance')
    const body = (await response.json()) as { transfers: Record<string, unknown>[] }
    expect(body.transfers[0]?.deposit).toEqual({ kind: 'lightning' })
    expect(body.transfers[0]?.error).toContain('needs checking')
    expect(JSON.stringify(body)).not.toMatch(/lnbc1private|secret|paymentHash|routeData/)
  })
  it.each(['0', '1000'])('accepts a manual receiving allowance of %s sats', async (allowance) => {
    const { post, service } = setup()
    const response = await post('quote', {
      poolId: 'rail:shared',
      amount: '2000000',
      requestKey: '11111111-1111-4111-8111-111111111111',
      receivingFeeAllowanceSats: allowance,
    })
    expect(response.status).toBe(200)
    expect(service.quote).toHaveBeenCalledWith(
      expect.objectContaining({
        amountSats: 2_000_000,
        receivingFeeAllowanceSats: Number(allowance),
      }),
    )
  })
  it.each(['-1', '1.5', '9007199254740992', 1000])('rejects an invalid receiving allowance %s', async (allowance) => {
    const { post, service } = setup()
    const response = await post('quote', {
      poolId: 'rail:shared',
      amount: '100',
      requestKey: '11111111-1111-4111-8111-111111111111',
      receivingFeeAllowanceSats: allowance,
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toContain('receiving fee allowance')
    expect(service.quote).not.toHaveBeenCalled()
  })
  it('explains a safe refusal category without exposing the route error', async () => {
    const { post, service, recordAction } = setup()
    service.quote.mockRejectedValue(new Error('insufficient unreserved asset-free source inventory; secret invoice'))
    const response = await post('quote', {
      poolId: 'rail:shared',
      amount: '2000000',
      requestKey: '11111111-1111-4111-8111-111111111111',
    })
    expect(((await response.json()) as { message: string }).message).toContain('Available Arkade funds')
    expect(JSON.stringify(recordAction.mock.calls)).not.toContain('secret')
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
  it.each([
    ['source selection cannot cover this transfer within the 50 input limit', 'input limit'],
    ['TX_TOO_LARGE: proof weight exceeds limit', 'transaction size'],
  ])('explains the selection refusal %s without leaking details', async (error, expected) => {
    const { post, service, recordAction } = setup()
    service.quote.mockRejectedValue(new Error(`${error}; secret invoice`))
    const response = await post('quote', {
      poolId: 'rail:shared',
      amount: '2000000',
      requestKey: '11111111-1111-4111-8111-111111111111',
    })
    expect(response.status).toBe(400)
    const message = ((await response.json()) as { message: string }).message
    expect(message).toContain(expected)
    expect(message).not.toContain('secret')
    expect(JSON.stringify(recordAction.mock.calls)).not.toContain('secret')
  })
})
