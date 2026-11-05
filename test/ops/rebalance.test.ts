import { describe, expect, it, vi } from 'vitest'
import { RebalanceService, type RebalanceSource } from '../../packages/solver-app/src/ops/rebalance.js'
import { RebalanceStore, parseTransferCursor } from '../../packages/solver-app/src/ops/rebalanceStore.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import type { BalanceCheckpoint } from '../../packages/solver-app/src/ops/balanceCheckpoints.js'
import type {
  RebalancePolicy,
  RebalancePool,
  RebalanceDeposit,
  RebalanceTransfer,
} from '@arkade-os/solver-core/ports/rebalance.js'

const policy: RebalancePolicy = {
  enabled: true,
  reserveSats: 1000,
  maxDebitSats: 10000,
  dailyDebitSats: 30000,
  maxFeeSats: 1000,
  maxFeeBps: 1000,
  minTransferSats: 100,
  cooldownSeconds: 300,
  targets: { 'rail:onchain': { minimumSats: 1000, targetSats: 5000 } },
}

const setup = async () => {
  const driver = betterSqliteDriver(':memory:')
  const store = await RebalanceStore.open(driver)
  let now = 1000
  let balance = 0
  let sourceInputsVisible = true
  let checkpoint: BalanceCheckpoint | undefined
  const submit = vi.fn(async () => 'ab'.repeat(32))
  const release = vi.fn()
  const pinRelease = vi.fn()
  const postNotice = vi.fn<(text: string) => void>()
  const pool: RebalancePool = {
    id: 'rail:onchain',
    label: 'onchain',
    kinds: ['onchain'],
    readBalance: async () => balance,
    prepare: async (kind, netSats) => ({ kind, destination: 'receive', amountSats: netSats, netSats, feeSats: 0 }),
    receipt: async () => ({ state: balance >= 5000 ? 'credited' : 'pending', netSats: balance }),
  }
  const deps = {
    store,
    backend: { pools: async () => [pool] },
    policy,
    savePolicy: vi.fn(async () => {}),
    now: () => now,
    overlapCheckpoint: vi.fn(async () => checkpoint),
    postNotice,
    source: {
      quote: vi.fn(async (deposit: RebalanceDeposit) => ({
        debitSats: deposit.netSats + 10,
        feeSats: 10,
        inputs: [{ txid: '01'.repeat(32), vout: 0, value: 20000 }],
        expiresAt: now + 60,
      })),
      reserve: vi.fn(async () => release),
      pinPendingInputs: vi.fn(() => pinRelease),
      inputsAbsent: vi.fn(async (rows: readonly RebalanceTransfer[]) =>
        sourceInputsVisible ? new Set<string>() : new Set(rows.map((row) => row.id)),
      ),
      submit,
      reconcile: vi.fn<RebalanceSource['reconcile']>(async () => ({ state: 'unknown' })),
    },
  }
  const service = await RebalanceService.create(deps)
  return {
    service,
    deps,
    driver,
    store,
    submit,
    release,
    pinRelease,
    postNotice,
    pool,
    advance: () => {
      now += 400
    },
    observeDebit: (id: string) => {
      checkpoint = {
        id: 1,
        scope: 'test',
        startedAt: now,
        finishedAt: now,
        arkade: { totalSats: '1000', assets: {} },
        lightningSats: null,
        onchain: null,
        totalSats: '1000',
        errors: {},
        previousId: null,
        decreases: [],
        rebalance: {
          accountingVersion: 2,
          comparisonTotalSats: '6010',
          feeAllowanceUsedSats: '0',
          seenIds: [id],
          pending: [{ id, chargedAt: now, debitObserved: true, observedDebitSats: '5010', remainingSats: '5010' }],
        },
      }
    },
    deferAttribution: () => {
      if (!checkpoint?.rebalance) throw new Error('checkpoint missing')
      checkpoint.rebalance.attributionDeferred = {
        anchorCheckpointId: checkpoint.id,
        anchorComparisonTotalSats: '6010',
        since: now,
        transferIds: checkpoint.rebalance.pending.map((row) => row.id),
      }
    },
    credit: () => {
      balance = 5000
    },
    clearSourceInputs: () => {
      sourceInputsVisible = false
    },
  }
}

describe('backend rebalancing', () => {
  it('keeps an older active transfer visible beyond the first history page', async () => {
    const f = await setup()
    try {
      const quote = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'page-base' })
      for (let i = 0; i < 100; i++)
        await f.store.create({ ...quote, id: `page-${i}`, requestKey: `page-${i}`, createdAt: i + 1 })
      await f.store.create({
        ...quote,
        id: 'old-active',
        requestKey: 'old-active',
        createdAt: 0,
        state: 'pending',
        chargedAt: 0,
      })
      const overview = await f.service.overview()
      expect(overview.transfers).toHaveLength(101)
      expect(overview.transfers.find((row) => row.id === 'old-active')?.state).toBe('pending')
      expect(overview.transfersNextCursor).not.toBeNull()
      const older = await f.service.transfersPage(20, parseTransferCursor(overview.transfersNextCursor!))
      expect(older.transfers.map((row) => row.id)).toContain('old-active')
    } finally {
      await f.driver.close()
    }
  })
  it('guarded deposit maintenance runs while source automation is disabled and shutdown waits for it', async () => {
    const f = await setup()
    try {
      let protectedDeposits = false
      let finish!: () => void
      const maintain = vi.fn(async () => {
        expect(protectedDeposits).toBe(true)
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      })
      const closeSource = vi.fn(async () => {})
      const service = await RebalanceService.create({
        ...f.deps,
        policy: { ...policy, enabled: false },
        source: { ...f.deps.source, close: closeSource },
        backend: {
          ...f.deps.backend,
          protectDeposits: () => {
            protectedDeposits = true
          },
          maintain,
        },
      })
      const ticking = service.tick()
      await vi.waitFor(() => expect(maintain).toHaveBeenCalledTimes(1))
      const closing = service.close()
      expect(closeSource).not.toHaveBeenCalled()
      expect(f.submit).not.toHaveBeenCalled()
      finish()
      await Promise.all([ticking, closing])
      expect(closeSource).toHaveBeenCalledTimes(1)
    } finally {
      await f.driver.close()
    }
  })
  it.each(['offline', 'removed', 'discovery'])(
    'source recovery continues when the destination is %s',
    async (failure) => {
      const f = await setup()
      try {
        f.submit.mockRejectedValueOnce(new Error('timeout'))
        const q = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: failure })
        await f.service.submit(q.id)
        if (failure === 'offline')
          f.pool.receipt = async () => {
            throw new Error('destination offline')
          }
        else if (failure === 'removed') f.deps.backend.pools = async () => []
        else
          f.deps.backend.pools = async () => {
            throw new Error('backend unavailable')
          }
        f.deps.source.reconcile.mockResolvedValue({ state: 'refunded' })
        await f.service.setPolicy({ ...policy, enabled: false })
        f.advance()
        await f.service.tick()
        expect(f.deps.source.reconcile).toHaveBeenCalledTimes(1)
        expect((await f.store.get(q.id))?.state).toBe('refunded')
        expect(f.release).not.toHaveBeenCalled()
        f.clearSourceInputs()
        f.advance()
        await f.service.tick()
        expect(f.release).toHaveBeenCalledTimes(1)
        expect((await f.store.get(q.id))?.updatedAt).toBe(1400)
      } finally {
        await f.driver.close()
      }
    },
  )
  it('leaves source fees inside the receiving allowance instead of making capped deposits impossible', async () => {
    const f = await setup()
    try {
      f.pool.prepare = async (kind, netSats, maxFeeSats) => ({
        kind,
        destination: 'receive',
        amountSats: netSats + maxFeeSats,
        netSats,
        feeSats: maxFeeSats,
      })
      f.deps.source.quote.mockImplementation(async (deposit) => ({
        debitSats: deposit.amountSats + 10,
        feeSats: deposit.amountSats + 10 - deposit.netSats,
        inputs: [{ txid: '01'.repeat(32), vout: 0, value: 20000 }],
        expiresAt: 1060,
      }))
      await f.service.tick()
      const q = (await f.store.list())[0]!
      expect(q.origin).toBe('automatic')
      expect(q.deposit.feeSats).toBe(490)
      expect(q.feeSats).toBe(500)
      expect(q.debitSats).toBe(5500)
    } finally {
      await f.driver.close()
    }
  })

  it('quotes and submits a reviewed manual transfer beyond automatic size, fee, reserve and daily limits', async () => {
    const f = await setup()
    try {
      const previous = await f.service.quote({ poolId: 'rail:onchain', amountSats: 500_490, requestKey: 'previous' })
      await f.store.save({ ...previous, state: 'completed', chargedAt: 900, creditedSats: 500_490 })
      await f.service.setPolicy({
        ...policy,
        enabled: false,
        reserveSats: 10_000_000,
        maxDebitSats: 500_500,
        dailyDebitSats: 2_000_000,
        maxFeeSats: 500,
        maxFeeBps: 20,
        minTransferSats: 3_000_000,
      })
      f.pool.prepare = async (kind, netSats, feeSats) => ({
        kind,
        destination: 'receive',
        amountSats: netSats + feeSats,
        netSats,
        feeSats,
      })
      f.deps.source.quote.mockImplementation(async (deposit) => ({
        debitSats: deposit.amountSats + 14_759,
        feeSats: deposit.feeSats + 14_759,
        inputs: [{ txid: '01'.repeat(32), vout: 0, value: 3_000_000 }],
        expiresAt: 1060,
      }))
      const q = await f.service.quote({ poolId: 'rail:onchain', amountSats: 2_000_000, requestKey: 'manual-large' })
      expect(q).toMatchObject({
        origin: 'manual',
        receivingFeeAllowanceSats: 1000,
        debitSats: 2_015_759,
        feeSats: 15_759,
        deposit: { feeSats: 1000 },
      })
      expect(f.submit).not.toHaveBeenCalled()
      expect(f.deps.source.quote).toHaveBeenLastCalledWith(
        q.deposit,
        expect.objectContaining({ reserveSats: 10_000_000 }),
        'manual',
      )
      expect((await f.service.submit(q.id)).state).toBe('pending')
      expect(f.submit).toHaveBeenCalledTimes(1)
      expect(await f.store.rollingDebit(1000)).toBe(2_516_259)
    } finally {
      await f.driver.close()
    }
  })

  it('keeps automatic quotes capped when their source fees exceed policy', async () => {
    const f = await setup()
    try {
      await f.service.setPolicy({ ...policy, maxFeeSats: 500, maxFeeBps: 20 })
      f.deps.source.quote.mockImplementation(async (deposit) => ({
        debitSats: deposit.netSats + 14_759,
        feeSats: 14_759,
        inputs: [],
        expiresAt: 1060,
      }))
      await f.service.tick()
      expect(f.submit).not.toHaveBeenCalled()
      expect(await f.store.list()).toEqual([])
      expect((await f.service.overview()).lastEvaluation?.reason).toContain('fees exceed')
    } finally {
      await f.driver.close()
    }
  })

  it('lets manual receiving fees be reviewed independently and binds request-key reuse to that allowance', async () => {
    const f = await setup()
    try {
      await f.service.setPolicy({
        ...policy,
        enabled: false,
        maxDebitSats: 0,
        dailyDebitSats: 0,
        maxFeeSats: 0,
        maxFeeBps: 0,
        minTransferSats: 10_000,
      })
      f.pool.prepare = async (kind, netSats, feeSats) => ({
        kind,
        destination: 'receive',
        amountSats: netSats + feeSats,
        netSats,
        feeSats,
      })
      f.deps.source.quote.mockImplementation(async (deposit) => ({
        debitSats: deposit.amountSats + 10,
        feeSats: deposit.feeSats + 10,
        inputs: [],
        expiresAt: 1060,
      }))
      const q = await f.service.quote({
        poolId: 'rail:onchain',
        amountSats: 100,
        receivingFeeAllowanceSats: 30,
        requestKey: 'manual-budget',
      })
      expect(q).toMatchObject({ receivingFeeAllowanceSats: 30, debitSats: 140, feeSats: 40, deposit: { feeSats: 30 } })
      await expect(
        f.service.quote({
          poolId: 'rail:onchain',
          amountSats: 100,
          receivingFeeAllowanceSats: 20,
          requestKey: 'manual-budget',
        }),
      ).rejects.toThrow(/request key/)
      await expect(
        f.service.quote({
          poolId: 'rail:onchain',
          amountSats: 100,
          receivingFeeAllowanceSats: -1,
          requestKey: 'bad-budget',
        }),
      ).rejects.toThrow(/receiving fee allowance/)
      f.pool.prepare = async (kind, netSats, feeSats) => ({
        kind,
        destination: 'receive',
        amountSats: netSats + feeSats + 1,
        netSats,
        feeSats: feeSats + 1,
      })
      await expect(
        f.service.quote({
          poolId: 'rail:onchain',
          amountSats: 100,
          receivingFeeAllowanceSats: 30,
          requestKey: 'excess-budget',
        }),
      ).rejects.toThrow(/deposit fee allowance/)
    } finally {
      await f.driver.close()
    }
  })

  it('failed automatic previews persist cooldown without charging a debit', async () => {
    const f = await setup()
    try {
      f.deps.source.quote.mockRejectedValue(new Error('route unavailable'))
      await f.service.tick()
      const calls = f.deps.source.quote.mock.calls.length
      expect(await f.store.lastAttempt()).toBe(1000)
      expect(await f.store.rollingDebit(1000)).toBe(0)
      await f.service.tick()
      expect(f.deps.source.quote).toHaveBeenCalledTimes(calls)
      expect((await f.service.overview()).lastEvaluation).toMatchObject({
        reason: expect.stringContaining('Cooling down after a failed attempt'),
        nextEligibleAt: 1300,
      })
    } finally {
      await f.driver.close()
    }
  })

  it('explains when the backend is above its trigger or its balance cannot be read', async () => {
    const f = await setup()
    try {
      f.credit()
      await f.service.tick()
      expect((await f.service.overview()).lastEvaluation?.reason).toContain('above their refill triggers')
      f.pool.readBalance = async () => {
        throw new Error('backend offline')
      }
      await f.service.tick()
      expect((await f.service.overview()).lastEvaluation?.reason).toContain('could not be read')
      expect(f.submit).not.toHaveBeenCalled()
    } finally {
      await f.driver.close()
    }
  })

  it('explains when a low backend needs less than the minimum transfer', async () => {
    const f = await setup()
    try {
      await f.service.setPolicy({ ...policy, minTransferSats: 6000 })
      await f.service.tick()
      expect((await f.service.overview()).lastEvaluation?.reason).toContain(
        'below the configured minimum transfer size',
      )
      expect(f.submit).not.toHaveBeenCalled()
    } finally {
      await f.driver.close()
    }
  })

  it('notifies once for a failed automatic quote and does not expose the raw error', async () => {
    const f = await setup()
    try {
      f.deps.source.quote.mockRejectedValue(new Error('rebalance fees exceed policy limits; private invoice text'))
      await f.service.tick()
      expect(f.postNotice).toHaveBeenCalledTimes(1)
      expect(f.postNotice.mock.calls[0]?.[0]).toContain('quoted fees exceed the policy limit')
      expect(f.postNotice.mock.calls[0]?.[0]).toContain('No funds were sent')
      expect(f.postNotice.mock.calls[0]?.[0]).not.toContain('private invoice text')
      expect((await f.service.overview()).lastEvaluation?.reason).not.toContain('private invoice text')
      await f.service.tick()
      expect(f.postNotice).toHaveBeenCalledTimes(1)
      f.advance()
      await f.service.tick()
      expect(f.postNotice).toHaveBeenCalledTimes(2)
    } finally {
      await f.driver.close()
    }
  })

  it('reports no source submission when an automatic quote cannot reserve inputs', async () => {
    const f = await setup()
    try {
      f.deps.source.reserve.mockRejectedValueOnce(new Error('reserve floor; private invoice text'))
      await f.service.tick()
      expect((await f.store.list())[0]?.state).toBe('quoted')
      expect(f.submit).not.toHaveBeenCalled()
      expect(f.postNotice.mock.calls[0]?.[0]).toContain('could not start')
      expect(f.postNotice.mock.calls[0]?.[0]).toContain('No funds were sent')
      expect(f.postNotice.mock.calls[0]?.[0]).not.toContain('private invoice text')
      expect((await f.service.overview()).lastEvaluation?.reason).toContain('reserve')
      expect((await f.service.overview()).lastEvaluation?.reason).not.toContain('private invoice text')
    } finally {
      await f.driver.close()
    }
  })

  it('keeps a large cooldown from breaking failure notices or status', async () => {
    const f = await setup()
    try {
      await f.service.setPolicy({ ...policy, cooldownSeconds: Number.MAX_SAFE_INTEGER })
      f.deps.source.quote.mockRejectedValue(new Error('rebalance fees exceed policy limits'))
      await f.service.tick()
      expect(f.postNotice).toHaveBeenCalledTimes(1)
      await f.service.tick()
      expect((await f.service.overview()).lastEvaluation?.reason).toContain('Cooling down after a failed attempt')
      expect((await f.service.overview()).lastEvaluation).not.toHaveProperty('nextEligibleAt')
    } finally {
      await f.driver.close()
    }
  })

  it('reports a submitted rebalance and its destination credit without repeating pending notices', async () => {
    const f = await setup()
    try {
      f.deps.source.reconcile.mockResolvedValue({ state: 'submitted', fundingTxid: 'ab'.repeat(32) })
      await f.service.tick()
      expect((await f.store.active())[0]?.state).toBe('pending')
      expect(f.postNotice).toHaveBeenCalledTimes(2)
      expect(f.postNotice.mock.calls[0]?.[0]).toContain('Rebalance starting')
      expect(f.postNotice.mock.calls[1]?.[0]).toContain('Rebalance submitted')
      expect(f.postNotice.mock.calls[1]?.[0]).toContain(`Bitcoin transaction: ${'ab'.repeat(32)}`)
      expect(f.postNotice.mock.calls[1]?.[0]).toContain('Waiting for at least 5,000 sats')
      await f.service.tick()
      expect(f.postNotice).toHaveBeenCalledTimes(2)
      f.credit()
      await f.service.tick()
      expect((await f.store.list())[0]?.state).toBe('completed')
      expect(f.postNotice).toHaveBeenCalledTimes(3)
      expect(f.postNotice.mock.calls[2]?.[0]).toContain('5,000 sats are now spendable')
      await f.service.tick()
      expect(f.postNotice).toHaveBeenCalledTimes(3)
    } finally {
      await f.driver.close()
    }
  })

  it('labels Lightning funding correctly in the submitted notice', async () => {
    const f = await setup()
    try {
      f.deps.backend.pools = async () => [{ ...f.pool, id: 'rail:lightning', kinds: ['lightning'] }]
      const q = await f.service.quote({ poolId: 'rail:lightning', amountSats: 5000, requestKey: 'lightning-notice' })
      await f.service.submit(q.id)
      expect(f.postNotice.mock.calls[1]?.[0]).toContain(`Arkade funding transaction: ${'ab'.repeat(32)}`)
    } finally {
      await f.driver.close()
    }
  })

  it('notifies that submission started before the source call resolves', async () => {
    const f = await setup()
    try {
      let finish!: (txid: string) => void
      f.submit.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve
          }),
      )
      const q = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'slow-send' })
      const sending = f.service.submit(q.id)
      await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
      expect((await f.store.get(q.id))?.state).toBe('submitting')
      expect(f.postNotice).toHaveBeenCalledTimes(1)
      expect(f.postNotice.mock.calls[0]?.[0]).toContain('Rebalance starting')
      expect(f.postNotice.mock.calls[0]?.[0]).not.toContain('payment submitted')
      finish('ab'.repeat(32))
      expect((await sending).state).toBe('pending')
      expect(f.postNotice.mock.calls[1]?.[0]).toContain('Rebalance submitted')
    } finally {
      await f.driver.close()
    }
  })

  it('warns on uncertain sends, then reports reconciliation and refunds once', async () => {
    const f = await setup()
    try {
      f.submit.mockRejectedValueOnce(new Error('timeout after acceptance'))
      const q = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'notices' })
      await f.service.submit(q.id)
      expect((await f.store.get(q.id))?.state).toBe('needs_reconciliation')
      expect(f.postNotice.mock.calls[0]?.[0]).toContain('Rebalance starting')
      expect(f.postNotice.mock.calls[1]?.[0]).toContain('Rebalance needs checking')
      f.deps.source.reconcile.mockResolvedValueOnce({ state: 'submitted', fundingTxid: 'ab'.repeat(32) })
      await f.service.tick()
      expect(f.postNotice.mock.calls[2]?.[0]).toContain('Rebalance found')
      f.deps.source.reconcile.mockResolvedValue({ state: 'refunded' })
      await f.service.tick()
      expect((await f.store.get(q.id))?.state).toBe('refunded')
      expect(f.postNotice.mock.calls[3]?.[0]).toContain('Rebalance refunded')
      await f.service.tick()
      expect(f.postNotice).toHaveBeenCalledTimes(4)
    } finally {
      await f.driver.close()
    }
  })

  it('cannot turn a successful submission into an uncertain transfer when a notifier throws', async () => {
    const f = await setup()
    try {
      f.postNotice.mockImplementation(() => {
        throw new Error('notification unavailable')
      })
      const q = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'sink' })
      expect((await f.service.submit(q.id)).state).toBe('pending')
      expect((await f.store.get(q.id))?.state).toBe('pending')
    } finally {
      await f.driver.close()
    }
  })
  it('status and quote never spend, and duplicate submissions pay once', async () => {
    const f = await setup()
    try {
      await f.service.overview()
      const quoted = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'request-1' })
      expect(f.submit).not.toHaveBeenCalled()
      const [a, b] = await Promise.all([f.service.submit(quoted.id), f.service.submit(quoted.id)])
      expect(a.fundingTxid).toBe(b.fundingTxid)
      expect(f.submit).toHaveBeenCalledTimes(1)
      expect(f.release).toHaveBeenCalledTimes(1)
    } finally {
      await f.driver.close()
    }
  })

  it('a timeout retains the source hold and restart reconciles instead of resending', async () => {
    const f = await setup()
    try {
      f.submit.mockRejectedValueOnce(new Error('timeout after acceptance'))
      const q = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'request-2' })
      const result = await f.service.submit(q.id)
      expect(result.state).toBe('needs_reconciliation')
      expect(f.release).not.toHaveBeenCalled()
      await RebalanceService.create(f.deps)
      await f.service.tick()
      expect(f.submit).toHaveBeenCalledTimes(1)
      expect((await f.store.get(q.id))?.state).toBe('needs_reconciliation')
    } finally {
      await f.driver.close()
    }
  })

  it('automatic refills count pending transfers and observe credit before completing', async () => {
    const f = await setup()
    try {
      await f.service.tick()
      f.advance()
      await f.service.tick()
      expect(f.submit).toHaveBeenCalledTimes(1)
      expect((await f.store.active())[0]?.state).toBe('pending')
      f.credit()
      await f.service.tick()
      expect((await f.store.list())[0]?.state).toBe('completed')
      expect(f.submit).toHaveBeenCalledTimes(1)
    } finally {
      await f.driver.close()
    }
  })

  it('disabling automation still tracks submitted receipts', async () => {
    const f = await setup()
    try {
      await f.service.tick()
      await f.service.setPolicy({ ...policy, enabled: false })
      f.credit()
      await f.service.tick()
      expect((await f.store.list())[0]?.state).toBe('completed')
    } finally {
      await f.driver.close()
    }
  })

  it('rejects reused request keys with a different body while manual quotes survive automatic policy changes', async () => {
    const f = await setup()
    try {
      const q = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'request-3' })
      await expect(
        f.service.quote({ poolId: 'rail:onchain', amountSats: 4000, requestKey: 'request-3' }),
      ).rejects.toThrow(/request key/)
      await f.service.setPolicy({ ...policy, reserveSats: 2000 })
      expect((await f.service.submit(q.id)).state).toBe('pending')
      expect(f.submit).toHaveBeenCalledTimes(1)
    } finally {
      await f.driver.close()
    }
  })

  it('still invalidates automatic quotes when policy changes', async () => {
    const f = await setup()
    try {
      const q = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'automatic-stale' })
      await f.store.save({ ...q, origin: 'automatic' })
      await f.service.setPolicy({ ...policy, reserveSats: 2000 })
      await expect(f.service.submit(q.id)).rejects.toThrow(/policy/)
      expect(f.submit).not.toHaveBeenCalled()
    } finally {
      await f.driver.close()
    }
  })

  it('refuses a second source transfer while one is in flight', async () => {
    const f = await setup()
    try {
      const a = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'a' })
      const b = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'b' })
      await f.service.submit(a.id)
      await expect(f.service.submit(b.id)).rejects.toThrow(/Another transfer/)
      expect(f.submit).toHaveBeenCalledTimes(1)
    } finally {
      await f.driver.close()
    }
  })

  it('requires an observed debit and exact manual confirmation before one overlapping send', async () => {
    const f = await setup()
    try {
      const first = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'first' })
      await f.service.submit(first.id)
      const second = { poolId: 'rail:onchain', amountSats: 5000, requestKey: 'second', overridePendingIds: [first.id] }
      await expect(f.service.quote(second)).rejects.toThrow(/balance checkpoint/)
      expect(f.deps.source.quote).toHaveBeenCalledTimes(1)
      f.observeDebit(first.id)
      f.advance()
      await expect(f.service.quote(second)).rejects.toThrow(/fresh balance checkpoint/)
      f.observeDebit(first.id)
      await expect(f.service.quote({ ...second, overridePendingIds: ['other'] })).rejects.toThrow(
        /pending transfer changed/,
      )
      const quote = await f.service.quote(second)
      expect(quote.overridePendingIds).toEqual([first.id])
      await expect(f.service.submit(quote.id)).rejects.toThrow(/override changed/)
      expect((await f.store.get(quote.id))?.state).toBe('quoted')
      expect((await f.service.submit(quote.id, [first.id])).state).toBe('pending')
      expect(f.submit).toHaveBeenCalledTimes(2)
      expect(f.deps.source.pinPendingInputs).toHaveBeenCalledTimes(2)
      expect(f.postNotice.mock.calls.at(-2)?.[0]).toContain('BTC loss and recovery notices will wait')
      await expect(
        f.service.quote({
          poolId: 'rail:onchain',
          amountSats: 5000,
          requestKey: 'third',
          overridePendingIds: [first.id],
        }),
      ).rejects.toThrow(/pending transfer changed/)
    } finally {
      await f.driver.close()
    }
  })

  it('rejects stale override approval and pauses new quotes during deferred attribution', async () => {
    const f = await setup()
    try {
      const first = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'first' })
      await f.service.submit(first.id)
      f.observeDebit(first.id)
      const second = await f.service.quote({
        poolId: 'rail:onchain',
        amountSats: 5000,
        requestKey: 'second',
        overridePendingIds: [first.id],
      })
      await f.store.save({ ...(await f.store.get(first.id))!, state: 'completed', creditedSats: 5000 })
      await expect(f.service.submit(second.id, [first.id])).rejects.toThrow(/overridden has changed/)
      f.deferAttribution()
      await expect(f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'later' })).rejects.toThrow(
        /Balance attribution/,
      )
    } finally {
      await f.driver.close()
    }
  })

  it('allows an explicit override of the same pending transfer during deferred attribution', async () => {
    const f = await setup()
    try {
      const first = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'first' })
      await f.service.submit(first.id)
      f.observeDebit(first.id)
      f.deferAttribution()
      await expect(
        f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'unreviewed' }),
      ).rejects.toThrow(/Balance attribution/)
      const quote = await f.service.quote({
        poolId: 'rail:onchain',
        amountSats: 5000,
        requestKey: 'reviewed',
        overridePendingIds: [first.id],
      })
      expect(quote.overridePendingIds).toEqual([first.id])
      expect((await f.service.submit(quote.id, [first.id])).state).toBe('pending')
      expect(f.submit).toHaveBeenCalledTimes(2)
      expect(f.deps.source.pinPendingInputs).toHaveBeenCalledTimes(2)
    } finally {
      await f.driver.close()
    }
  })

  it('keeps a passive process from overriding without the provider input pins', async () => {
    const f = await setup()
    try {
      const first = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'first' })
      await f.service.submit(first.id)
      f.observeDebit(first.id)
      const passive = await RebalanceService.create(f.deps, 'passive')
      await expect(
        passive.quote({
          poolId: 'rail:onchain',
          amountSats: 5000,
          requestKey: 'second',
          overridePendingIds: [first.id],
        }),
      ).rejects.toThrow(/needs reconciliation/)
      expect(f.submit).toHaveBeenCalledTimes(1)
    } finally {
      await f.driver.close()
    }
  })

  it('retains terminal source pins through immediate credit until a later wallet read proves inputs gone', async () => {
    const f = await setup()
    try {
      const quote = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'fast-credit' })
      await f.service.submit(quote.id)
      f.credit()
      f.advance()
      await f.service.tick()
      expect((await f.store.get(quote.id))?.state).toBe('completed')
      expect((await f.store.get(quote.id))?.sourceInputsClearedAt).toBeUndefined()
      expect(f.pinRelease).not.toHaveBeenCalled()
      expect((await f.store.protectedTerminalInputs()).map((row) => row.id)).toEqual([quote.id])
      f.deps.source.inputsAbsent.mockRejectedValueOnce(new Error('wallet unavailable'))
      await f.service.tick()
      expect(f.pinRelease).not.toHaveBeenCalled()
      f.clearSourceInputs()
      f.advance()
      await f.service.tick()
      expect((await f.store.get(quote.id))?.sourceInputsClearedAt).toBe(1800)
      expect((await f.store.get(quote.id))?.updatedAt).toBe(1400)
      expect(f.pinRelease).toHaveBeenCalledTimes(1)
      expect(await f.store.protectedTerminalInputs()).toEqual([])
    } finally {
      await f.driver.close()
    }
  })

  it('source reserve refusal cannot enter submission or charge the daily budget', async () => {
    const f = await setup()
    try {
      f.deps.source.reserve.mockRejectedValueOnce(new Error('reserve floor'))
      const q = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'reserve' })
      await expect(f.service.submit(q.id)).rejects.toThrow(/reserve/)
      expect((await f.store.get(q.id))?.state).toBe('quoted')
      expect(await f.store.rollingDebit(1000)).toBe(0)
    } finally {
      await f.driver.close()
    }
  })
})

describe('only the live daemon recovers rebalance state — a one-shot build is passive', () => {
  const submittingRow = (): RebalanceTransfer => ({
    id: 'rb-1',
    requestKey: 'k1',
    origin: 'automatic',
    poolId: 'rail:onchain',
    netSats: 5000,
    debitSats: 5010,
    feeSats: 10,
    policyRevision: 'rev',
    createdAt: 1000,
    updatedAt: 1000,
    expiresAt: 2000,
    state: 'submitting',
    deposit: { kind: 'onchain', destination: 'receive', amountSats: 5000, netSats: 5000, feeSats: 0 },
    inputs: [],
  })

  it('a passive build neither reconciles a submitting row nor reserves its coins, but still protects deposits', async () => {
    const f = await setup()
    try {
      await f.store.create(submittingRow())
      f.deps.source.reserve.mockClear()
      const protectDeposits = vi.fn()
      await RebalanceService.create({ ...f.deps, backend: { ...f.deps.backend, protectDeposits } }, 'passive')
      expect((await f.store.get('rb-1'))?.state).toBe('submitting')
      expect(f.deps.source.reserve).not.toHaveBeenCalled()
      expect(protectDeposits).toHaveBeenCalledOnce()
      expect(f.postNotice).not.toHaveBeenCalled()
    } finally {
      await f.driver.close()
    }
  })

  it('the active build reconciles the submitting row and re-reserves its coins', async () => {
    const f = await setup()
    try {
      await f.store.create(submittingRow())
      f.deps.source.reserve.mockClear()
      await RebalanceService.create(f.deps, 'active')
      expect((await f.store.get('rb-1'))?.state).toBe('needs_reconciliation')
      expect(f.deps.source.reserve).toHaveBeenCalledTimes(1)
      expect(f.postNotice.mock.calls[0]?.[0]).toContain('Rebalance needs checking')
    } finally {
      await f.driver.close()
    }
  })

  it('restores only the source input pins for a known pending spend', async () => {
    const f = await setup()
    try {
      const pending = {
        ...submittingRow(),
        state: 'pending' as const,
        chargedAt: 1000,
        fundingTxid: 'ab'.repeat(32),
        inputs: [{ txid: '01'.repeat(32), vout: 0, value: 5010 }],
      }
      await f.store.create(pending)
      f.deps.source.reserve.mockClear()
      f.deps.source.pinPendingInputs.mockClear()
      const recovered = await RebalanceService.create(f.deps)
      expect(f.deps.source.pinPendingInputs).toHaveBeenCalledWith(pending)
      expect(f.deps.source.reserve).not.toHaveBeenCalled()
      await recovered.close()
    } finally {
      await f.driver.close()
    }
  })

  it('restores a completed transfer pin before new quotes when the source index still lists its inputs', async () => {
    const f = await setup()
    try {
      const completed = {
        ...submittingRow(),
        state: 'completed' as const,
        chargedAt: 1000,
        fundingTxid: 'ab'.repeat(32),
        creditedSats: 5000,
        inputs: [{ txid: '01'.repeat(32), vout: 0, value: 5010 }],
      }
      await f.store.create(completed)
      f.deps.policy = { ...policy, enabled: false }
      f.deps.source.pinPendingInputs.mockClear()
      f.deps.source.reserve.mockClear()
      const protectedRows = vi.spyOn(f.store, 'protectedTerminalInputs')
      const recovered = await RebalanceService.create(f.deps)
      expect(f.deps.source.pinPendingInputs).toHaveBeenCalledWith(completed)
      expect(f.deps.source.reserve).not.toHaveBeenCalled()
      expect(protectedRows).toHaveBeenCalledTimes(1)
      await recovered.tick()
      expect((await f.store.get(completed.id))?.sourceInputsClearedAt).toBeUndefined()
      f.clearSourceInputs()
      await recovered.tick()
      expect((await f.store.get(completed.id))?.sourceInputsClearedAt).toBe(1000)
      expect(f.pinRelease).toHaveBeenCalledTimes(1)
      expect(protectedRows).toHaveBeenCalledTimes(1)
    } finally {
      await f.driver.close()
    }
  })
})
