import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'
import type { RebalanceTransfer } from '@arkade-os/solver-core/ports/rebalance.js'
import { RebalanceStore } from '../../packages/solver-app/src/ops/rebalanceStore.js'

const transfer = (id: string, overrides: Partial<RebalanceTransfer> = {}): RebalanceTransfer => ({
  id,
  requestKey: `request-${id}`,
  origin: 'manual',
  poolId: 'rail:onchain',
  netSats: 1_000,
  debitSats: 1_010,
  feeSats: 10,
  policyRevision: 'revision-1',
  createdAt: 100,
  updatedAt: 100,
  expiresAt: 500,
  state: 'quoted',
  deposit: { kind: 'onchain', destination: 'destination-1', amountSats: 1_000, netSats: 1_000, feeSats: 0 },
  inputs: [{ txid: 'aa'.repeat(32), vout: 0, value: 2_000 }],
  routeData: { receipt: 'public-recovery-id' },
  ...overrides,
})

describe('rebalance journal', () => {
  let dir: string
  let driver: SqlDriver
  let store: RebalanceStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rebalance-journal-'))
    driver = betterSqliteDriver(join(dir, 'swaps.sqlite'))
    store = await RebalanceStore.open(driver)
  })

  afterEach(async () => {
    await driver.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('reopens complete recovery data and persists amounts as exact decimal strings', async () => {
    const row = transfer('1', { state: 'needs_reconciliation', chargedAt: 110, fundingTxid: 'bb'.repeat(32) })
    await store.create(row)
    const raw = await driver.get<{ data: string }>('SELECT data FROM rebalance_transfer WHERE id = ?', [row.id])
    expect(JSON.parse(raw!.data).netSats).toBe('1000')
    expect(JSON.parse(raw!.data).inputs[0].value).toBe('2000')
    await driver.close()
    driver = betterSqliteDriver(join(dir, 'swaps.sqlite'))
    store = await RebalanceStore.open(driver)
    expect(await store.get(row.id)).toEqual(row)
    expect(await store.byKey(row.requestKey)).toEqual(row)
    expect(await store.active()).toEqual([row])
    expect(await store.lastAttempt()).toBe(110)
  })

  it('refuses request-key collisions and preserves the original record', async () => {
    const row = transfer('1')
    await store.create(row)
    await expect(store.create(transfer('2', { requestKey: row.requestKey }))).rejects.toThrow()
    await expect(store.save({ ...row, requestKey: 'changed' })).rejects.toThrow()
    expect(await store.byKey(row.requestKey)).toEqual(row)
    await expect(store.save(transfer('missing'))).rejects.toThrow()
  })

  it('atomically rejects a second active transfer, including quote promotion', async () => {
    const first = transfer('1', { state: 'submitting', chargedAt: 110 })
    const second = transfer('2')
    await store.create(first)
    await store.create(second)
    await expect(store.save({ ...second, state: 'pending', chargedAt: 120 })).rejects.toThrow()
    await expect(store.create(transfer('3', { state: 'refunding', chargedAt: 120 }))).rejects.toThrow()
    expect(await store.get(second.id)).toEqual(second)
    await store.save({ ...first, state: 'refunded' })
    await store.save({ ...second, state: 'needs_reconciliation', chargedAt: 120 })
    expect((await store.active()).map((row) => row.id)).toEqual(['2'])
  })

  it('charges uncertain and refunded transfers but releases definite pre-spend failures', async () => {
    const now = 100_000
    await store.create(transfer('old', { state: 'completed', chargedAt: now - 86_400 }))
    await store.create(transfer('future', { state: 'completed', chargedAt: now + 1 }))
    await store.create(transfer('refunded', { state: 'refunded', chargedAt: now - 30 }))
    await store.create(transfer('failed', { state: 'failed', chargedAt: now - 20 }))
    await store.create(transfer('cancelled', { state: 'cancelled', chargedAt: now - 10 }))
    await store.create(transfer('uncertain', { state: 'needs_reconciliation', chargedAt: now }))
    expect(await store.rollingDebit(now)).toBe(2_020)
    expect(await store.lastAttempt()).toBe(now + 1)
    await store.save(transfer('uncertain', { state: 'pending', chargedAt: now, updatedAt: now }))
    expect(await store.rollingDebit(now)).toBe(2_020)
  })

  it('lists latest records with a bounded limit and rejects unsafe debit values', async () => {
    await store.create(transfer('1'))
    await store.create(transfer('2', { createdAt: 101 }))
    expect((await store.list(1)).map((row) => row.id)).toEqual(['2'])
    await expect(store.create(transfer('bad', { debitSats: Number.MAX_SAFE_INTEGER + 1 }))).rejects.toThrow()
    expect(await store.lastAttempt()).toBe(0)
  })

  it('preserves maximum safe debit exactly and fails closed when aggregate charges overflow', async () => {
    const row = transfer('1', { state: 'completed', chargedAt: 100, debitSats: Number.MAX_SAFE_INTEGER })
    await store.create(row)
    expect((await store.get(row.id))?.debitSats).toBe(Number.MAX_SAFE_INTEGER)
    expect(await store.rollingDebit(100)).toBe(Number.MAX_SAFE_INTEGER)
    await store.create(transfer('2', { state: 'completed', chargedAt: 100 }))
    await expect(store.rollingDebit(100)).rejects.toThrow()
  })

  it('retains an unsuccessful automatic attempt clock after reopening without charging a debit', async () => {
    await store.recordAttempt(300)
    await store.recordAttempt(200)
    expect(await store.lastAttempt()).toBe(300)
    expect(await store.rollingDebit(300)).toBe(0)
    await driver.close()
    driver = betterSqliteDriver(join(dir, 'swaps.sqlite'))
    store = await RebalanceStore.open(driver)
    expect(await store.lastAttempt()).toBe(300)
    expect(await store.rollingDebit(300)).toBe(0)
    await store.create(transfer('charged', { state: 'completed', chargedAt: 400 }))
    expect(await store.lastAttempt()).toBe(400)
    await store.recordAttempt(500)
    expect(await store.lastAttempt()).toBe(500)
    await expect(store.recordAttempt(-1)).rejects.toThrow()
  })

  it('refuses charge-erasing updates and keeps valid recovery transitions available', async () => {
    const row = transfer('submitted', { state: 'submitting', chargedAt: 110 })
    await store.create(row)
    for (const change of [
      { state: 'quoted' as const },
      { state: 'cancelled' as const },
      { state: 'failed' as const },
      { chargedAt: undefined },
      { chargedAt: 111 },
      { debitSats: 1_000 },
    ]) {
      await expect(store.save({ ...row, ...change })).rejects.toThrow()
      expect(await store.get(row.id)).toEqual(row)
      expect(await store.rollingDebit(110)).toBe(row.debitSats)
    }
    await store.save({ ...row, state: 'needs_reconciliation' })
    await store.save({ ...row, state: 'pending' })
    await store.save({ ...row, state: 'refunding' })
    await store.save({ ...row, state: 'refunded' })
    await expect(store.save({ ...row, state: 'failed' })).rejects.toThrow()
    expect(await store.rollingDebit(110)).toBe(row.debitSats)
    expect((await store.get(row.id))?.state).toBe('refunded')
  })
})
