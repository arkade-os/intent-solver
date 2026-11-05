import type { Hono } from 'hono'
import type { RebalanceTransfer } from '@arkade-os/solver-core/ports/rebalance.js'
import type { AdminDeps } from '../server.js'
import { parseWholeSats } from '../../ops/fundSources.js'

const txid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
const whole = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const address = (value: string): boolean =>
  /^(?:[13mn2][a-km-zA-HJ-NP-Z1-9]{25,34}|(?:bc|tb|bcrt)1[ac-hj-np-z02-9]{11,87})$/i.test(value)
const refusalMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : String(error)
  if (/insufficient.*(inventory|funds)|insufficient surplus|source reserve or outstanding payouts/i.test(message))
    return 'Available Arkade funds cannot cover this transfer and outstanding payouts. Try a smaller amount.'
  if (/active rebalance transfer/i.test(message))
    return 'Another transfer is still in progress. Check its status before starting a new transfer.'
  if (/quote expired|policy changed|source debit changed|source input no longer spendable/i.test(message))
    return 'This quote is no longer valid. Review a fresh quote before sending.'
  if (/source inputs are reserved/i.test(message))
    return 'The selected Arkade funds are in use. Wait for the current operation, then review a fresh quote.'
  if (/configure an external Lightning counterparty/i.test(message))
    return 'The Lightning route needs an external solver. Configure one or choose the onchain route.'
  if (/destination pool is unavailable|requested deposit route is unavailable/i.test(message))
    return 'This destination or route is unavailable. Refresh and choose an available route.'
  if (/fees exceed policy limits/i.test(message)) return 'The quoted fees exceed the automatic rebalance fee limits.'
  if (/debit limit|debit limits and minimum transfer size/i.test(message))
    return 'The transfer exceeds the configured automatic rebalance spending limits.'
  if (/confirmation required|matching transfer confirmation/i.test(message))
    return 'Review the transfer and confirm it before sending.'
  if (/receiving fee allowance must/i.test(message))
    return 'Enter a receiving fee allowance of zero or a positive whole number of sats.'
  if (/whole.*sats|whole-satoshi|amount must|invalid amount/i.test(message))
    return 'Enter a positive whole-satoshi amount.'
  return fallback
}

export const transferSummary = (t: RebalanceTransfer) => ({
  id: t.id,
  poolId: t.poolId,
  origin: t.origin,
  kind: t.deposit.kind,
  state: t.state,
  netSats: t.netSats,
  debitSats: t.debitSats,
  feeSats: t.feeSats,
  ...(whole(t.receivingFeeAllowanceSats) ? { receivingFeeAllowanceSats: t.receivingFeeAllowanceSats } : {}),
  expiresAt: t.expiresAt,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  creditedSats: t.creditedSats,
  ...(whole(t.chargedAt) ? { chargedAt: t.chargedAt } : {}),
  ...(txid(t.fundingTxid) ? { fundingTxid: t.fundingTxid } : {}),
  inputs: (t.inputs ?? [])
    .filter((input) => txid(input.txid) && whole(input.vout))
    .map(({ txid, vout }) => ({ txid, vout })),
  deposit: {
    kind: t.deposit.kind,
    ...(whole(t.deposit.amountSats) ? { amountSats: t.deposit.amountSats } : {}),
    ...(whole(t.deposit.netSats) ? { netSats: t.deposit.netSats } : {}),
    ...(whole(t.deposit.feeSats) ? { feeSats: t.deposit.feeSats } : {}),
    ...(t.deposit.kind === 'onchain' && address(t.deposit.destination) ? { destination: t.deposit.destination } : {}),
  },
  error: t.error
    ? refusalMessage(t.error, 'The transfer needs checking. Review its status before trying again.')
    : undefined,
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
              ? ['poolId', 'amount', 'requestKey', 'kind', 'receivingFeeAllowanceSats']
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
          let receivingFeeAllowanceSats: number | undefined
          if (b.receivingFeeAllowanceSats !== undefined) {
            if (
              typeof b.receivingFeeAllowanceSats !== 'string' ||
              !/^(0|[1-9][0-9]*)$/.test(b.receivingFeeAllowanceSats) ||
              !Number.isSafeInteger(Number(b.receivingFeeAllowanceSats))
            )
              throw new Error('receiving fee allowance must be nonnegative whole safe sats')
            receivingFeeAllowanceSats = Number(b.receivingFeeAllowanceSats)
          }
          const quoteParams = {
            poolId: b.poolId,
            amountSats: parseWholeSats(b.amount),
            requestKey: b.requestKey,
            kind: b.kind as 'onchain' | 'lightning' | undefined,
            ...(receivingFeeAllowanceSats === undefined ? {} : { receivingFeeAllowanceSats }),
          }
          params = JSON.stringify({
            poolId: quoteParams.poolId,
            amountSats: quoteParams.amountSats,
            kind: quoteParams.kind,
            ...(receivingFeeAllowanceSats === undefined ? {} : { receivingFeeAllowanceSats }),
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
      } catch (error) {
        const message = refusalMessage(
          error,
          action === 'quote'
            ? 'A transfer quote could not be prepared. No transfer was sent. Refresh and try again.'
            : 'The operation could not be completed. Check the transfer status before trying again.',
        )
        await deps.services.adminStore.recordAction({
          action: `rebalance-${action}`,
          target,
          params,
          outcome: 'error',
          detail: message,
        })
        return c.json(
          {
            error: 'rebalance_failed',
            message,
          },
          400,
        )
      }
    })
  }
}
