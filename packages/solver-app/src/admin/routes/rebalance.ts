import type { Hono } from 'hono'
import type { RebalanceTransfer } from '@arkade-os/solver-core/ports/rebalance.js'
import type { AdminDeps } from '../server.js'
import { parseWholeSats } from '../../ops/fundSources.js'

export const transferSummary = (t: RebalanceTransfer) => ({
  id: t.id,
  poolId: t.poolId,
  origin: t.origin,
  kind: t.deposit.kind,
  state: t.state,
  netSats: t.netSats,
  debitSats: t.debitSats,
  feeSats: t.feeSats,
  expiresAt: t.expiresAt,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  creditedSats: t.creditedSats,
  error: t.error,
})

export const registerRebalanceRoutes = (app: Hono, deps: AdminDeps): void => {
  app.get('/api/rebalance', async (c) => {
    const service = deps.services.rebalance
    if (!service) return c.json({ error: 'unsupported', message: 'rebalancing is unavailable on this deployment' }, 503)
    const overview = await service.overview()
    return c.json({ ...overview, transfers: overview.transfers.map(transferSummary) })
  })

  for (const action of ['policy', 'quote', 'submit', 'cancel'] as const) {
    app.post(`/api/rebalance/${action}`, async (c) => {
      const service = deps.services.rebalance
      if (!service)
        return c.json({ error: 'unsupported', message: 'rebalancing is unavailable on this deployment' }, 503)
      let target: string | null = null
      let params = '{}'
      try {
        const body: unknown = await c.req.json()
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid request')
        const b = body as Record<string, unknown>
        const allowed =
          action === 'policy'
            ? ['policy', 'confirm']
            : action === 'quote'
              ? ['poolId', 'amount', 'requestKey', 'kind']
              : ['id', 'confirm']
        if (Object.keys(b).some((key) => !allowed.includes(key))) throw new Error('unexpected request field')
        if (action === 'policy' && b.confirm !== 'REBALANCE') throw new Error('confirmation required')
        if (action === 'submit' || action === 'cancel') {
          if (typeof b.id !== 'string' || !b.id || b.confirm !== b.id)
            throw new Error('matching transfer confirmation required')
          target = b.id
        }
        let result
        if (action === 'quote') {
          if (
            typeof b.poolId !== 'string' ||
            !b.poolId ||
            typeof b.amount !== 'string' ||
            typeof b.requestKey !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.requestKey)
          )
            throw new Error('pool, whole-satoshi amount and UUID request key required')
          if (b.kind !== undefined && b.kind !== 'onchain' && b.kind !== 'lightning')
            throw new Error('unsupported deposit kind')
          const quoteParams = {
            poolId: b.poolId,
            amountSats: parseWholeSats(b.amount),
            requestKey: b.requestKey,
            kind: b.kind as 'onchain' | 'lightning' | undefined,
          }
          params = JSON.stringify({
            poolId: quoteParams.poolId,
            amountSats: quoteParams.amountSats,
            kind: quoteParams.kind,
          })
          result = transferSummary(await service.quote(quoteParams))
          target = result.id
        } else if (action === 'policy') {
          result = await service.setPolicy(b.policy)
        } else {
          result = transferSummary(await service[action](target!))
        }
        await deps.services.adminStore.recordAction({
          action: `rebalance-${action}`,
          target,
          params,
          outcome: 'ok',
          detail: action === 'policy' ? 'policy stored' : 'transfer operation accepted',
        })
        return c.json({ ok: true, result })
      } catch {
        await deps.services.adminStore.recordAction({
          action: `rebalance-${action}`,
          target,
          params,
          outcome: 'error',
          detail: 'request refused or operation failed',
        })
        return c.json(
          {
            error: 'rebalance_failed',
            message:
              'Rebalance request refused or operation failed. Check confirmation, policy limits and transfer status.',
          },
          400,
        )
      }
    })
  }
}
