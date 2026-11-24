import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base64, hex } from '@scure/base'
import {
  buildOffchainTx,
  CSVMultisigTapscript,
  MultisigTapscript,
  SingleKey,
  Transaction,
  VtxoScript,
} from '@arkade-os/sdk'
import type { SQLExecutor } from '@arkade-os/sdk/repositories/sqlite'
import { sqliteExecutor } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { DirectFillAttempts, type DirectFillAttempt } from '@arkade-os/solver-arkade/arkade/directFillAttempts.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'

const solver = SingleKey.fromHex('11'.repeat(32))
const server = SingleKey.fromHex('22'.repeat(32))
const solverKey = await solver.xOnlyPublicKey()
const serverKey = await server.xOnlyPublicKey()
const tree = new VtxoScript([MultisigTapscript.encode({ pubkeys: [solverKey, serverKey] }).script])
const unroll = CSVMultisigTapscript.encode({ pubkeys: [serverKey], timelock: { type: 'blocks', value: 10n } })
const script = hex.encode(tree.pkScript)
const deposit = { txid: '01'.repeat(32), vout: 0 }
const funding = [{ txid: '02'.repeat(32), vout: 0, value: 5_000, script, assets: [] }]
const input = {
  parent: { kind: 'offer' as const, id: 'row' },
  deposit,
  funding,
  offerPkScript: script,
  proceedsScript: script,
}
const fixture = buildOffchainTx(
  [deposit, ...funding].map((point) => ({
    ...point,
    value: 5_000,
    tapLeafScript: tree.leaves[0]!,
    tapTree: tree.encode(),
  })),
  [{ script: tree.pkScript, amount: 10_000n }],
  unroll,
)
const encode = (tx: Transaction) => base64.encode(tx.toPSBT())
// Signed, as the fill path journals what the SDK hands the emulator.
const graph = {
  arkTx: encode(await solver.sign(fixture.arkTx, [0, 1])),
  checkpoints: await Promise.all(fixture.checkpoints.map(async (tx) => encode(await solver.sign(tx, [0])))),
}
const directories: string[] = []
const executors: ReturnType<typeof sqliteExecutor>[] = []
const database = () => {
  const dir = mkdtempSync(join(tmpdir(), 'direct-fill-journal-'))
  directories.push(dir)
  const path = join(dir, 'wallet.sqlite')
  const db = sqliteExecutor(path)
  executors.push(db)
  return { db, path }
}
afterEach(() => {
  for (const db of executors.splice(0)) db.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true })
})
const submitting = async (store: DirectFillAttempts): Promise<DirectFillAttempt> => {
  const prepared = await store.prepare(input)
  const sent: DirectFillAttempt = { ...prepared, phase: 'submitting', graph }
  expect(await store.change(prepared, sent)).toBe(true)
  store.finishInvocation(sent.key)
  return sent
}

describe('durable direct-fill attempts', () => {
  it('releases only its pin after a committed acknowledgement becomes readable again', async () => {
    const { db } = database()
    let failAck = false
    let readsToFail = 0
    const faulty: SQLExecutor = {
      ...db,
      get: async <T>(sql: string, params?: unknown[]): Promise<T | undefined> => {
        if (readsToFail > 0) {
          readsToFail--
          throw new Error('read unavailable')
        }
        const result = await db.get<T>(sql, params)
        if (failAck && sql.startsWith('UPDATE')) {
          failAck = false
          readsToFail = 1
          throw new Error('ack reply lost')
        }
        return result
      },
    }
    const pins = createReservationLedger()
    const store = await DirectFillAttempts.open(faulty, pins, 'wallet', script)
    const sent = await submitting(store)
    const settled: DirectFillAttempt = { ...sent, phase: 'settled', outcomeTxid: fixture.arkTx.id }
    await store.change(sent, settled)
    failAck = true
    await expect(store.acknowledge(settled)).rejects.toThrow('read unavailable')
    expect(pins.reserved().size).toBe(1)
    expect(await store.list()).toEqual([])
    expect(pins.reserved().size).toBe(0)
  })
  it('restores exact selected holds from a reopened SQLite file and leaves unrelated inputs usable', async () => {
    const { db, path } = database()
    const store = await DirectFillAttempts.open(db, createReservationLedger(), 'wallet', script)
    await submitting(store)
    const reopened = sqliteExecutor(path)
    executors.push(reopened)
    const pins = createReservationLedger()
    await DirectFillAttempts.open(reopened, pins, 'wallet', script)
    expect(pins.reserved()).toEqual(new Set([`${funding[0]!.txid}:0`]))
    expect(pins.reserved().has('unrelated:0')).toBe(false)
  })

  it('excludes an alternate parent and the same parent from reusing an unresolved deposit', async () => {
    const { db } = database()
    const store = await DirectFillAttempts.open(db, createReservationLedger(), 'wallet', script)
    await submitting(store)
    await expect(store.prepare({ ...input, parent: { kind: 'rfq', id: 'other' } })).rejects.toThrow('UNIQUE')
    await expect(store.prepare(input)).rejects.toThrow('UNIQUE')
    expect(await store.list()).toHaveLength(1)
  })

  it('retains a critical CAS that committed before its acknowledgement was lost', async () => {
    const { db } = database()
    let loseReply = true
    const faulty: SQLExecutor = {
      ...db,
      get: async <T>(sql: string, params?: unknown[]): Promise<T | undefined> => {
        const result = await db.get<T>(sql, params)
        if (loseReply && sql.startsWith('UPDATE')) {
          loseReply = false
          throw new Error('database reply lost')
        }
        return result
      },
    }
    const store = await DirectFillAttempts.open(faulty, createReservationLedger(), 'wallet', script)
    const prepared = await store.prepare(input)
    await expect(store.change(prepared, { ...prepared, phase: 'submitting', graph })).rejects.toThrow('reply lost')
    const pins = createReservationLedger()
    const restarted = await DirectFillAttempts.open(db, pins, 'wallet', script)
    expect((await restarted.list())[0]?.phase).toBe('submitting')
    expect(pins.reserved().size).toBe(1)
  })

  it('does not drop a counted sibling hold when acknowledging a never-invoked prepared attempt', async () => {
    const { db } = database()
    const store = await DirectFillAttempts.open(db, createReservationLedger(), 'wallet', script)
    await store.prepare(input)
    const pins = createReservationLedger()
    pins.reserve(funding)
    const restarted = await DirectFillAttempts.open(db, pins, 'wallet', script)
    const abandoned = (await restarted.list())[0]!
    expect(abandoned.phase).toBe('abandoned')
    expect(await restarted.acknowledge(abandoned)).toBe(true)
    expect(pins.reserved().size).toBe(1)
  })

  it.each(['wallet identity', 'graph', 'outcome', 'deposit script', 'proceeds script'])(
    'fails closed on corrupted %s before admitting work',
    async (field) => {
      const { db } = database()
      const store = await DirectFillAttempts.open(db, createReservationLedger(), 'wallet', script)
      const sent = await submitting(store)
      if (field === 'graph') {
        await db.run('UPDATE direct_fill_attempt SET body = ?', [
          JSON.stringify({ ...sent, graph: { ...graph, checkpoints: [] } }),
        ])
      } else if (field === 'proceeds script') {
        await db.run('UPDATE direct_fill_attempt SET body = ?', [
          JSON.stringify({ ...sent, proceedsScript: '5120' + 'ff'.repeat(32) }),
        ])
      } else if (field === 'deposit script') {
        await db.run('UPDATE direct_fill_attempt SET body = ?', [
          JSON.stringify({ ...sent, offerPkScript: '5120' + 'ff'.repeat(32) }),
        ])
      } else if (field === 'outcome') {
        await db.run('UPDATE direct_fill_attempt SET body = ?', [
          JSON.stringify({ ...sent, phase: 'settled', outcomeTxid: 'ff'.repeat(32) }),
        ])
      }
      await expect(
        DirectFillAttempts.open(
          db,
          createReservationLedger(),
          field === 'wallet identity' ? 'different' : 'wallet',
          script,
        ),
      ).rejects.toThrow()
    },
  )

  it('does not acknowledge or release an unresolved attempt', async () => {
    const { db } = database()
    const pins = createReservationLedger()
    const store = await DirectFillAttempts.open(db, pins, 'wallet', script)
    const sent = await submitting(store)
    await expect(store.acknowledge(sent)).rejects.toThrow('before resolution')
    expect(pins.reserved().size).toBe(1)
  })
})
