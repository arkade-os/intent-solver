import { describe, expect, it } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { balanceCheckpointScope, type BalanceCheckpoint } from '@arkade-os/solver-app/ops/balanceCheckpoints.js'
import { economicsOf } from '@arkade-os/solver-core/analytics/economics.js'

const NOW = 10_000
const scopeFor = (services: { config: unknown; ln: unknown; onchain: unknown; providerPubkey: string }) =>
  balanceCheckpointScope(services as never)

const checkpoint = (
  scope: string,
  startedAt: number,
  totalSats: string | null,
  over: Partial<BalanceCheckpoint> = {},
): Omit<BalanceCheckpoint, 'id'> => ({
  scope,
  startedAt,
  finishedAt: startedAt + 1,
  arkade: totalSats === null ? null : { totalSats, assets: {} },
  lightningSats: '0',
  onchain: null,
  totalSats,
  errors: totalSats === null ? { arkade: 'wallet read failed' } : {},
  previousId: null,
  decreases: [],
  ...over,
})

const build = async (path = '/api/reconciliation?window=1h') => {
  let clock = NOW - 2_000
  const adminStore = await AdminStore.open(':memory:', () => clock)
  const services = {
    adminStore,
    config: { network: 'regtest', arkade: { operatorUrl: 'http://arkade.test' }, lnBackend: 'test' },
    providerPubkey: 'provider',
    ln: {},
    onchain: null,
    readers: [
      {
        descriptor: { pair: 'arkade:BTC->lightning:BTC' },
        economics: async () => ({
          truncated: false,
          records: [
            economicsOf({
              id: 'send-1',
              corridor: 'arkade:BTC->lightning:BTC',
              state: 'claimed',
              phase: 'done',
              quotedAt: NOW - 2_000,
              settledAt: NOW - 1_000,
              inbound: { assetId: null, amount: '1000', decimals: 0 },
              outbound: { assetId: null, amount: '900', decimals: 0 },
              quotedCostSats: 50,
              realizedCostSats: 30,
            }),
          ],
        }),
      },
    ],
  } as never
  const scope = scopeFor(services as never)
  await adminStore.recordBalanceCheckpoint(checkpoint(scope, NOW - 1_500, '10000'))
  await adminStore.recordBalanceCheckpoint(checkpoint(scope, NOW - 1_300, '10500'))
  await adminStore.recordBalanceCheckpoint(checkpoint(scope, NOW - 900, '10400'))
  await adminStore.recordBalanceCheckpoint(
    checkpoint(scope, NOW - 500, null, { errors: { lightning: 'node unavailable' } }),
  )
  await adminStore.recordBalanceCheckpoint(checkpoint(scope, NOW - 400, '10450'))

  clock = NOW - 1_100
  await adminStore.createOperatorWithdrawal({
    id: 'withdrawal-1',
    scope,
    source: 'arkade',
    address: 'bc1destination',
    amountSats: 200,
  })
  await adminStore.transitionOperatorWithdrawal('withdrawal-1', 'preparing', 'sending')
  await adminStore.transitionOperatorWithdrawal('withdrawal-1', 'sending', 'sent', {
    feeSats: 5,
    reference: 'ab'.repeat(32),
  })

  const app = buildAdminApp({ services, startedAt: 1, mode: 'serve', now: () => NOW })
  const response = await app.fetch(new Request(`http://admin${path}`))
  return { response, body: (await response.json()) as Record<string, any>, adminStore }
}

describe('GET /api/reconciliation', () => {
  it('shows balance changes, checkpoint gaps, withdrawals, and per-swap fees in one payload', async () => {
    const { response, body, adminStore } = await build()
    expect(response.status).toBe(200)
    expect(body.balance.changeSats).toBe(450)
    expect(body.balance.windowCount).toBe(5)
    expect(body.balance.incompleteCount).toBe(1)
    expect(body.balance.gaps.length).toBeGreaterThan(0)
    expect(body.balance.incoming).toEqual([expect.objectContaining({ amountSats: 500 })])
    expect(body.withdrawals.sentCount).toBe(1)
    expect(body.withdrawals.debitSats).toBe(205)
    expect(body.swaps.summary.grossSats).toBe(100)
    expect(body.swaps.records[0]).toMatchObject({
      id: 'send-1',
      quotedCostSats: 50,
      realizedCostSats: 30,
      netSats: 70,
    })
    await adminStore.close()
  })

  it('refuses a window nobody defined', async () => {
    const { response, body, adminStore } = await build('/api/reconciliation?window=forever')
    expect(response.status).toBe(400)
    expect(body.error).toBe('bad_request')
    await adminStore.close()
  })
})
