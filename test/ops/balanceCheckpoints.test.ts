import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { registerStatusRoutes } from '@arkade-os/solver-app/admin/routes/status.js'
import type { AdminDeps } from '@arkade-os/solver-app/admin/server.js'
import {
  recordBalanceCheckpoint,
  balanceCheckpointScope,
  withBalanceCheckpoints,
  checkpointChanges,
  checkpointNotices,
  formatCheckpointDeferral,
  formatOperatorWithdrawalNotice,
  formatCheckpointRecovery,
  formatCheckpointWarning,
  rebalanceOverlapReady,
} from '@arkade-os/solver-app/ops/balanceCheckpoints.js'
import { createNotifier } from '@arkade-os/solver-app/ops/notify.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { LOCKUP_CONTRACT_TYPE, lockupContractRegistration } from '@arkade-os/solver-arkade/arkade/vtxoLifecycle.js'
import { RebalanceStore } from '../../packages/solver-app/src/ops/rebalanceStore.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import type { RebalanceTransfer } from '@arkade-os/solver-core/ports/rebalance.js'

const stores: AdminStore[] = []
const directories: string[] = []
const rebalanceDrivers: ReturnType<typeof betterSqliteDriver>[] = []
const openStore = async (path = ':memory:') => {
  const store = await AdminStore.open(path)
  stores.push(store)
  return store
}
const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const SOLVER = key(1)
const USER = key(3)
const P2TR = (fill: number): Uint8Array => Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(fill)])
const lockup = (sender: Uint8Array, receiver: Uint8Array, value: number) => {
  const script = new CovenantSwapScript({
    receiver,
    server: key(2),
    preimageHash: new Uint8Array(20).fill(value % 256),
    refundLocktime: 1_800_000_000,
    claimDelay: 512,
    client: sender,
    clientRefundDelay: 1024,
    refundWithoutServerDelay: 2048,
    nonInteractiveParameters: { emulatorPubkey: key(9), receiverPkScript: P2TR(9), senderPkScript: P2TR(8) },
  })
  return { contract: lockupContractRegistration(script, 'ark1address'), vtxos: [{ value, assets: [] }] }
}

const fixture = async (path?: string) => {
  const arkade = { total: 1_000, assets: [{ assetId: 'aa'.repeat(34), amount: 10n ** 25n }] }
  const history: {
    key: { boardingTxid: string; commitmentTxid: string; arkTxid: string }
    type: 'SENT'
    amount: number
    settled: boolean
    createdAt: number
  }[] = []
  const lightning = { availableSats: 2_000, incomingSats: 90_000 }
  const onchain = { confirmedSats: 3_000, unconfirmedSats: 400, sharedWithLightning: false }
  const lockups: ReturnType<typeof lockup>[] = []
  const getContractsWithVtxos = vi.fn(async () => lockups)
  const services = {
    adminStore: await openStore(path),
    config: { network: 'regtest', lnBackend: 'lnd', arkade: { operatorUrl: 'http://arkade.test' } },
    providerPubkey: 'provider',
    arkade: {
      wallet: {
        getBalance: vi.fn(async () => arkade),
        getTransactionHistory: vi.fn(async () => history),
        getContractManager: async () => ({ getContractsWithVtxos }),
      },
      identity: { xOnlyPublicKey: async () => SOLVER },
    },
    ln: { getBalance: vi.fn(async () => lightning) },
    onchain: { getBalance: vi.fn(async () => onchain) },
  } as unknown as Parameters<typeof recordBalanceCheckpoint>[0]
  return {
    services,
    arkade,
    history,
    lightning,
    onchain,
    lockups,
    getContractsWithVtxos,
    sample: () => recordBalanceCheckpoint(services),
  }
}

const rebalanceFixture = async (path?: string) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await fixture(path)
  const driver = betterSqliteDriver(':memory:')
  rebalanceDrivers.push(driver)
  const store = await RebalanceStore.open(driver)
  f.services.rebalanceStore = store
  const now = Math.floor(Date.now() / 1000)
  const transfer: RebalanceTransfer = {
    id: 'rebalance-1',
    requestKey: 'rebalance-1',
    origin: 'automatic',
    poolId: 'rail:onchain',
    netSats: 490,
    debitSats: 500,
    feeSats: 10,
    policyRevision: '1',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60,
    chargedAt: now + 1,
    state: 'pending',
    deposit: { kind: 'onchain', destination: 'deposit', amountSats: 500, netSats: 490, feeSats: 10 },
    inputs: [{ txid: 'ab'.repeat(32), vout: 0, value: 1_000 }],
  }
  const sample = async () => {
    const result = await f.sample()
    vi.setSystemTime(Date.now() + 1_000)
    return result
  }
  return { ...f, sample, store, transfer, save: () => store.save(transfer) }
}

const overlapFixture = async (path?: string) => {
  const f = await rebalanceFixture(path)
  await f.sample()
  await f.store.create(f.transfer)
  f.arkade.total -= 500
  const first = await f.sample()
  const second: RebalanceTransfer & { overridePendingIds: string[] } = {
    ...f.transfer,
    id: 'rebalance-2',
    requestKey: 'rebalance-2',
    origin: 'manual',
    chargedAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    overridePendingIds: [f.transfer.id],
  }
  vi.spyOn(f.store, 'checkpointTransfers').mockImplementation(async () => [f.transfer, second])
  return { ...f, first, second }
}

const withdrawalFixture = async (path?: string) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await fixture(path)
  const sample = async () => {
    const result = await f.sample()
    vi.setSystemTime(Date.now() + 1_000)
    return result
  }
  const create = async (id = 'withdrawal-1', amountSats = 500) =>
    f.services.adminStore.createOperatorWithdrawal({
      id,
      scope: balanceCheckpointScope(f.services),
      source: 'arkade',
      address: 'bc1destination',
      amountSats,
    })
  const sent = async (id = 'withdrawal-1', feeSats = 10) => {
    await f.services.adminStore.transitionOperatorWithdrawal(id, 'preparing', 'sending')
    const row = await f.services.adminStore.transitionOperatorWithdrawal(id, 'sending', 'sent', {
      feeSats,
      reference: 'ab'.repeat(32),
    })
    f.history.push({
      key: { boardingTxid: '', commitmentTxid: '', arkTxid: row.reference! },
      type: 'SENT',
      amount: row.amountSats + feeSats,
      settled: true,
      createdAt: Date.now(),
    })
    return row
  }
  return { ...f, sample, create, sent }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(rebalanceDrivers.splice(0).map((driver) => driver.close()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true })
})

describe('operator withdrawal balance accounting', () => {
  it('accounts for an exact observed Arkade debit without changing the raw balance or sending a recovery', async () => {
    const f = await withdrawalFixture()
    await f.sample()
    await f.create()
    await f.sent()
    f.arkade.total -= 510
    const accounted = await f.sample()
    expect(accounted.totalSats).toBe('5890')
    expect(accounted.operatorWithdrawals?.explained?.[0]?.debitSats).toBe('510')
    expect(accounted.decreases).toEqual([])
    expect(formatOperatorWithdrawalNotice(accounted, 'regtest')).toContain('OPERATOR WITHDRAWAL ACCOUNTED FOR')
    expect(formatOperatorWithdrawalNotice(accounted, 'regtest')).toContain('destination receipt is not verified')
    const next = await f.sample()
    expect(formatCheckpointWarning(next, 'regtest')).toBeNull()
    expect(formatCheckpointRecovery(next, 'regtest')).toBeNull()
  })

  it('still reports an unrelated excess drop after the documented withdrawal', async () => {
    const f = await withdrawalFixture()
    await f.sample()
    await f.create()
    await f.sent()
    f.arkade.total -= 535
    const drop = await f.sample()
    expect(drop.decreases).toEqual([expect.objectContaining({ asset: 'BTC', decrease: '25' })])
    expect(formatCheckpointWarning(await f.sample(), 'regtest')).toContain('25 sats')
  })

  it('waits for the source debit after send success and preserves pending attribution across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'solver-operator-withdrawal-'))
    directories.push(directory)
    const path = join(directory, 'admin.sqlite')
    const f = await withdrawalFixture(path)
    await f.sample()
    await f.create()
    await f.sent()
    const stale = await f.sample()
    expect(stale.operatorWithdrawals?.observedSourceDropSats).toBe('0')
    expect(formatOperatorWithdrawalNotice(stale, 'regtest')).toContain('WITHDRAWAL BALANCE CHECK PENDING')
    expect(stale.decreases).toEqual([])
    await f.services.adminStore.close()
    const restarted = await fixture(path)
    restarted.history.push(...f.history)
    restarted.arkade.total -= 510
    const accounted = await restarted.sample()
    expect(accounted.operatorWithdrawals?.explained).toEqual([
      { id: 'withdrawal-1', reference: 'ab'.repeat(32), address: 'bc1destination', debitSats: '510' },
    ])
    expect(accounted.decreases).toEqual([])
    expect(accounted.recovered).toEqual([])
  })

  it('defers an in-flight send, then accounts for the observed debit when its fee and reference arrive', async () => {
    const f = await withdrawalFixture()
    await f.sample()
    await f.create()
    await f.services.adminStore.transitionOperatorWithdrawal('withdrawal-1', 'preparing', 'sending')
    f.arkade.total -= 510
    const sending = await f.sample()
    expect(sending.operatorWithdrawals?.observedSourceDropSats).toBe('510')
    expect(sending.operatorWithdrawals?.deferred).toBeDefined()
    expect(sending.decreases).toEqual([])
    expect(formatCheckpointWarning(await f.sample(), 'regtest')).toBeNull()
    await f.services.adminStore.transitionOperatorWithdrawal('withdrawal-1', 'sending', 'sent', {
      feeSats: 10,
      reference: 'ab'.repeat(32),
    })
    f.history.push({
      key: { boardingTxid: '', commitmentTxid: '', arkTxid: 'ab'.repeat(32) },
      type: 'SENT',
      amount: 510,
      settled: true,
      createdAt: Date.now(),
    })
    const accounted = await f.sample()
    expect(accounted.operatorWithdrawals?.deferred).toBeUndefined()
    expect(accounted.operatorWithdrawals?.explained?.[0]?.debitSats).toBe('510')
    expect(accounted.decreases).toEqual([])
    expect(accounted.recovered).toEqual([])
  })

  it('does not let a preparing or failed withdrawal mask an unrelated loss', async () => {
    const f = await withdrawalFixture()
    await f.sample()
    await f.create()
    f.arkade.total -= 20
    const preparing = await f.sample()
    expect(preparing.decreases[0]?.decrease).toBe('20')
    await f.services.adminStore.transitionOperatorWithdrawal('withdrawal-1', 'preparing', 'failed')
    expect(formatCheckpointWarning(await f.sample(), 'regtest')).toContain('20 sats')
  })

  it('does not count a simultaneous rebalance source debit as a withdrawal debit', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    await f.services.adminStore.createOperatorWithdrawal({
      id: 'withdrawal-1',
      scope: balanceCheckpointScope(f.services),
      source: 'arkade',
      address: 'bc1destination',
      amountSats: 100,
    })
    await f.services.adminStore.transitionOperatorWithdrawal('withdrawal-1', 'preparing', 'sending')
    await f.services.adminStore.transitionOperatorWithdrawal('withdrawal-1', 'sending', 'sent', {
      feeSats: 10,
      reference: 'ab'.repeat(32),
    })
    f.history.push({
      key: { boardingTxid: '', commitmentTxid: '', arkTxid: 'ab'.repeat(32) },
      type: 'SENT',
      amount: 110,
      settled: true,
      createdAt: Date.now(),
    })
    f.arkade.total -= 500
    const ambiguous = await f.sample()
    expect(ambiguous.operatorWithdrawals?.observedSourceDropSats).toBe('500')
    expect(ambiguous.operatorWithdrawals?.deferred).toBeDefined()
    expect(ambiguous.operatorWithdrawals?.explained).toBeUndefined()
    f.arkade.total -= 110
    await f.sample()
    f.onchain.confirmedSats += 498
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    const accounted = await f.sample()
    expect(accounted.operatorWithdrawals?.explained?.[0]?.debitSats).toBe('110')
    expect(accounted.decreases).toEqual([])
  })

  it('keeps BTC deferred when the withdrawal debit was first mistaken for a rebalance debit', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    await f.services.adminStore.createOperatorWithdrawal({
      id: 'withdrawal-1',
      scope: balanceCheckpointScope(f.services),
      source: 'arkade',
      address: 'bc1destination',
      amountSats: 100,
    })
    await f.services.adminStore.transitionOperatorWithdrawal('withdrawal-1', 'preparing', 'sending')
    await f.services.adminStore.transitionOperatorWithdrawal('withdrawal-1', 'sending', 'sent', {
      feeSats: 10,
      reference: 'ab'.repeat(32),
    })
    f.history.push({
      key: { boardingTxid: '', commitmentTxid: 'ab'.repeat(32), arkTxid: '' },
      type: 'SENT',
      amount: 110,
      settled: true,
      createdAt: Date.now(),
    })
    f.arkade.total -= 110
    const withdrawalFirst = await f.sample()
    expect(withdrawalFirst.operatorWithdrawals?.deferred).toBeDefined()
    f.arkade.total -= 500
    await f.sample()
    f.onchain.confirmedSats += 498
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    const ambiguous = await f.sample()
    expect(ambiguous.operatorWithdrawals?.rebalanceAttributionAmbiguous).toBe(true)
    expect(ambiguous.decreases).toEqual([])
    expect(ambiguous.recovered).toEqual([])
    expect(formatOperatorWithdrawalNotice(ambiguous, 'regtest')).toContain('Manual reconciliation is needed')
    f.arkade.assets[0]!.amount -= 5n
    const next = await f.sample()
    expect(next.decreases.map((row) => row.asset)).toEqual([`arkade:${f.arkade.assets[0]!.assetId}`])
    expect(next.decreases.some((row) => row.asset === 'BTC')).toBe(false)
    expect(formatCheckpointWarning(next, 'regtest')).toBeNull()
  })

  it('does not account for an Arkade drop without matching settled wallet history', async () => {
    const f = await withdrawalFixture()
    await f.sample()
    await f.create()
    await f.sent()
    f.history[0]!.settled = false
    f.arkade.total -= 510
    const pending = await f.sample()
    expect(pending.operatorWithdrawals?.deferred).toBeDefined()
    expect(pending.operatorWithdrawals?.explained).toBeUndefined()
    f.history[0]!.settled = true
    const accounted = await f.sample()
    expect(accounted.operatorWithdrawals?.explained?.[0]?.debitSats).toBe('510')
    expect(accounted.decreases).toEqual([])
  })

  it('accounts for two concurrent withdrawals with distinct settled transactions', async () => {
    const f = await withdrawalFixture()
    await f.sample()
    await f.create('first', 500)
    await f.create('second', 300)
    for (const [id, feeSats, reference, amount] of [
      ['first', 10, 'ab'.repeat(32), 510],
      ['second', 20, 'cd'.repeat(32), 320],
    ] as const) {
      await f.services.adminStore.transitionOperatorWithdrawal(id, 'preparing', 'sending')
      await f.services.adminStore.transitionOperatorWithdrawal(id, 'sending', 'sent', { feeSats, reference })
      f.history.push({
        key: { boardingTxid: '', commitmentTxid: '', arkTxid: reference },
        type: 'SENT',
        amount,
        settled: true,
        createdAt: Date.now(),
      })
    }
    f.arkade.total -= 830
    const accounted = await f.sample()
    expect(accounted.operatorWithdrawals?.explained?.map(({ id }) => id)).toEqual(['first', 'second'])
    expect(accounted.operatorWithdrawals?.deferred).toBeUndefined()
    expect(accounted.decreases).toEqual([])
    expect(formatCheckpointWarning(await f.sample(), 'regtest')).toBeNull()
  })

  it('reminds the operator to verify a long-pending send by journal ID', async () => {
    const f = await withdrawalFixture()
    await f.sample()
    await f.create()
    await f.services.adminStore.transitionOperatorWithdrawal('withdrawal-1', 'preparing', 'sending')
    const first = await f.sample()
    expect(formatOperatorWithdrawalNotice(first, 'regtest')).toContain('withdrawal-1')
    vi.setSystemTime(Date.now() + 30 * 60 * 1_000)
    const reminder = await f.sample()
    expect(formatOperatorWithdrawalNotice(reminder, 'regtest')).toContain('Action needed')
    expect(formatOperatorWithdrawalNotice(reminder, 'regtest')).toContain('wallet transaction and destination receipt')
    expect(formatOperatorWithdrawalNotice(await f.sample(), 'regtest')).toBeNull()
  })

  it.each(['sending', 'uncertain'] as const)(
    'shows one initial notice when the first baseline starts during a %s withdrawal',
    async (state) => {
      const f = await withdrawalFixture()
      await f.create()
      await f.services.adminStore.transitionOperatorWithdrawal('withdrawal-1', 'preparing', state)
      const first = await f.sample()
      expect(first.previousId).toBeNull()
      expect(formatOperatorWithdrawalNotice(first, 'regtest')).toContain('withdrawal-1')
      const next = await f.sample()
      expect(formatOperatorWithdrawalNotice(next, 'regtest')).toBeNull()
      vi.setSystemTime(Date.now() + 30 * 60 * 1_000)
      const reminder = await f.sample()
      expect(formatOperatorWithdrawalNotice(reminder, 'regtest')).toContain('Action needed')
      expect(formatOperatorWithdrawalNotice(await f.sample(), 'regtest')).toBeNull()
    },
  )

  it('shows a newly explained withdrawal alongside another pending one between reminders', async () => {
    const f = await withdrawalFixture()
    await f.sample()
    await f.create()
    await f.services.adminStore.transitionOperatorWithdrawal('withdrawal-1', 'preparing', 'sending')
    await f.sample()
    const quiet = await f.sample()
    expect(formatOperatorWithdrawalNotice(quiet, 'regtest')).toBeNull()
    const combined = {
      ...quiet,
      operatorWithdrawals: {
        ...quiet.operatorWithdrawals!,
        explained: [{ id: 'withdrawal-2', reference: 'ab'.repeat(32), address: 'bc1other', debitSats: '110' }],
      },
    }
    const notice = formatOperatorWithdrawalNotice(combined, 'regtest')
    expect(notice).toContain('110 sats left Arkade for bc1other')
    expect(notice).toContain('withdrawal-1')
  })
})

describe('rebalance balance accounting', () => {
  it('does not mistake an unrelated credit followed by an Arkade debit for rebalance settlement', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    const sent = await f.sample()
    expect(sent.rebalance?.pending[0]?.remainingSats).toBe('500')
    f.onchain.confirmedSats += 400
    const unrelatedCredit = await f.sample()
    expect(unrelatedCredit.rebalance?.attributionDeferred).toBeDefined()
    f.arkade.total -= 400
    const offsettingDebit = await f.sample()
    expect(offsettingDebit.decreases).toEqual([])
    expect(formatCheckpointWarning(await f.sample(), 'regtest')).toBeNull()
    f.onchain.confirmedSats += 498
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    await f.sample()
    const settled = await f.sample()
    expect(settled.decreases).toEqual([])
    expect(settled.rebalance?.attributionDeferred).toBeUndefined()
    expect(settled.unrecovered).toEqual([])
  })

  it('defers an unrelated backend rise and Arkade fall in the same checkpoint', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    await f.sample()
    f.onchain.confirmedSats += 400
    f.arkade.total -= 400
    const offset = await f.sample()
    expect(offset.rebalance?.attributionDeferred).toBeDefined()
    expect(offset.decreases).toEqual([])
    f.onchain.confirmedSats += 498
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    await f.sample()
    const settled = await f.sample()
    expect(settled.rebalance?.attributionDeferred).toBeUndefined()
    expect(settled.decreases).toEqual([])
  })

  it('reminds operators when a new transfer extends deferred BTC attribution', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    await f.sample()
    f.onchain.confirmedSats += 400
    const first = await f.sample()
    expect(formatCheckpointDeferral(first, 'regtest')).toContain('BTC BALANCE CHECK DEFERRED')
    f.onchain.confirmedSats += 498
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    const terminal = await f.sample()
    expect(terminal.rebalance?.pending).toEqual([])
    expect(terminal.rebalance?.attributionDeferred).toBeDefined()
    const second = {
      ...f.transfer,
      id: 'rebalance-2',
      requestKey: 'rebalance-2',
      state: 'pending' as const,
      chargedAt: Math.floor(Date.now() / 1000),
      creditedSats: undefined,
      inputs: [{ txid: 'cd'.repeat(32), vout: 0, value: 500 }],
    }
    await f.store.create(second)
    f.arkade.total -= 500
    const chained = await f.sample()
    expect(chained.rebalance?.attributionDeferred?.transferIds).toEqual(['rebalance-1', 'rebalance-2'])
    expect(formatCheckpointDeferral(chained, 'regtest')).toContain('BTC BALANCE CHECK STILL DEFERRED')
    expect(formatCheckpointDeferral(chained, 'regtest')).toContain('rebalance-1, rebalance-2')
    expect(formatCheckpointDeferral(chained, 'regtest')).toContain('raw difference: -102 sats')
    expect(formatCheckpointDeferral(chained, 'regtest')).toContain('loss is unconfirmed')
    expect(formatCheckpointDeferral(await f.sample(), 'regtest')).toBeNull()
    expect(formatCheckpointWarning(chained, 'regtest')).toBeNull()
  })

  it('repeats an actionable deferral reminder every thirty minutes', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    await f.sample()
    f.onchain.confirmedSats += 400
    await f.sample()
    vi.setSystemTime(Date.now() + 30 * 60 * 1_000)
    const firstReminder = await f.sample()
    expect(formatCheckpointDeferral(firstReminder, 'regtest')).toContain('BTC BALANCE CHECK STILL DEFERRED')
    expect(formatCheckpointDeferral(firstReminder, 'regtest')).toContain('comparison baseline:')
    expect(formatCheckpointDeferral(await f.sample(), 'regtest')).toBeNull()
    vi.setSystemTime(Date.now() + 30 * 60 * 1_000)
    const nextReminder = await f.sample()
    expect(formatCheckpointDeferral(nextReminder, 'regtest')).toContain('BTC BALANCE CHECK STILL DEFERRED')
    expect(formatCheckpointWarning(nextReminder, 'regtest')).toBeNull()
  })

  it('keeps an older BTC warning open and still reports asset losses while attribution is deferred', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    f.onchain.confirmedSats -= 25
    const priorLoss = await f.sample()
    expect(formatCheckpointWarning(await f.sample(), 'regtest')).toContain('25 sats')
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    await f.sample()
    f.onchain.confirmedSats += 400
    const deferred = await f.sample()
    expect(formatCheckpointDeferral(deferred, 'regtest')).toContain('BTC BALANCE CHECK DEFERRED')
    expect(formatCheckpointDeferral(await f.sample(), 'regtest')).toBeNull()
    f.arkade.assets[0]!.amount -= 1n
    const assetLoss = await f.sample()
    expect(assetLoss.decreases.map((change) => change.asset)).toEqual([`arkade:${'aa'.repeat(34)}`])
    expect(formatCheckpointWarning(await f.sample(), 'regtest')).toContain(`arkade:${'aa'.repeat(34)}`)
    expect(assetLoss.recovered).toEqual([])
    expect(assetLoss.unrecovered).toContainEqual({ checkpointId: priorLoss.id, asset: 'BTC', before: '6400' })
    f.arkade.total -= 400
    await f.sample()
    f.onchain.confirmedSats += 498
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    await f.sample()
    const settled = await f.sample()
    expect(settled.recovered).toEqual([])
    expect(settled.unrecovered).toContainEqual({ checkpointId: priorLoss.id, asset: 'BTC', before: '6400' })
  })

  it.each([false, true])('delays an unannounced BTC drop through deferral (restored: %s)', async (restored) => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    await f.sample()
    f.lightning.availableSats -= 25
    const loss = await f.sample()
    f.onchain.confirmedSats += 400
    const deferred = await f.sample()
    expect(deferred.rebalance?.attributionDeferred?.heldBtcDecreaseIds).toEqual([loss.id])
    expect(formatCheckpointWarning(deferred, 'regtest')).toBeNull()
    f.arkade.total -= 400
    if (restored) f.lightning.availableSats += 25
    f.onchain.confirmedSats += 498
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    await f.sample()
    const settled = await f.sample()
    expect(settled.rebalance?.attributionDeferred).toBeUndefined()
    if (restored) {
      expect(formatCheckpointWarning(settled, 'regtest')).toBeNull()
      expect(formatCheckpointRecovery(settled, 'regtest')).toBeNull()
      expect(settled.unrecovered).toEqual([])
    } else {
      expect(formatCheckpointWarning(settled, 'regtest')).toContain('25 sats')
      expect(settled.recovered).toEqual([])
    }
  })

  it('retains a delayed BTC warning past the asset recovery cap', async () => {
    const f = await rebalanceFixture()
    const assets = Array.from({ length: 22 }, (_, index) => ({
      assetId: (index + 1).toString(16).padStart(2, '0').repeat(34),
      amount: 1n,
    }))
    f.arkade.assets.push(...assets)
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    await f.sample()
    f.lightning.availableSats -= 25
    const loss = await f.sample()
    f.onchain.confirmedSats += 400
    await f.sample()
    for (const asset of assets) {
      f.arkade.assets = f.arkade.assets.filter((row) => row.assetId !== asset.assetId)
      await f.sample()
    }
    const during = await f.sample()
    expect(during.unrecovered).toContainEqual({ checkpointId: loss.id, asset: 'BTC', before: '6400' })
    expect(during.unrecovered).toHaveLength(20)
    f.arkade.total -= 400
    f.onchain.confirmedSats += 498
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    await f.sample()
    const settled = await f.sample()
    expect(formatCheckpointWarning(settled, 'regtest')).toContain('25 sats')
    expect(settled.unrecovered).toContainEqual({ checkpointId: loss.id, asset: 'BTC', before: '6400' })
  })

  it('reports a real BTC loss after ambiguous rebalance movements settle', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    await f.sample()
    f.onchain.confirmedSats += 400
    await f.sample()
    f.arkade.total -= 400
    f.lightning.availableSats -= 25
    expect((await f.sample()).decreases).toEqual([])
    f.onchain.confirmedSats += 498
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    await f.sample()
    const settled = await f.sample()
    expect(settled.decreases).toEqual([{ asset: 'BTC', before: '6400', after: '6375', decrease: '25' }])
    expect(formatCheckpointWarning(await f.sample(), 'regtest')).toContain('25 sats')
  })

  it('persists deferred attribution across restart and resumes after a refunded transfer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'solver-rebalance-checkpoints-'))
    directories.push(directory)
    const path = join(directory, 'admin.sqlite')
    const f = await rebalanceFixture(path)
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    await f.sample()
    f.onchain.confirmedSats += 400
    const deferred = await f.sample()
    await f.services.adminStore.close()
    const restarted = await fixture(path)
    restarted.services.rebalanceStore = f.store
    restarted.arkade.total = f.arkade.total
    restarted.onchain.confirmedSats = f.onchain.confirmedSats
    restarted.arkade.total -= 400
    const afterRestart = await restarted.sample()
    expect(afterRestart.rebalance?.attributionDeferred?.anchorCheckpointId).toBe(deferred.previousId)
    expect(afterRestart.decreases).toEqual([])
    restarted.arkade.total += 500
    f.transfer.state = 'refunded'
    await f.save()
    await restarted.sample()
    const settled = await restarted.sample()
    expect(settled.rebalance?.attributionDeferred).toBeUndefined()
    expect(settled.decreases).toEqual([])
  })

  it('defers a legacy pending hold already reduced without a receipt before the upgrade', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    const sent = await f.sample()
    expect(sent.rebalance?.accountingVersion).toBe(2)
    f.onchain.confirmedSats += 400
    const { id: sentId, ...entry } = sent
    await f.services.adminStore.recordBalanceCheckpoint({
      ...entry,
      previousId: sentId,
      totalSats: String(BigInt(sent.totalSats!) + 400n),
      onchain: { ...sent.onchain!, confirmedSats: String(BigInt(sent.onchain!.confirmedSats) + 400n) },
      rebalance: {
        comparisonTotalSats: sent.rebalance!.comparisonTotalSats,
        feeAllowanceUsedSats: sent.rebalance!.feeAllowanceUsedSats,
        seenIds: sent.rebalance!.seenIds,
        pending: [{ ...sent.rebalance!.pending[0]!, remainingSats: '100' }],
      },
      decreases: [],
    })
    const upgraded = await f.sample()
    expect(upgraded.rebalance?.accountingVersion).toBe(2)
    expect(upgraded.rebalance?.attributionDeferred).toBeDefined()
    f.arkade.total -= 400
    expect((await f.sample()).decreases).toEqual([])
  })

  it.each([-1, 0])(
    'does not reuse an old pending debit when upgrading a legacy baseline (offset %i)',
    async (offset) => {
      const f = await rebalanceFixture()
      delete f.services.rebalanceStore
      f.arkade.total -= 500
      const legacy = await f.sample()
      expect(legacy.rebalance).toBeUndefined()
      f.transfer.chargedAt = legacy.startedAt + offset
      await f.store.create(f.transfer)
      f.services.rebalanceStore = f.store
      expect((await f.sample()).rebalance?.pending[0]).toMatchObject({
        debitObserved: true,
        observedDebitSats: '0',
        remainingSats: '0',
      })
      f.arkade.total -= 25
      expect((await f.sample()).decreases[0]?.decrease).toBe('25')
    },
  )

  it('holds the observed source debit while credit is pending, then accounts only for the remaining fee', async () => {
    const f = await rebalanceFixture()
    const initial = await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    const sent = await f.sample()
    expect(sent.totalSats).toBe('5900')
    expect(sent.rebalance?.comparisonTotalSats).toBe('6400')
    expect(sent.decreases).toEqual([])
    expect((await f.sample()).unrecovered).toEqual([])
    f.onchain.confirmedSats += 498
    const creditedBeforeJournal = await f.sample()
    expect(creditedBeforeJournal.rebalance?.pending[0]?.remainingSats).toBe('500')
    expect(creditedBeforeJournal.rebalance?.attributionDeferred).toBeDefined()
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    const completed = await f.sample()
    expect(completed.totalSats).toBe('6398')
    expect(completed.rebalance).toMatchObject({ comparisonTotalSats: '6400', feeAllowanceUsedSats: '2', pending: [] })
    expect(completed.decreases).toEqual([])
    expect(completed.unrecovered).toEqual([])
    expect(formatCheckpointWarning(completed, 'regtest')).toBeNull()
    expect(checkpointChanges(initial, completed)?.[0]?.delta).toBe('-2')
    expect((await f.sample()).rebalance?.attributionDeferred).toBeUndefined()
    f.arkade.total -= 1
    expect((await f.sample()).decreases[0]?.decrease).toBe('1')
  })

  it('attributes a same-second new debit when the modern baseline had already read an empty journal', async () => {
    const f = await rebalanceFixture()
    const initial = await f.sample()
    expect(initial.rebalance?.seenIds).toEqual([])
    f.transfer.chargedAt = initial.startedAt
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    const sent = await f.sample()
    expect(sent.rebalance?.pending[0]).toMatchObject({ observedDebitSats: '500', remainingSats: '500' })
    expect(sent.decreases).toEqual([])
    expect((await f.sample()).unrecovered).toEqual([])
  })

  it('does not book the authorized maximum as an actual debit', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    f.transfer.netSats = 440
    f.transfer.feeSats = 60
    f.transfer.deposit = { ...f.transfer.deposit, netSats: 440, feeSats: 60 }
    await f.store.create(f.transfer)
    f.arkade.total -= 450
    expect((await f.sample()).rebalance?.pending[0]?.remainingSats).toBe('450')
    f.onchain.confirmedSats += 448
    f.lightning.availableSats -= 5
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 448
    await f.save()
    const completed = await f.sample()
    expect(completed.rebalance?.feeAllowanceUsedSats).toBe('2')
    expect(completed.decreases[0]?.decrease).toBe('5')
  })

  it('retains the source debit when both legs are visible before the journal completes', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    f.onchain.confirmedSats += 498
    const pending = await f.sample()
    expect(pending.rebalance?.pending[0]).toMatchObject({ observedDebitSats: '500', remainingSats: '2' })
    expect(pending.decreases).toEqual([])
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    const completed = await f.sample()
    expect(completed.rebalance?.feeAllowanceUsedSats).toBe('2')
    expect(completed.decreases).toEqual([])
    expect(completed.unrecovered).toEqual([])
  })

  it('consumes a source debit even when an incoming payment offsets its fee', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    f.onchain.confirmedSats += 500
    const offset = await f.sample()
    expect(offset.rebalance?.pending[0]).toMatchObject({
      debitObserved: true,
      observedDebitSats: '500',
      remainingSats: '0',
    })
    expect(offset.rebalance?.attributionDeferred).toBeDefined()
    f.arkade.total -= 5
    expect((await f.sample()).decreases).toEqual([])
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 500
    await f.save()
    await f.sample()
    expect((await f.sample()).decreases[0]?.decrease).toBe('5')
  })

  it('accounts for a proven completion fee when an unrelated credit offset the source debit', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    f.onchain.confirmedSats += 500
    const offset = await f.sample()
    expect(offset.rebalance?.pending[0]?.remainingSats).toBe('0')
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    await f.sample()
    const settled = await f.sample()
    expect(settled.rebalance?.feeAllowanceUsedSats).toBe('2')
    expect(settled.decreases).toEqual([])
    expect((await f.sample()).decreases).toEqual([])
  })

  it('still alerts an unrelated loss during a pending transfer and does not clear it with the deposit', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    await f.sample()
    f.onchain.confirmedSats -= 25
    const loss = await f.sample()
    expect(loss.decreases).toEqual([{ asset: 'BTC', before: '6400', after: '6375', decrease: '25' }])
    expect(formatCheckpointWarning(await f.sample(), 'regtest')).toContain('unexplained decrease of 25 sats')
    f.onchain.confirmedSats += 498
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    const completed = await f.sample()
    expect(completed.recovered).toEqual([])
    expect(completed.unrecovered).toEqual([{ checkpointId: loss.id, asset: 'BTC', before: '6400' }])
    f.onchain.confirmedSats += 25
    expect(formatCheckpointRecovery(await f.sample(), 'regtest')).toContain('unexplained decrease cleared')
  })

  it('keeps the part of a simultaneous decline that exceeds the debit cap visible', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    f.lightning.availableSats -= 20
    expect((await f.sample()).decreases[0]?.decrease).toBe('20')
  })

  it('uses only the completion fee bound when both legs settle between checkpoints', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    f.onchain.confirmedSats += 498
    f.lightning.availableSats -= 5
    const completed = await f.sample()
    expect(completed.rebalance?.feeAllowanceUsedSats).toBe('2')
    expect(completed.decreases[0]?.decrease).toBe('5')
  })

  it('bounds first-seen completion fees by the observed source debit, not its authorized maximum', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    f.transfer.state = 'completed'
    f.transfer.netSats = 440
    f.transfer.feeSats = 60
    f.transfer.creditedSats = 448
    await f.store.create(f.transfer)
    f.arkade.total -= 450
    f.onchain.confirmedSats += 448
    f.lightning.availableSats -= 5
    const completed = await f.sample()
    expect(completed.rebalance?.feeAllowanceUsedSats).toBe('2')
    expect(completed.decreases[0]?.decrease).toBe('5')
  })

  it('retains the consumed debit allowance across an admin-store restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'solver-rebalance-checkpoints-'))
    directories.push(directory)
    const path = join(directory, 'admin.sqlite')
    const f = await rebalanceFixture(path)
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    await f.sample()
    await f.services.adminStore.close()
    const restarted = await fixture(path)
    restarted.services.rebalanceStore = f.store
    restarted.arkade.total -= 500
    expect((await restarted.sample()).decreases).toEqual([])
    restarted.arkade.total -= 12
    expect((await restarted.sample()).decreases[0]?.decrease).toBe('12')
  })

  it.each([500, 480])('releases a refunded transfer hold after %i sats return', async (returned) => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    await f.sample()
    f.arkade.total += returned
    f.transfer.state = 'refunded'
    await f.save()
    const refunded = await f.sample()
    expect(refunded.rebalance?.pending).toEqual([])
    expect(refunded.rebalance?.feeAllowanceUsedSats).toBe('0')
    expect(refunded.decreases.map((row) => row.decrease)).toEqual(returned === 500 ? [] : ['20'])
  })

  it('does not excuse a decline using a failed, uncharged quote', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    f.transfer.state = 'failed'
    delete f.transfer.chargedAt
    await f.store.create(f.transfer)
    f.arkade.total -= 10
    expect((await f.sample()).decreases[0]?.decrease).toBe('10')
  })

  it('keeps a journal read failure incomplete and retains the last complete attribution', async () => {
    const f = await rebalanceFixture()
    await f.sample()
    await f.store.create(f.transfer)
    f.arkade.total -= 500
    const sent = await f.sample()
    vi.spyOn(f.store, 'checkpointTransfers').mockRejectedValueOnce(new Error('journal unavailable'))
    const incomplete = await f.sample()
    expect(incomplete.totalSats).toBeNull()
    expect(incomplete.errors.rebalance).toBe('journal unavailable')
    const next = await f.sample()
    expect(next.previousId).toBe(sent.id)
    expect(next.rebalance?.pending[0]?.remainingSats).toBe('500')
    expect(next.decreases).toEqual([])
  })

  it('requires an observed source debit before permitting an overlap', async () => {
    const f = await rebalanceFixture()
    const baseline = await f.sample()
    expect(rebalanceOverlapReady(baseline, [f.transfer.id])).toBe(false)
    await f.store.create(f.transfer)
    const unobserved = await f.sample()
    expect(rebalanceOverlapReady(unobserved, [f.transfer.id])).toBe(false)
    f.arkade.total -= 500
    const observed = await f.sample()
    expect(rebalanceOverlapReady(observed, [f.transfer.id])).toBe(true)
    expect(rebalanceOverlapReady(observed, ['unknown'])).toBe(false)
    const deferred = {
      anchorCheckpointId: observed.id,
      anchorComparisonTotalSats: observed.rebalance!.comparisonTotalSats,
      since: observed.finishedAt,
      transferIds: [f.transfer.id],
    }
    const withDeferral = { ...observed, rebalance: { ...observed.rebalance!, attributionDeferred: deferred } }
    expect(rebalanceOverlapReady(withDeferral, [f.transfer.id])).toBe(true)
    expect(rebalanceOverlapReady(withDeferral, ['unknown'])).toBe(false)
    expect(
      rebalanceOverlapReady(
        {
          ...withDeferral,
          rebalance: { ...withDeferral.rebalance, attributionDeferred: { ...deferred, overrideId: 'other' } },
        },
        [f.transfer.id],
      ),
    ).toBe(false)
    expect(
      rebalanceOverlapReady({ ...observed, rebalance: { ...observed.rebalance!, accountingVersion: undefined } }, [
        f.transfer.id,
      ]),
    ).toBe(false)
  })

  it('defers BTC attribution when the first credit and second debit net in one sample', async () => {
    const f = await overlapFixture()
    expect(rebalanceOverlapReady(f.first, [f.transfer.id])).toBe(true)
    f.onchain.confirmedSats += 498
    f.arkade.total -= 500
    const overlapping = await f.sample()
    expect(overlapping.totalSats).toBe('5898')
    expect(overlapping.rebalance?.comparisonTotalSats).toBe('6400')
    expect(overlapping.rebalance?.attributionDeferred?.transferIds).toEqual([f.transfer.id, f.second.id])
    expect(overlapping.decreases).toEqual([])
    expect(overlapping.recovered).toEqual([])
    expect(rebalanceOverlapReady(overlapping, [f.transfer.id])).toBe(false)
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    expect((await f.sample()).rebalance?.attributionDeferred).toBeDefined()
    f.onchain.confirmedSats += 498
    f.second.state = 'completed'
    f.second.creditedSats = 498
    const settled = await f.sample()
    expect(settled.rebalance?.attributionDeferred).toBeUndefined()
    expect(settled.rebalance?.uncertainFeeAllowanceSats).toBe('4')
    expect(settled.decreases).toEqual([])
    expect(formatCheckpointWarning(settled, 'regtest')).toBeNull()
  })

  it('reminds operators while overlapping transfers remain unsettled', async () => {
    const f = await overlapFixture()
    f.arkade.total -= 500
    const initial = await f.sample()
    expect(formatCheckpointDeferral(initial, 'regtest')).toContain('BTC BALANCE CHECK DEFERRED')
    vi.setSystemTime(Date.now() + 30 * 60 * 1_000)
    const reminder = await f.sample()
    expect(formatCheckpointDeferral(reminder, 'regtest')).toContain('BTC BALANCE CHECK STILL DEFERRED')
    expect(formatCheckpointDeferral(reminder, 'regtest')).toContain('rebalance-1, rebalance-2')
    expect(formatCheckpointWarning(reminder, 'regtest')).toBeNull()
  })

  it('defers when the second destination credits before the first', async () => {
    const f = await overlapFixture()
    f.arkade.total -= 500
    f.onchain.confirmedSats += 498
    f.second.state = 'completed'
    f.second.creditedSats = 498
    const secondFirst = await f.sample()
    expect(secondFirst.rebalance?.attributionDeferred).toBeDefined()
    expect(secondFirst.decreases).toEqual([])
    f.onchain.confirmedSats += 498
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    const settled = await f.sample()
    expect(settled.rebalance?.attributionDeferred).toBeUndefined()
    expect(settled.decreases).toEqual([])
  })

  it('takes another fresh sample when both transfers settle before the first overlap checkpoint', async () => {
    const f = await overlapFixture()
    f.arkade.total -= 500
    f.onchain.confirmedSats += 996
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    f.second.state = 'completed'
    f.second.creditedSats = 498
    const first = await f.sample()
    expect(first.rebalance?.attributionDeferred).toBeDefined()
    expect(first.decreases).toEqual([])
    const fresh = await f.sample()
    expect(fresh.rebalance?.attributionDeferred).toBeUndefined()
    expect(fresh.decreases).toEqual([])
  })

  it('promotes an already deferred single transfer when a previously approved override charges', async () => {
    const f = await overlapFixture()
    delete f.second.chargedAt
    f.lightning.availableSats -= 25
    const loss = await f.sample()
    f.onchain.confirmedSats += 10
    const singleDeferred = await f.sample()
    expect(singleDeferred.rebalance?.attributionDeferred?.heldBtcDecreaseIds).toEqual([loss.id])
    f.second.chargedAt = Math.floor(Date.now() / 1000)
    f.arkade.total -= 500
    const overlapping = await f.sample()
    expect(overlapping.rebalance?.attributionDeferred).toMatchObject({
      anchorCheckpointId: singleDeferred.rebalance?.attributionDeferred?.anchorCheckpointId,
      overrideId: f.second.id,
      heldBtcDecreaseIds: [loss.id],
    })
    expect(formatCheckpointDeferral(overlapping, 'regtest')).toContain('BTC BALANCE CHECK STILL DEFERRED')
    expect(overlapping.decreases).toEqual([])
    f.onchain.confirmedSats += 996
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    f.second.state = 'completed'
    f.second.creditedSats = 498
    const settled = await f.sample()
    expect(settled.rebalance?.attributionDeferred).toBeUndefined()
    expect(formatCheckpointWarning(settled, 'regtest')).toContain('15 sats')
    expect(settled.recovered).toEqual([])
  })

  it('loads a terminal first transfer by ID from a persisted older deferred cursor', async () => {
    const f = await overlapFixture()
    const { id, ...entry } = f.first
    await f.services.adminStore.recordBalanceCheckpoint({
      ...entry,
      previousId: id,
      rebalance: {
        ...f.first.rebalance!,
        pending: [],
        attributionDeferred: {
          anchorCheckpointId: id,
          anchorComparisonTotalSats: f.first.rebalance!.comparisonTotalSats,
          since: f.first.finishedAt + 1,
          transferIds: [f.transfer.id],
        },
      },
    })
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    await f.save()
    f.arkade.total -= 500
    f.onchain.confirmedSats += 498
    vi.mocked(f.store.checkpointTransfers).mockResolvedValue([f.second])
    const get = vi.spyOn(f.store, 'get')
    const promoted = await f.sample()
    expect(get).toHaveBeenCalledWith(f.transfer.id)
    expect(promoted.errors.rebalance).toBeUndefined()
    expect(promoted.totalSats).not.toBeNull()
    expect(promoted.rebalance?.attributionDeferred).toMatchObject({
      anchorCheckpointId: id,
      transferIds: [f.transfer.id, f.second.id],
      overrideId: f.second.id,
    })
    expect(promoted.decreases).toEqual([])
  })

  it('does not falsely recover an older loss using the override fee upper bound', async () => {
    const f = await overlapFixture()
    delete f.second.chargedAt
    f.onchain.confirmedSats -= 25
    const loss = await f.sample()
    expect(loss.decreases[0]?.decrease).toBe('25')
    expect(formatCheckpointWarning(await f.sample(), 'regtest')).toContain('unexplained decrease')
    f.second.chargedAt = Math.floor(Date.now() / 1000)
    f.second.feeSats = 60
    f.second.netSats = 440
    f.second.deposit = { ...f.second.deposit, netSats: 440, feeSats: 60 }
    f.arkade.total -= 450
    f.onchain.confirmedSats += 498
    const deferred = await f.sample()
    expect(deferred.rebalance?.attributionDeferred).toBeDefined()
    f.transfer.state = 'completed'
    f.transfer.creditedSats = 498
    f.second.state = 'completed'
    f.second.creditedSats = 440
    f.onchain.confirmedSats += 440
    const settled = await f.sample()
    expect(settled.rebalance?.uncertainFeeAllowanceSats).toBe('62')
    expect(BigInt(settled.rebalance!.comparisonTotalSats)).toBeGreaterThan(6_400n)
    expect(settled.recovered).toEqual([])
    expect(settled.unrecovered).toContainEqual({ checkpointId: loss.id, asset: 'BTC', before: '6400' })
    f.lightning.availableSats -= 60
    const laterLoss = await f.sample()
    expect(laterLoss.decreases.some((row) => row.asset === 'BTC')).toBe(true)
  })

  it('persists overlap deferral across a checkpoint-store restart while assets still alert', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'solver-overlap-checkpoints-'))
    directories.push(directory)
    const path = join(directory, 'admin.sqlite')
    const f = await overlapFixture(path)
    f.arkade.total -= 500
    const deferred = await f.sample()
    expect(deferred.rebalance?.attributionDeferred).toBeDefined()
    await f.services.adminStore.close()
    const restarted = await fixture(path)
    restarted.services.rebalanceStore = f.store
    restarted.arkade.total = f.arkade.total
    restarted.arkade.assets[0]!.amount -= 5n
    const next = await restarted.sample()
    expect(next.rebalance?.attributionDeferred?.anchorCheckpointId).toBe(f.first.id)
    expect(next.decreases.map((row) => row.asset)).toEqual([`arkade:${f.arkade.assets[0]!.assetId}`])
    expect(next.decreases[0]?.decrease).toBe('5')
    expect(next.decreases.some((row) => row.asset === 'BTC')).toBe(false)
  })

  it('does not mistake a source refund plus second debit for an unexplained loss', async () => {
    const f = await overlapFixture()
    f.transfer.state = 'refunded'
    f.arkade.total += 500
    f.arkade.total -= 500
    expect((await f.sample()).rebalance?.attributionDeferred).toBeDefined()
    f.second.state = 'completed'
    f.second.creditedSats = 498
    f.onchain.confirmedSats += 498
    const settled = await f.sample()
    expect(settled.rebalance?.attributionDeferred).toBeUndefined()
    expect(settled.decreases).toEqual([])
  })
})

describe('balance checkpoints', () => {
  it('persists owned BTC and exact asset amounts, excluding inbound capacity', async () => {
    const f = await fixture()
    const checkpoint = await f.sample()
    expect(checkpoint.totalSats).toBe('6400')
    expect(checkpoint.arkade?.assets).toEqual({ [f.arkade.assets[0]!.assetId]: '10000000000000000000000000' })
    expect(checkpoint.previousId).toBeNull()
    expect(checkpoint.decreases).toEqual([])
    expect(await f.services.adminStore.listBalanceCheckpoints(checkpoint.scope)).toEqual([checkpoint])
  })

  it('does not double count a shared Lightning/onchain pool', async () => {
    const f = await fixture()
    f.onchain.sharedWithLightning = true
    expect((await f.sample()).totalSats).toBe('4400')
    f.lightning.availableSats = 1
    expect((await f.sample()).decreases).toEqual([])
  })

  it('leaves a user-funded lockup out until it is ours, so refunding it is no loss', async () => {
    const f = await fixture()
    f.lockups.push(lockup(USER, SOLVER, 300), lockup(SOLVER, USER, 200))
    f.arkade.total += 500
    expect((await f.sample()).arkade?.totalSats).toBe('1200')
    expect(f.getContractsWithVtxos).toHaveBeenCalledWith({ type: [LOCKUP_CONTRACT_TYPE] }, undefined, {
      maxSyncAgeMs: Number.MAX_SAFE_INTEGER,
      unspentOnly: true,
    })
    f.lockups.shift()
    f.arkade.total -= 300
    expect((await f.sample()).decreases).toEqual([])
  })

  it('does not report internal BTC transfers or confirmations as losses', async () => {
    const f = await fixture()
    await f.sample()
    f.arkade.total -= 500
    f.lightning.availableSats += 500
    f.onchain.confirmedSats += 400
    f.onchain.unconfirmedSats = 0
    expect((await f.sample()).decreases).toEqual([])
  })

  it('reports net BTC decreases and assets disappearing without rounding', async () => {
    const f = await fixture()
    const baseline = await f.sample()
    f.arkade.total -= 12
    f.lightning.availableSats += 2
    f.arkade.assets = []
    const checkpoint = await f.sample()
    expect(checkpoint.previousId).toBe(baseline.id)
    expect(checkpoint.decreases).toEqual([
      { asset: 'BTC', before: '6400', after: '6390', decrease: '10' },
      {
        asset: `arkade:${'aa'.repeat(34)}`,
        before: '10000000000000000000000000',
        after: '0',
        decrease: '10000000000000000000000000',
      },
    ])
  })

  it('compares across a restart and incomplete readings against the last complete checkpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'solver-balance-checkpoints-'))
    directories.push(directory)
    const path = join(directory, 'admin.sqlite')
    const f = await fixture(path)
    const baseline = await f.sample()
    await f.services.adminStore.close()
    const restarted = await fixture(path)
    vi.mocked(restarted.services.ln!.getBalance).mockRejectedValueOnce(new Error('offline'))
    const incomplete = await restarted.sample()
    expect(incomplete.totalSats).toBeNull()
    expect(incomplete.lightningSats).toBeNull()
    expect(incomplete.errors).toEqual({ lightning: 'offline' })
    expect(incomplete.decreases).toEqual([])
    restarted.lightning.availableSats -= 5
    const recovered = await restarted.sample()
    expect(recovered.previousId).toBe(baseline.id)
    expect(recovered.decreases[0]?.decrease).toBe('5')
    expect((await restarted.services.adminStore.listBalanceCheckpoints(baseline.scope)).map((row) => row.id)).toEqual([
      recovered.id,
      incomplete.id,
      baseline.id,
    ])
  })

  it('checks each asset independently even when BTC increases', async () => {
    const f = await fixture()
    await f.sample()
    f.arkade.total += 1_000
    f.arkade.assets[0]!.amount -= 1n
    const checkpoint = await f.sample()
    expect(checkpoint.decreases).toEqual([
      {
        asset: `arkade:${f.arkade.assets[0]!.assetId}`,
        before: '10000000000000000000000000',
        after: '9999999999999999999999999',
        decrease: '1',
      },
    ])
  })

  it('follows each decrease until its asset is back, across restarts and incomplete reads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'solver-balance-recovery-'))
    directories.push(directory)
    const path = join(directory, 'admin.sqlite')
    const asset = `arkade:${'aa'.repeat(34)}`
    const units = '10000000000000000000000000'
    const f = await fixture(path)
    await f.sample()
    f.arkade.total -= 500
    f.arkade.assets = []
    const drop = await f.sample()
    await f.services.adminStore.close()
    const restarted = await fixture(path)
    restarted.arkade.total -= 500
    restarted.arkade.assets = []
    expect((await restarted.sample()).unrecovered).toEqual([
      { checkpointId: drop.id, asset: 'BTC', before: '6400' },
      { checkpointId: drop.id, asset, before: units },
    ])
    vi.mocked(restarted.services.ln!.getBalance).mockRejectedValueOnce(new Error('offline'))
    await restarted.sample()
    restarted.arkade.total += 501
    const back = await restarted.sample()
    expect(back.recovered).toEqual([{ checkpointId: drop.id, asset: 'BTC', before: '6400', after: '6401' }])
    expect(back.unrecovered).toEqual([{ checkpointId: drop.id, asset, before: units }])
    restarted.arkade.assets = [{ assetId: 'aa'.repeat(34), amount: 10n ** 25n }]
    const assetBack = await restarted.sample()
    expect(assetBack.recovered).toEqual([{ checkpointId: drop.id, asset, before: units, after: units }])
    expect(assetBack.unrecovered).toEqual([])
  })

  it('measures each recovery against the balance before its own decrease', async () => {
    const f = await fixture()
    await f.sample()
    f.arkade.total += 546
    await f.sample()
    f.lightning.availableSats -= 544
    const settled = await f.sample()
    f.arkade.total -= 600
    const blip = await f.sample()
    f.arkade.total += 600
    const back = await f.sample()
    expect(back.recovered).toEqual([{ checkpointId: blip.id, asset: 'BTC', before: '6402', after: '6402' }])
    expect(back.unrecovered).toEqual([{ checkpointId: settled.id, asset: 'BTC', before: '6946' }])
  })

  it('stops following the oldest of more than 20 unrecovered decreases', async () => {
    const f = await fixture()
    await f.sample()
    for (let i = 0; i < 21; i++) {
      f.arkade.total -= 1
      await f.sample()
    }
    const unrecovered = (await f.sample()).unrecovered!
    expect(unrecovered).toHaveLength(20)
    expect(unrecovered[0]?.before).toBe('6399')
  })

  it('keeps providers and backends in separate baselines', async () => {
    const f = await fixture()
    await f.sample()
    f.arkade.total = 0
    f.services.providerPubkey = 'other-provider'
    expect((await f.sample()).previousId).toBeNull()
    f.services.config.lnBackend = 'fake'
    expect((await f.sample()).previousId).toBeNull()
  })

  it('supports deployments without a BTC rail', async () => {
    const f = await fixture()
    f.services.ln = null
    f.services.onchain = null
    expect((await f.sample()).totalSats).toBe('1000')
  })

  it.each([NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid sats: %s', async (value) => {
    const f = await fixture()
    f.arkade.total = value
    const checkpoint = await f.sample()
    expect(checkpoint.totalSats).toBeNull()
    expect(checkpoint.errors.arkade).toContain('safe integer')
  })

  it('bounds a backend read that never answers', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    vi.mocked(f.services.ln!.getBalance).mockImplementationOnce(() => new Promise(() => {}))
    const pending = f.sample()
    await vi.advanceTimersByTimeAsync(10_000)
    const checkpoint = await pending
    expect(checkpoint.totalSats).toBeNull()
    expect(checkpoint.errors.lightning).toContain('no answer within')
  })

  it('joins a timed-out backend read until it finishes instead of starting another', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    let release!: (balance: typeof f.lightning) => void
    vi.mocked(f.services.ln!.getBalance).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const first = f.sample()
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await first).totalSats).toBeNull()
    const second = f.sample()
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await second).totalSats).toBeNull()
    expect(f.services.ln!.getBalance).toHaveBeenCalledTimes(1)
    release(f.lightning)
    await vi.advanceTimersByTimeAsync(0)
    expect((await f.sample()).totalSats).toBe('6400')
    expect(f.services.ln!.getBalance).toHaveBeenCalledTimes(2)
  })

  it('serves bounded checkpoint history without reading wallets', async () => {
    const f = await fixture()
    const checkpoint = await f.sample()
    const app = new Hono()
    registerStatusRoutes(app, { services: f.services } as AdminDeps)
    expect(await (await app.request('/api/balance-checkpoints?limit=1')).json()).toEqual({
      scope: checkpoint.scope,
      checkpoints: [checkpoint],
    })
    for (const limit of ['0', '201', '-1', '1.5', '1e2', '']) {
      expect((await app.request(`/api/balance-checkpoints?limit=${limit}`)).status).toBe(400)
    }
    expect(f.services.arkade.wallet.getBalance).toHaveBeenCalledTimes(1)
  })

  it('filters history by the current deployment scope before applying the limit', async () => {
    const f = await fixture()
    const first = await f.sample()
    f.services.providerPubkey = 'other-provider'
    const other = await f.sample()
    f.services.providerPubkey = 'provider'
    const latest = await f.sample()
    f.services.config.arkade.operatorUrl = 'http://other-arkade.test'
    const otherServer = await f.sample()
    f.services.config.arkade.operatorUrl = 'http://arkade.test'
    const app = new Hono()
    registerStatusRoutes(app, { services: f.services } as AdminDeps)
    expect(await (await app.request('/api/balance-checkpoints')).json()).toEqual({
      scope: first.scope,
      checkpoints: [latest, first],
    })
    expect(await (await app.request('/api/balance-checkpoints?limit=1')).json()).toEqual({
      scope: first.scope,
      checkpoints: [latest],
    })
    f.services.providerPubkey = 'other-provider'
    expect(await (await app.request('/api/balance-checkpoints')).json()).toEqual({
      scope: other.scope,
      checkpoints: [other],
    })
    f.services.config.arkade.operatorUrl = 'http://empty-arkade.test'
    expect(await (await app.request('/api/balance-checkpoints')).json()).toEqual({
      scope: balanceCheckpointScope(f.services),
      checkpoints: [],
    })
    expect(otherServer.scope).not.toBe(first.scope)
    expect(f.services.arkade.wallet.getBalance).toHaveBeenCalledTimes(4)
  })

  it('retains the previous report baseline across intermediate checkpoints and restarts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'solver-balance-reports-'))
    directories.push(directory)
    const path = join(directory, 'admin.sqlite')
    const f = await fixture(path)
    const baseline = await f.sample()
    await f.services.adminStore.markBalanceReportCheckpoint(baseline.id)
    f.arkade.total += 100
    await f.sample()
    await f.services.adminStore.close()
    const restarted = await fixture(path)
    restarted.arkade.total += 300
    const current = await restarted.sample()
    const previous = await restarted.services.adminStore.previousBalanceReportCheckpoint(current.scope)
    expect(previous).toEqual(baseline)
    expect(checkpointChanges(previous!, current)?.[0]?.delta).toBe('300')
    expect(await restarted.services.adminStore.latestBalanceCheckpoint(current.scope)).toEqual(current)
    await restarted.services.adminStore.markBalanceReportCheckpoint(current.id)
    await restarted.services.adminStore.markBalanceReportCheckpoint(baseline.id)
    vi.mocked(restarted.services.ln!.getBalance).mockRejectedValueOnce(new Error('offline'))
    const incomplete = await restarted.sample()
    await restarted.services.adminStore.markBalanceReportCheckpoint(incomplete.id)
    expect(await restarted.services.adminStore.previousBalanceReportCheckpoint(current.scope)).toEqual(current)
    expect(await restarted.services.adminStore.latestBalanceCheckpoint(current.scope)).toEqual(incomplete)
    expect(await restarted.services.adminStore.previousBalanceReportCheckpoint('other provider')).toBeUndefined()
  })

  it('formats bounded loss warnings and sends none for a healthy checkpoint', async () => {
    const f = await fixture()
    const initial = await f.sample()
    expect(formatCheckpointWarning(initial, 'regtest')).toBeNull()
    f.arkade.total -= 10
    const loss = await f.sample()
    expect(formatCheckpointWarning(loss, 'regtest')).toBeNull()
    f.arkade.total -= 5
    const held = await f.sample()
    expect(formatCheckpointWarning(held, 'regtest')).toBe(
      [
        `⚠️ *POSSIBLE LOSS* · regtest · checkpoint #${held.id}`,
        `BTC: -15 sats (6,400 → 6,385) since checkpoint #${loss.id}`,
        'Fees, withdrawals and funds in flight are not reconciled. A RECOVERED follow-up is sent if the balance comes back.',
      ].join('\n'),
    )
    const large = formatCheckpointWarning(
      { ...held, unrecovered: Array.from({ length: 300 }, () => held.unrecovered![0]!) },
      'regtest',
    )!
    expect(large.length).toBeLessThanOrEqual(4000)
    expect(large).toContain('message cut')
  })

  it('posts nothing for a decrease that is back by the next checkpoint', async () => {
    const f = await fixture()
    const posted: string[] = []
    const notify = checkpointNotices('regtest', (text) => posted.push(text))
    notify(await f.sample())
    f.arkade.total -= 10
    notify(await f.sample())
    f.arkade.total += 10
    notify(await f.sample())
    expect(posted).toEqual([])
  })

  it('posts a recovery follow-up only for an alerted decrease that is back', async () => {
    const f = await fixture()
    const posted: string[] = []
    const notify = checkpointNotices('regtest', (text) => posted.push(text))
    notify(await f.sample())
    f.arkade.total -= 10
    const drop = await f.sample()
    notify(drop)
    const held = await f.sample()
    notify(held)
    expect(formatCheckpointRecovery(held, 'regtest')).toBeNull()
    f.arkade.total += 10
    const back = await f.sample()
    notify(back)
    expect(posted).toEqual([
      formatCheckpointWarning(held, 'regtest'),
      [
        `✅ *RECOVERED* · regtest · checkpoint #${back.id}`,
        `BTC: 0 sats (6,400 → 6,400) since before the drop at checkpoint #${drop.id}`,
        'The balance is back to its level before the drop; the cause is not reconciled.',
      ].join('\n'),
    ])
  })
})

describe('scheduled balance checkpoints', () => {
  it('queues loss alerts through the notifier while a sink remains unresolved', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const controller = new AbortController()
    let finish!: () => void
    let delivered!: () => void
    const messages: string[] = []
    const notifier = createNotifier({
      sinks: [
        {
          name: 'test',
          send: (text) => {
            messages.push(text)
            return new Promise<void>((resolve) => {
              delivered = resolve
            })
          },
        },
      ],
    })
    const run = withBalanceCheckpoints({
      checkpoint: f.sample,
      signal: controller.signal,
      log: vi.fn(),
      onCheckpoint: checkpointNotices('regtest', (text) => notifier.post(text)),
      run: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(messages).toEqual([])
    f.arkade.total -= 10
    await vi.advanceTimersByTimeAsync(60_000)
    expect(messages).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('BTC: -10 sats')
    expect(await f.services.adminStore.listBalanceCheckpoints(balanceCheckpointScope(f.services))).toHaveLength(3)
    controller.abort()
    finish()
    await run
    delivered()
    await notifier.flush()
    expect(notifier.stats().sent).toBe(1)
  })

  it('samples at startup and every minute, logs possible losses, and stops on abort', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const controller = new AbortController()
    const log = vi.fn()
    let finish!: () => void
    const run = withBalanceCheckpoints({
      checkpoint: f.sample,
      log,
      signal: controller.signal,
      run: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await f.services.adminStore.listBalanceCheckpoints(balanceCheckpointScope(f.services))).toHaveLength(1)
    f.arkade.total -= 10
    await vi.advanceTimersByTimeAsync(60_000)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('POSSIBLE LOSS'))
    f.arkade.total += 10
    await vi.advanceTimersByTimeAsync(60_000)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('RECOVERED: balance back at checkpoint'))
    controller.abort()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await f.services.adminStore.listBalanceCheckpoints(balanceCheckpointScope(f.services))).toHaveLength(3)
    finish()
    await run
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains errors, avoids overlapping samples, and drains before shutdown', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const log = vi.fn()
    let reject!: (error: Error) => void
    let finish!: () => void
    const checkpoint = vi.fn(
      () =>
        new Promise<never>((_, fail) => {
          reject = fail
        }),
    )
    const running = withBalanceCheckpoints({
      checkpoint,
      log,
      signal: controller.signal,
      run: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    finish()
    let done = false
    void running.then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    reject(new Error('database unavailable'))
    await running
    expect(log).toHaveBeenCalledWith('balance checkpoint failed: database unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })
})
