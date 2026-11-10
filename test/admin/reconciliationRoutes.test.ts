import { describe, expect, it, vi } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { AdminStore, type OperatorWithdrawal } from '@arkade-os/solver-app/admin/db.js'
import { balanceCheckpointScope, type BalanceCheckpoint } from '@arkade-os/solver-app/ops/balanceCheckpoints.js'
import { economicsOf } from '@arkade-os/solver-core/analytics/economics.js'
import type { RebalanceTransfer } from '@arkade-os/solver-core/ports/rebalance.js'

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

const build = async (
  path = '/api/reconciliation?window=1h',
  options: {
    failRebalances?: boolean
    checkpointRows?: (scope: string) => BalanceCheckpoint[]
    withdrawals?: (scope: string) => OperatorWithdrawal[]
    rebalances?: RebalanceTransfer[]
    withdrawalSince?: number[]
    rebalanceSince?: number[]
  } = {},
) => {
  let clock = NOW - 2_000
  const adminStore = await AdminStore.open(':memory:', () => clock)
  const services = {
    adminStore,
    config: { network: 'regtest', arkade: { operatorUrl: 'http://arkade.test' }, lnBackend: 'test' },
    providerPubkey: 'provider',
    ln: {},
    onchain: null,
    ...(options.failRebalances
      ? {
          rebalanceStore: {
            checkpointTransfers: async () => {
              throw new Error('journal offline')
            },
          },
        }
      : options.rebalances || options.rebalanceSince
        ? {
            rebalanceStore: {
              checkpointTransfers: async (since: number) => {
                options.rebalanceSince?.push(since)
                return options.rebalances ?? []
              },
            },
          }
        : {}),
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
  if (options.checkpointRows) {
    vi.spyOn(adminStore, 'listBalanceCheckpoints').mockResolvedValue(options.checkpointRows(scope))
  }
  const listWithdrawals = adminStore.listOperatorWithdrawals.bind(adminStore)
  vi.spyOn(adminStore, 'listOperatorWithdrawals').mockImplementation(async (scopeArg, sinceArg) => {
    options.withdrawalSince?.push(sinceArg)
    return options.withdrawals ? options.withdrawals(scopeArg) : listWithdrawals(scopeArg, sinceArg)
  })
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

  it('uses the sent amount as the debit floor when withdrawal fees are unreported', async () => {
    const { response, body, adminStore } = await build(undefined, {
      withdrawals: (scope) => [
        {
          id: 'withdrawal-without-fee',
          scope,
          source: 'arkade',
          address: 'bc1destination',
          amountSats: 300,
          feeSats: null,
          reference: 'cd'.repeat(32),
          state: 'sent',
          createdAt: NOW - 1_000,
          updatedAt: NOW - 900,
        },
      ],
    })
    expect(response.status).toBe(200)
    expect(body.withdrawals).toMatchObject({
      sentCount: 1,
      amountSats: 300,
      feeSats: 0,
      debitSats: 300,
      unreportedFeeCount: 1,
    })
    expect(body.withdrawals.records[0].debitSats).toBeNull()
    await adminStore.close()
  })

  it('queries journals from the requested window and treats missing rebalance fees as unknown', async () => {
    const withdrawalSince: number[] = []
    const rebalanceSince: number[] = []
    const datedRebalance = (id: string, feeSats: number | null): RebalanceTransfer =>
      ({
        id,
        origin: 'manual',
        poolId: 'pool',
        netSats: 100,
        debitSats: 105,
        feeSats,
        state: 'completed',
        createdAt: NOW - 1_000,
        updatedAt: NOW - 900,
        chargedAt: NOW - 950,
        deposit: { kind: 'lightning' },
        inputs: [],
      }) as unknown as RebalanceTransfer

    const { response, body, adminStore } = await build(undefined, {
      withdrawalSince,
      rebalanceSince,
      checkpointRows: (scope) => {
        const rows = Array.from({ length: 2_000 }, (_, index) => {
          const id = index + 1
          return { ...checkpoint(scope, NOW - 2_500 + index, '10000'), id }
        })
        return rows.reverse()
      },
      rebalances: [datedRebalance('costed', 7), datedRebalance('uncosted', null)],
    })

    expect(response.status).toBe(200)
    expect(body.balance.limited).toBe(true)
    expect(withdrawalSince).toEqual([NOW - 3_600])
    expect(rebalanceSince).toEqual([NOW - 3_600])
    expect(body.rebalances).toMatchObject({ completedCount: 2, feeSats: 7 })
    await adminStore.close()
  })

  it('uses the last checkpoint before the window as the opening baseline', async () => {
    const { response, body, adminStore } = await build(undefined, {
      checkpointRows: (scope) =>
        [
          checkpoint(scope, NOW - 1_000, '10400'),
          checkpoint(scope, NOW - 3_000, '9500'),
          checkpoint(scope, NOW - 4_000, '9000'),
        ].map((row, index) => ({ ...row, id: index + 1 })),
    })

    expect(response.status).toBe(200)
    expect(body.balance).toMatchObject({
      windowCount: 2,
      observedFrom: NOW - 4_000,
      openingSats: 9000,
      closingSats: 10400,
      changeSats: 1400,
    })
    expect(body.balance.incoming.map((row: { at: number }) => row.at)).toEqual([NOW - 3_000, NOW - 1_000])
    await adminStore.close()
  })

  it('keeps swap economics visible when the rebalance journal cannot be read', async () => {
    const { response, body, adminStore } = await build('/api/reconciliation?window=1h', { failRebalances: true })
    expect(response.status).toBe(200)
    expect(body.swaps.records).toHaveLength(1)
    expect(body.rebalances.error).toBe('journal offline')
    expect(body.coverage.failedSections).toContainEqual({ section: 'rebalances', reason: 'journal offline' })
    await adminStore.close()
  })
})
