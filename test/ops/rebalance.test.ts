import { describe, expect, it, vi } from 'vitest'
import { RebalanceService, type RebalanceSource } from '../../packages/solver-app/src/ops/rebalance.js'
import { RebalanceStore } from '../../packages/solver-app/src/ops/rebalanceStore.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
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
  const submit = vi.fn(async () => 'ab'.repeat(32))
  const release = vi.fn()
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
    source: {
      quote: vi.fn(async (deposit: RebalanceDeposit) => ({
        debitSats: deposit.netSats + 10,
        feeSats: 10,
        inputs: [{ txid: '01'.repeat(32), vout: 0, value: 20000 }],
        expiresAt: now + 60,
      })),
      reserve: vi.fn(async () => release),
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
    pool,
    advance: () => {
      now += 400
    },
    credit: () => {
      balance = 5000
    },
  }
}

describe('backend rebalancing', () => {
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
        await f.service.tick()
        expect(f.deps.source.reconcile).toHaveBeenCalledTimes(1)
        expect((await f.store.get(q.id))?.state).toBe('refunded')
        expect(f.release).toHaveBeenCalledTimes(1)
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
      const q = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'capped' })
      expect(q.deposit.feeSats).toBe(490)
      expect(q.feeSats).toBe(500)
      expect(q.debitSats).toBe(5500)
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

  it('rejects reused request keys with a different body and stale policy quotes', async () => {
    const f = await setup()
    try {
      const q = await f.service.quote({ poolId: 'rail:onchain', amountSats: 5000, requestKey: 'request-3' })
      await expect(
        f.service.quote({ poolId: 'rail:onchain', amountSats: 4000, requestKey: 'request-3' }),
      ).rejects.toThrow(/request key/)
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
      await expect(f.service.submit(b.id)).rejects.toThrow(/active/)
      expect(f.submit).toHaveBeenCalledTimes(1)
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
    } finally {
      await f.driver.close()
    }
  })
})
