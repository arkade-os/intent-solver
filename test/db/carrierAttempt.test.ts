/**
 * The PRIVATE carrier attempt checkpoint — the only durable record that tells
 * "never submitted" from "possibly submitted" after a restart. Every write is a
 * single-statement CAS over the exact previous envelope AND the parent row's
 * state, because `SqlDriver.transaction` is best effort on D1: a
 * read-modify-save would let two drivers both believe they hold the attempt,
 * and what that buys is a second submit of one fill.
 */

import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import {
  AssetRfqSwapStore,
  type AssetRfqCarrierTerms,
  type AssetRfqQuoteRecord,
  type AssetRfqSwapState,
} from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import {
  decodeCarrierAttempt,
  encodeCarrierAttempt,
  type CarrierAttempt,
} from '@arkade-os/solver-corridors/db/carrierAttempt.js'
import { assetRfqQuotePayload, assetRfqStatusPayload } from '@arkade-os/solver-corridors/wire/assetRfqPayloads.js'
import { projectAssetRfq } from '@arkade-os/solver-corridors/corridors/assetRfq.js'

const ASSET_A = `${'aa'.repeat(32)}0100`
const FILL_TXID = 'f'.repeat(64)

const RECYCLE: AssetRfqCarrierTerms = {
  mode: 'recycle',
  quoteId: 'q-1',
  physicalSats: 330n,
  loanSats: 329n,
  receiptSats: 1n,
  serviceFareSats: 4n,
  pricedSats: 5n,
  expiresAt: 5_000,
}

const PURCHASE: AssetRfqCarrierTerms = {
  mode: 'purchase',
  physicalSats: 330n,
  loanSats: 0n,
  receiptSats: 0n,
  serviceFareSats: 0n,
  pricedSats: 330n,
  expiresAt: 5_000,
}

const quote = (over: Partial<AssetRfqQuoteRecord> = {}): AssetRfqQuoteRecord => ({
  id: 'swap-1',
  rfqId: 'a'.repeat(64),
  pair: `arkade:BTC->arkade:${ASSET_A}`,
  fromAssetId: null,
  fromAmount: 100_000_000n,
  toAssetId: ASSET_A,
  toAmount: 99_500_000_000n,
  makerPkScript: `5120${'c'.repeat(64)}`,
  makerPublicKey: 'b'.repeat(64),
  offerPkScript: `5120${'d'.repeat(64)}`,
  offerAddress: 'ark1qoffer',
  solverPubkey: 'e'.repeat(64),
  validUntil: 2_000,
  carrierTerms: RECYCLE,
  ...over,
})

/** What the adapter pins before it asks Taxi for anything: the exact operation,
 * the deposit it is about, and the solver inputs it reserved for it. */
const SNAPSHOT = {
  operationId: 'op-1',
  deposit: { txid: 'a'.repeat(64), vout: 0 },
  inputs: [{ txid: 'b'.repeat(64), vout: 1, sats: '330' }],
  provider: 'taxi-1',
  feeSats: '4',
  deadline: 5_000,
}

const BINDING = { fillId: 'fill-1', graphRoot: 'c'.repeat(64) }

let clock = 1_000
const stores: AssetRfqSwapStore[] = []
const dirs: string[] = []

/** Native handles closed per test: an unclosed better-sqlite3 database is
 * destructed against a dead Node environment and takes the worker with it. */
const open = async (driver: SqlDriver | string = ':memory:'): Promise<AssetRfqSwapStore> => {
  const store = await AssetRfqSwapStore.open(driver, () => clock)
  stores.push(store)
  return store
}

const tempDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'carrier-attempt-'))
  dirs.push(dir)
  return join(dir, 'solver.db')
}

afterEach(async () => {
  clock = 1_000
  while (stores.length) await stores.pop()!.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const rowIn = async (
  store: AssetRfqSwapStore,
  state: AssetRfqSwapState,
  over: Partial<AssetRfqQuoteRecord> = {},
): Promise<string> => {
  const { id } = await store.insertQuote(quote(over))
  if (state === 'quoted') return id
  if (state === 'refused') {
    await store.fail(id, 'quoted', 'lapsed')
    return id
  }
  await store.transition(id, 'quoted', 'funded')
  if (state === 'funded') return id
  await store.transition(id, 'funded', 'filling')
  if (state === 'filling') return id
  if (state === 'stuck') {
    await store.fail(id, 'filling', 'outcome unknown')
    return id
  }
  await store.transition(id, 'filling', 'filled', { fill_txid: FILL_TXID })
  return id
}

/** A `filling` row carrying a checkpoint at the named phase. */
const attemptAt = async (
  store: AssetRfqSwapStore,
  phase: 'prepared' | 'quoted' | 'submitting' | 'settled',
  over: Partial<AssetRfqQuoteRecord> = {},
): Promise<string> => {
  const id = await rowIn(store, 'filling', over)
  await store.prepareCarrierAttempt(id, SNAPSHOT)
  if (phase === 'prepared') return id
  await store.bindCarrierAttempt(id, (await store.readCarrierAttempt(id))!, BINDING)
  if (phase === 'quoted') return id
  await store.markCarrierAttemptSubmitting(id, (await store.readCarrierAttempt(id))!)
  if (phase === 'submitting') return id
  await store.settleCarrierAttempt(id, (await store.readCarrierAttempt(id))!, FILL_TXID)
  return id
}

const other = (n: number): Partial<AssetRfqQuoteRecord> => ({
  id: `swap-${n}`,
  rfqId: String(n).padEnd(64, '0'),
  offerPkScript: `5120${String(n).padEnd(64, 'd')}`,
})

describe('the private column', () => {
  it('holds nothing for a row that has attempted nothing', async () => {
    const store = await open()
    expect(await store.readCarrierAttempt(await rowIn(store, 'filling'))).toBeNull()
    await expect(store.readCarrierAttempt('nope')).rejects.toThrow(/no asset rfq swap/)
  })

  /** The pre-column shape this build shipped, down to the carrier terms. */
  const PRE_COLUMN = `CREATE TABLE asset_rfq_swap (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    rfq_id TEXT NOT NULL, pair TEXT NOT NULL, from_asset_id TEXT, from_amount TEXT NOT NULL,
    to_asset_id TEXT, to_amount TEXT NOT NULL, maker_pk_script TEXT NOT NULL, maker_public_key TEXT NOT NULL,
    offer_pk_script TEXT NOT NULL, offer_address TEXT NOT NULL, solver_pubkey TEXT NOT NULL,
    valid_until INTEGER NOT NULL, deposit_txid TEXT, deposit_vout INTEGER, fill_txid TEXT, failure_reason TEXT,
    quote_implied_mantissa TEXT, quote_implied_scale INTEGER, quote_gives_base INTEGER,
    fill_price_mantissa TEXT, fill_price_scale INTEGER, carrier_terms TEXT
  )`

  it('arrives by migration on a database that predates it, leaving old rows unbackfilled', async () => {
    const file = tempDb()
    const legacy = new Database(file)
    legacy.exec(PRE_COLUMN)
    legacy.exec(
      `INSERT INTO asset_rfq_swap (
        id, state, created_at, updated_at, rfq_id, pair, from_asset_id, from_amount, to_asset_id, to_amount,
        maker_pk_script, maker_public_key, offer_pk_script, offer_address, solver_pubkey, valid_until
      ) VALUES ('legacy', 'filling', 1, 1, '${'c'.repeat(64)}', 'arkade:BTC->arkade:USDA', NULL, '100',
        '${'b'.repeat(68)}', '200', '3', '4', '5', 'ark1q', '6', 9)`,
    )
    legacy.close()

    const store = await open(file)
    const columns = (await store.driver.all<{ name: string }>(`PRAGMA table_info(asset_rfq_swap)`)).map((c) => c.name)
    expect(columns).toContain('carrier_attempt')
    expect(await store.readCarrierAttempt('legacy')).toBeNull()
    expect((await store.get('legacy')).carrierTerms).toBeNull()

    const id = await rowIn(store, 'filling')
    expect(await store.prepareCarrierAttempt(id, SNAPSHOT)).toBe(true)
    expect(await store.readCarrierAttempt(id)).toEqual({ phase: 'prepared', snapshot: SNAPSHOT })
  })

  it('leaves the public row, the status payload and the quote profile byte-identical', async () => {
    const store = await open()
    const id = await rowIn(store, 'filling')
    const before = await store.get(id)

    expect(await store.prepareCarrierAttempt(id, SNAPSHOT)).toBe(true)

    const after = await store.get(id)
    expect(after).toEqual(before)
    expect(Object.keys(after)).not.toContain('carrierAttempt')
    expect(assetRfqStatusPayload(after, before.rfqId)).toEqual(assetRfqStatusPayload(before, before.rfqId))
    expect(assetRfqQuotePayload(after, before.rfqId)).toEqual(assetRfqQuotePayload(before, before.rfqId))
    expect(JSON.stringify(assetRfqQuotePayload(after, before.rfqId))).not.toContain('op-1')
    expect(JSON.stringify(projectAssetRfq(after))).not.toContain('op-1')
  })

  it.each([
    ['an unknown version', '{"v":2,"phase":"prepared","snapshot":{}}'],
    ['no version at all', '{"phase":"prepared","snapshot":{}}'],
    ['an unknown phase', '{"v":1,"phase":"posted","snapshot":{}}'],
    ['an unknown key', '{"v":1,"phase":"prepared","snapshot":{},"extra":1}'],
    ['a prepared attempt already carrying a binding', '{"v":1,"phase":"prepared","snapshot":{},"binding":{}}'],
    ['a quoted attempt with no binding', '{"v":1,"phase":"quoted","snapshot":{}}'],
    ['a submitting attempt with no binding', '{"v":1,"phase":"submitting","snapshot":{}}'],
    ['a settled attempt with no fill txid', '{"v":1,"phase":"settled","snapshot":{},"binding":{}}'],
    ['a cancelling attempt with no binding', '{"v":1,"phase":"cancelling","snapshot":{}}'],
    ['a cancelled attempt with no binding', '{"v":1,"phase":"cancelled","snapshot":{}}'],
    [
      'a fill txid on an unsettled attempt',
      `{"v":1,"phase":"quoted","snapshot":{},"binding":{},"fill_txid":"${FILL_TXID}"}`,
    ],
    ['a non-canonical fill txid', '{"v":1,"phase":"settled","snapshot":{},"binding":{},"fill_txid":"nope"}'],
    ['a snapshot that is not an object', '{"v":1,"phase":"prepared","snapshot":[]}'],
    ['a missing snapshot', '{"v":1,"phase":"prepared"}'],
    ['an empty blob', ''],
    ['a truncated blob', '{"v":1,"phase":'],
  ])('refuses %s on read rather than half-reading it', async (_why, stored) => {
    const store = await open()
    const id = await rowIn(store, 'filling')
    await store.driver.run(`UPDATE asset_rfq_swap SET carrier_attempt = ? WHERE id = ?`, [stored, id])
    await expect(store.readCarrierAttempt(id)).rejects.toThrow()
    await expect(store.listUnresolvedCarrierAttempts()).rejects.toThrow()
  })

  it.each([
    ['a bigint amount, which JSON cannot carry', { sats: 1n }],
    ['an undefined field, which JSON.stringify would silently drop', { operationId: undefined }],
    ['a function', { sign: () => 1 }],
    ['a non-finite number', { ratio: Number.POSITIVE_INFINITY }],
    ['a number past exact integer range', { sats: 2 ** 53 }],
    ['a Date, which is a live object rather than JSON', { at: new Date(0) }],
    ['a live instance', { key: new Uint8Array(2) }],
    ['an array at the top', []],
    ['a primitive', 'snapshot'],
  ] as [string, unknown][])('refuses to capture %s', async (_why, snapshot) => {
    const store = await open()
    const id = await rowIn(store, 'filling')
    await expect(store.prepareCarrierAttempt(id, snapshot)).rejects.toThrow()
    expect(await store.readCarrierAttempt(id)).toBeNull()
  })
})

describe('prepared — the checkpoint written before the first quote POST', () => {
  it('writes once on a filling recycle row and reads back exactly', async () => {
    const store = await open()
    const id = await rowIn(store, 'filling')
    expect(await store.prepareCarrierAttempt(id, SNAPSHOT)).toBe(true)
    expect(await store.readCarrierAttempt(id)).toEqual({ phase: 'prepared', snapshot: SNAPSHOT })
  })

  it('survives the process that wrote it', async () => {
    const file = tempDb()
    const first = await open(file)
    const id = await attemptAt(first, 'quoted')
    await stores.pop()!.close()

    const reopened = await open(file)
    expect(await reopened.readCarrierAttempt(id)).toEqual({ phase: 'quoted', snapshot: SNAPSHOT, binding: BINDING })
  })

  it('refuses a second prepare, so a restart cannot replace the snapshot', async () => {
    const store = await open()
    const id = await attemptAt(store, 'prepared')
    expect(await store.prepareCarrierAttempt(id, { operationId: 'op-2' })).toBe(false)
    expect((await store.readCarrierAttempt(id))?.snapshot).toEqual(SNAPSHOT)
  })

  it("captures the caller's object before the first await, so a later mutation cannot reach it", async () => {
    const store = await open()
    const id = await rowIn(store, 'filling')
    const snapshot = { operationId: 'op-1', inputs: [{ txid: 'b'.repeat(64), vout: 1 }] }

    const written = store.prepareCarrierAttempt(id, snapshot)
    snapshot.operationId = 'op-2'
    snapshot.inputs[0]!.vout = 9
    snapshot.inputs.push({ txid: 'c'.repeat(64), vout: 2 })

    expect(await written).toBe(true)
    expect((await store.readCarrierAttempt(id))?.snapshot).toEqual({
      operationId: 'op-1',
      inputs: [{ txid: 'b'.repeat(64), vout: 1 }],
    })
  })

  it('refuses a purchase row, which buys its carrier outright and asks Taxi for nothing', async () => {
    const store = await open()
    const id = await rowIn(store, 'filling', { carrierTerms: PURCHASE })
    await expect(store.prepareCarrierAttempt(id, SNAPSHOT)).rejects.toThrow(/recycle/)
    expect(await store.readCarrierAttempt(id)).toBeNull()
  })

  it("writes one on a receiver-paid row, whose fill the payee's own Taxi funds", async () => {
    const store = await open()
    const id = await rowIn(store, 'filling', {
      carrierTerms: {
        ...RECYCLE,
        mode: 'recycle_receiver',
        loanSats: 330n,
        receiptSats: 0n,
        serviceFareSats: 0n,
        pricedSats: 0n,
        taxiUrl: 'https://taxi.example',
        taxiKey: 'a1'.repeat(32),
      },
    })
    expect(await store.prepareCarrierAttempt(id, SNAPSHOT)).toBe(true)
    expect(await store.readCarrierAttempt(id)).toEqual({ phase: 'prepared', snapshot: SNAPSHOT })
  })

  it('refuses a legacy row that named no mode', async () => {
    const store = await open()
    const id = await rowIn(store, 'filling', { carrierTerms: undefined })
    await expect(store.prepareCarrierAttempt(id, SNAPSHOT)).rejects.toThrow(/recycle/)
    expect(await store.readCarrierAttempt(id)).toBeNull()
  })

  it.each(['quoted', 'funded', 'filled', 'stuck', 'refused'] as const)(
    'refuses to start an attempt on a %s row, which is not a fill in flight',
    async (state) => {
      const store = await open()
      const id = await rowIn(store, state)
      expect(await store.prepareCarrierAttempt(id, SNAPSHOT)).toBe(false)
      expect(await store.readCarrierAttempt(id)).toBeNull()
    },
  )
})

describe('quoted — the binding written after the quote id and graph are verified', () => {
  it('binds once and leaves the snapshot as written', async () => {
    const store = await open()
    const id = await attemptAt(store, 'prepared')
    const prepared = (await store.readCarrierAttempt(id))!

    expect(await store.bindCarrierAttempt(id, prepared, BINDING)).toBe(true)
    expect(await store.readCarrierAttempt(id)).toEqual({ phase: 'quoted', snapshot: SNAPSHOT, binding: BINDING })
  })

  it('refuses a stale checkpoint and changes nothing', async () => {
    const store = await open()
    const id = await attemptAt(store, 'prepared')
    const prepared = (await store.readCarrierAttempt(id))!
    await store.bindCarrierAttempt(id, prepared, BINDING)

    expect(await store.bindCarrierAttempt(id, prepared, { fillId: 'fill-2' })).toBe(false)
    expect((await store.readCarrierAttempt(id))?.binding).toEqual(BINDING)
  })

  it.each(['quoted', 'submitting', 'settled'] as const)(
    'refuses to rebind a %s attempt, whose binding is already spoken for',
    async (phase) => {
      const store = await open()
      const id = await attemptAt(store, phase)
      const attempt = (await store.readCarrierAttempt(id))!
      await expect(store.bindCarrierAttempt(id, attempt, { fillId: 'fill-2' })).rejects.toThrow(/prepared/)
      expect((await store.readCarrierAttempt(id))?.binding).toEqual(BINDING)
    },
  )

  it('refuses to bind once the parent row has left filling', async () => {
    const store = await open()
    const id = await attemptAt(store, 'prepared')
    const prepared = (await store.readCarrierAttempt(id))!
    await store.fail(id, 'filling', 'outcome unknown')

    expect(await store.bindCarrierAttempt(id, prepared, BINDING)).toBe(false)
    expect(await store.readCarrierAttempt(id)).toEqual({ phase: 'prepared', snapshot: SNAPSHOT })
  })
})

describe('submitting — the marker written before the submit POST', () => {
  it('moves a quoted attempt and keeps its binding', async () => {
    const store = await open()
    const id = await attemptAt(store, 'quoted')
    const quoted = (await store.readCarrierAttempt(id))!

    expect(await store.markCarrierAttemptSubmitting(id, quoted)).toBe(true)
    expect(await store.readCarrierAttempt(id)).toEqual({ phase: 'submitting', snapshot: SNAPSHOT, binding: BINDING })
  })

  it('refuses a prepared attempt, which has no verified quote to submit', async () => {
    const store = await open()
    const id = await attemptAt(store, 'prepared')
    const prepared = (await store.readCarrierAttempt(id))!
    await expect(store.markCarrierAttemptSubmitting(id, prepared)).rejects.toThrow(/quoted/)
    expect((await store.readCarrierAttempt(id))?.phase).toBe('prepared')
  })

  it('refuses a stale checkpoint and changes nothing', async () => {
    const store = await open()
    const id = await attemptAt(store, 'quoted')
    const quoted = (await store.readCarrierAttempt(id))!
    await store.markCarrierAttemptSubmitting(id, quoted)

    expect(await store.markCarrierAttemptSubmitting(id, quoted)).toBe(false)
    expect((await store.readCarrierAttempt(id))?.phase).toBe('submitting')
  })
})

describe('settled — the adapter says which transaction, and proves it elsewhere', () => {
  it('records the canonical fill txid it was handed', async () => {
    const store = await open()
    const id = await attemptAt(store, 'submitting')
    const submitting = (await store.readCarrierAttempt(id))!

    expect(await store.settleCarrierAttempt(id, submitting, FILL_TXID)).toBe(true)
    expect(await store.readCarrierAttempt(id)).toEqual({
      phase: 'settled',
      snapshot: SNAPSHOT,
      binding: BINDING,
      fillTxid: FILL_TXID,
    })
  })

  it.each(['', 'nope', 'F'.repeat(64), 'a'.repeat(63)])('refuses the non-canonical txid %j', async (txid) => {
    const store = await open()
    const id = await attemptAt(store, 'submitting')
    const submitting = (await store.readCarrierAttempt(id))!
    await expect(store.settleCarrierAttempt(id, submitting, txid)).rejects.toThrow(/txid/)
    expect((await store.readCarrierAttempt(id))?.phase).toBe('submitting')
  })

  it.each(['prepared', 'quoted'] as const)(
    'refuses to settle a %s attempt, which was never submitted',
    async (phase) => {
      const store = await open()
      const id = await attemptAt(store, phase)
      const attempt = (await store.readCarrierAttempt(id))!
      await expect(store.settleCarrierAttempt(id, attempt, FILL_TXID)).rejects.toThrow(/submitting/)
      expect((await store.readCarrierAttempt(id))?.phase).toBe(phase)
    },
  )

  it('refuses to settle once the parent row has left filling', async () => {
    const store = await open()
    const id = await attemptAt(store, 'submitting')
    const submitting = (await store.readCarrierAttempt(id))!
    await store.fail(id, 'filling', 'outcome unknown')

    expect(await store.settleCarrierAttempt(id, submitting, FILL_TXID)).toBe(false)
    expect((await store.readCarrierAttempt(id))?.phase).toBe('submitting')
  })

  it('leaves the parent filling -> filled transition to the ordinary path', async () => {
    const store = await open()
    const id = await attemptAt(store, 'settled')
    expect((await store.get(id)).state).toBe('filling')
    expect(await store.transition(id, 'filling', 'filled', { fill_txid: FILL_TXID })).toBe(true)
    expect((await store.readCarrierAttempt(id))?.phase).toBe('settled')
  })
})

describe('the never-submitted terminal — the only filling -> refused there is', () => {
  it.each(['prepared', 'quoted'] as const)('commits the %s attempt and the parent row together', async (phase) => {
    const store = await open()
    const id = await attemptAt(store, phase)
    const attempt = (await store.readCarrierAttempt(id))!
    clock = 9_000

    expect(await store.refuseNeverSubmittedCarrierAttempt(id, attempt, 'taxi refused the quote')).toBe(true)
    expect(await store.get(id)).toMatchObject({
      state: 'refused',
      failureReason: 'taxi refused the quote',
      updatedAt: 9_000,
    })
    expect(await store.readCarrierAttempt(id)).toEqual({ ...attempt, phase: 'not_submitted' })
    expect((await store.history(id)).map((e) => e.to)).toEqual(['quoted', 'funded', 'filling', 'refused'])
  })

  it('refuses a stale checkpoint, moving neither the attempt nor the row', async () => {
    const store = await open()
    const id = await attemptAt(store, 'prepared')
    const prepared = (await store.readCarrierAttempt(id))!
    await store.bindCarrierAttempt(id, prepared, BINDING)

    expect(await store.refuseNeverSubmittedCarrierAttempt(id, prepared, 'taxi refused')).toBe(false)
    expect((await store.get(id)).state).toBe('filling')
    expect((await store.readCarrierAttempt(id))?.phase).toBe('quoted')
  })

  it.each(['submitting', 'settled'] as const)(
    'refuses a %s attempt, which may already have spent the inputs',
    async (phase) => {
      const store = await open()
      const id = await attemptAt(store, phase)
      const attempt = (await store.readCarrierAttempt(id))!
      await expect(store.refuseNeverSubmittedCarrierAttempt(id, attempt, 'give it up')).rejects.toThrow(
        /never.submitted/,
      )
      expect((await store.get(id)).state).toBe('filling')
      expect((await store.readCarrierAttempt(id))?.phase).toBe(phase)
    },
  )

  /** A `stuck` row is one a human has to resolve, and an attempt that was
   * ambiguous when it got there does not become clean afterwards. */
  it('will not turn a parent that has already gone stuck into a refusal', async () => {
    const store = await open()
    const id = await attemptAt(store, 'prepared')
    const prepared = (await store.readCarrierAttempt(id))!
    await store.fail(id, 'filling', 'outcome unknown')

    expect(await store.refuseNeverSubmittedCarrierAttempt(id, prepared, 'taxi refused')).toBe(false)
    expect(await store.get(id)).toMatchObject({ state: 'stuck', failureReason: 'outcome unknown' })
    expect((await store.readCarrierAttempt(id))?.phase).toBe('prepared')
  })

  it('refuses to replay itself onto an already-terminal attempt', async () => {
    const store = await open()
    const id = await attemptAt(store, 'prepared')
    const prepared = (await store.readCarrierAttempt(id))!
    await store.refuseNeverSubmittedCarrierAttempt(id, prepared, 'taxi refused')

    expect(await store.refuseNeverSubmittedCarrierAttempt(id, prepared, 'again')).toBe(false)
    const terminal = (await store.readCarrierAttempt(id))!
    await expect(store.refuseNeverSubmittedCarrierAttempt(id, terminal, 'again')).rejects.toThrow(/never.submitted/)
    expect(await store.prepareCarrierAttempt(id, SNAPSHOT)).toBe(false)
    expect(await store.bindCarrierAttempt(id, prepared, BINDING)).toBe(false)
  })

  it('does not make the generic filling -> refused edge legal', async () => {
    const store = await open()
    const id = await rowIn(store, 'filling')
    await expect(store.transition(id, 'filling', 'refused')).rejects.toThrow(/illegal transition/)
    await expect(store.transition(id, 'filling', 'refused', { failure_reason: 'x' })).rejects.toThrow(/illegal/)
    await store.fail(id, 'filling', 'outcome unknown')
    expect((await store.get(id)).state).toBe('stuck')
  })

  /** The state is committed by the time the event insert runs, so a failing
   * event log must stay loud without undoing it or re-opening the fill. */
  it('leaves the terminal state durable when the event write fails', async () => {
    let breakEvents = false
    const inner = betterSqliteDriver(':memory:')
    const guarded: SqlDriver = {
      ...inner,
      run: async (sql, params) => {
        if (breakEvents && sql.includes('asset_rfq_swap_event')) throw new Error('event log unavailable')
        return inner.run(sql, params)
      },
    }
    const store = await open(guarded)
    const id = await attemptAt(store, 'prepared')
    const prepared = (await store.readCarrierAttempt(id))!
    breakEvents = true

    await expect(store.refuseNeverSubmittedCarrierAttempt(id, prepared, 'taxi refused')).rejects.toThrow(
      /event log unavailable/,
    )
    breakEvents = false
    expect(await store.get(id)).toMatchObject({ state: 'refused', failureReason: 'taxi refused' })
    expect((await store.readCarrierAttempt(id))?.phase).toBe('not_submitted')
    expect(await store.bindCarrierAttempt(id, prepared, BINDING)).toBe(false)
  })
})

describe('the unattempted terminal — filling -> refused while no attempt was ever written', () => {
  it('refuses a filling carrier row with no attempt, and fences off a late prepare', async () => {
    const store = await open()
    const id = await rowIn(store, 'filling')
    clock = 9_000

    expect(await store.refuseUnattemptedCarrierFill(id, 'not filled: taxi unreachable')).toBe(true)
    expect(await store.get(id)).toMatchObject({
      state: 'refused',
      failureReason: 'not filled: taxi unreachable',
      updatedAt: 9_000,
    })
    expect(await store.readCarrierAttempt(id)).toBeNull()
    expect((await store.history(id)).map((e) => e.to)).toEqual(['quoted', 'funded', 'filling', 'refused'])
    expect(await store.prepareCarrierAttempt(id, SNAPSHOT)).toBe(false)
  })

  it.each(['prepared', 'quoted', 'submitting', 'settled'] as const)('leaves a row with a %s attempt', async (phase) => {
    const store = await open()
    const id = await attemptAt(store, phase)
    expect(await store.refuseUnattemptedCarrierFill(id, 'not filled')).toBe(false)
    expect((await store.get(id)).state).toBe('filling')
    expect((await store.readCarrierAttempt(id))?.phase).toBe(phase)
  })

  it('leaves a row that is not filling, or not a carrier fill', async () => {
    const store = await open()
    const stuck = await rowIn(store, 'stuck')
    expect(await store.refuseUnattemptedCarrierFill(stuck, 'not filled')).toBe(false)
    const legacy = await rowIn(store, 'filling', { ...other(2), carrierTerms: undefined })
    expect(await store.refuseUnattemptedCarrierFill(legacy, 'not filled')).toBe(false)
    const purchase = await rowIn(store, 'filling', { ...other(3), carrierTerms: PURCHASE })
    expect(await store.refuseUnattemptedCarrierFill(purchase, 'not filled')).toBe(false)
    expect((await store.get(stuck)).state).toBe('stuck')
    expect((await store.get(legacy)).state).toBe('filling')
    expect((await store.get(purchase)).state).toBe('filling')
  })
})

describe('cancel-by-conflict — the conflict spend recorded before it is sent', () => {
  it('accepts the two new phases through the codec', () => {
    for (const phase of ['cancelling', 'cancelled'] as const)
      expect(decodeCarrierAttempt(encodeCarrierAttempt({ phase, snapshot: SNAPSHOT, binding: BINDING })).phase).toBe(
        phase,
      )
  })

  const CONFLICT = { txid: 'e'.repeat(64), ark_tx: 'cHNidP8=' }
  const cancelling = (attempt: CarrierAttempt): CarrierAttempt => ({
    ...attempt,
    phase: 'cancelling',
    binding: { ...attempt.binding, conflict: CONFLICT },
  })
  const cancellingAt = async (store: AssetRfqSwapStore, over: Partial<AssetRfqQuoteRecord> = {}) => {
    const id = await attemptAt(store, 'submitting', over)
    const submitting = (await store.readCarrierAttempt(id))!
    expect(await store.cancelCarrierAttempt(id, submitting, cancelling(submitting))).toBe(true)
    return { id, attempt: (await store.readCarrierAttempt(id))! }
  }

  it('moves a submitting attempt to cancelling, extending its binding and leaving the row filling', async () => {
    const store = await open()
    const { id, attempt } = await cancellingAt(store)
    expect(attempt).toEqual({ phase: 'cancelling', snapshot: SNAPSHOT, binding: { ...BINDING, conflict: CONFLICT } })
    expect((await store.get(id)).state).toBe('filling')
  })

  it.each(['prepared', 'quoted', 'settled'] as const)('refuses to cancel a %s attempt', async (phase) => {
    const store = await open()
    const id = await attemptAt(store, phase)
    const attempt = (await store.readCarrierAttempt(id))!
    await expect(store.cancelCarrierAttempt(id, attempt, cancelling(attempt))).rejects.toThrow(/only a submit/)
    expect((await store.readCarrierAttempt(id))?.phase).toBe(phase)
  })

  it.each([
    ['replaces the snapshot', (a: CarrierAttempt) => ({ ...cancelling(a), snapshot: { operationId: 'op-2' } })],
    ['drops the fill binding', (a: CarrierAttempt) => ({ ...cancelling(a), binding: { conflict: CONFLICT } })],
  ])('refuses a cancelling write that %s', async (_why, next) => {
    const store = await open()
    const id = await attemptAt(store, 'submitting')
    const submitting = (await store.readCarrierAttempt(id))!
    await expect(store.cancelCarrierAttempt(id, submitting, next(submitting))).rejects.toThrow(/cancelling/)
    expect((await store.readCarrierAttempt(id))?.phase).toBe('submitting')
  })

  it('refuses a stale checkpoint, so two workers cannot record two conflicts', async () => {
    const store = await open()
    const id = await attemptAt(store, 'submitting')
    const submitting = (await store.readCarrierAttempt(id))!
    await store.cancelCarrierAttempt(id, submitting, cancelling(submitting))
    const second = { ...cancelling(submitting), binding: { ...BINDING, conflict: { txid: '9'.repeat(64) } } }
    expect(await store.cancelCarrierAttempt(id, submitting, second)).toBe(false)
    expect((await store.readCarrierAttempt(id))?.binding?.conflict).toEqual(CONFLICT)
  })

  it('commits cancelled and the refused parent together', async () => {
    const store = await open()
    const { id, attempt } = await cancellingAt(store)
    clock = 9_000

    expect(await store.refuseCancelledCarrierAttempt(id, attempt, 'conflict landed')).toBe(true)
    expect(await store.get(id)).toMatchObject({ state: 'refused', failureReason: 'conflict landed', updatedAt: 9_000 })
    expect(await store.readCarrierAttempt(id)).toEqual({ ...attempt, phase: 'cancelled' })
    expect((await store.history(id)).map((e) => e.to)).toEqual(['quoted', 'funded', 'filling', 'refused'])
    expect(await store.refuseCancelledCarrierAttempt(id, attempt, 'again')).toBe(false)
  })

  it.each(['prepared', 'quoted', 'submitting', 'settled'] as const)(
    'refuses the cancelled terminal for a %s attempt',
    async (phase) => {
      const store = await open()
      const id = await attemptAt(store, phase)
      const attempt = (await store.readCarrierAttempt(id))!
      await expect(store.refuseCancelledCarrierAttempt(id, attempt, 'x')).rejects.toThrow(/not cancelling/)
      expect((await store.get(id)).state).toBe('filling')
    },
  )

  it('will not refuse a parent that has already gone stuck', async () => {
    const store = await open()
    const { id, attempt } = await cancellingAt(store)
    await store.fail(id, 'filling', 'outcome unknown')

    expect(await store.refuseCancelledCarrierAttempt(id, attempt, 'conflict landed')).toBe(false)
    expect((await store.readCarrierAttempt(id))?.phase).toBe('cancelling')
  })

  it('settles a cancelling attempt whose fill won the race', async () => {
    const store = await open()
    const { id, attempt } = await cancellingAt(store)
    expect(await store.settleCarrierAttempt(id, attempt, FILL_TXID)).toBe(true)
    expect(await store.readCarrierAttempt(id)).toEqual({ ...attempt, phase: 'settled', fillTxid: FILL_TXID })
  })

  it('never re-pins a cancelled attempt after a restart, and still re-pins a cancelling one', async () => {
    const store = await open()
    const live = await cancellingAt(store, other(1))
    const done = await cancellingAt(store, other(2))
    await store.refuseCancelledCarrierAttempt(done.id, done.attempt, 'conflict landed')

    expect((await store.listUnresolvedCarrierAttempts()).map((r) => r.row.id)).toEqual([live.id])
  })

  it('lets exactly one of two connections win the cancelled terminal', async () => {
    const file = tempDb()
    const a = await open(file)
    const b = await open(file)
    const { id, attempt } = await cancellingAt(a)

    const won = await Promise.all([
      a.refuseCancelledCarrierAttempt(id, attempt, 'conflict landed'),
      b.refuseCancelledCarrierAttempt(id, attempt, 'conflict landed'),
    ])
    expect(won.filter(Boolean)).toHaveLength(1)
  })
})

describe('restart enumeration — every attempt that can still hold liability', () => {
  it('lists the ambiguous and the stuck, and excludes what is proven closed', async () => {
    const store = await open()
    const inFlight = await attemptAt(store, 'submitting', other(1))

    const stuck = await attemptAt(store, 'quoted', other(2))
    await store.fail(stuck, 'filling', 'outcome unknown')

    const unpaired = await attemptAt(store, 'settled', other(3))

    const paired = await attemptAt(store, 'settled', other(4))
    await store.transition(paired, 'filling', 'filled', { fill_txid: FILL_TXID })

    const closed = await attemptAt(store, 'prepared', other(5))
    await store.refuseNeverSubmittedCarrierAttempt(closed, (await store.readCarrierAttempt(closed))!, 'taxi refused')

    await rowIn(store, 'filling', other(6))

    const unresolved = await store.listUnresolvedCarrierAttempts()
    expect(unresolved.map((r) => r.row.id)).toEqual([inFlight, stuck, unpaired])
    expect(unresolved.map((r) => r.attempt.phase)).toEqual(['submitting', 'quoted', 'settled'])
    expect(unresolved[0]!.attempt.snapshot).toEqual(SNAPSHOT)
    expect(Object.keys(unresolved[0]!.row)).not.toContain('carrierAttempt')
  })

  it('reads an attempt recording provider_key, and one stored before provider_key existed', async () => {
    const store = await open()
    const legacy = await rowIn(store, 'filling', other(1))
    const stored = `{"v":1,"phase":"submitting","snapshot":{"inputs":[{"txid":"${'b'.repeat(64)}","vout":1}],"provider":"http://taxi.example:7080"},"binding":{"fill_id":"fill-1"}}`
    await store.driver.run(`UPDATE asset_rfq_swap SET carrier_attempt = ? WHERE id = ?`, [stored, legacy])
    const keyed = { ...SNAPSHOT, provider: 'https://taxi.example', provider_key: 'a1'.repeat(32) }
    const named = await rowIn(store, 'filling', other(2))
    await store.prepareCarrierAttempt(named, keyed)

    expect((await store.readCarrierAttempt(legacy))?.snapshot).toEqual({
      inputs: [{ txid: 'b'.repeat(64), vout: 1 }],
      provider: 'http://taxi.example:7080',
    })
    expect((await store.readCarrierAttempt(named))?.snapshot).toEqual(keyed)
    expect((await store.listUnresolvedCarrierAttempts()).map((r) => r.row.id)).toEqual([legacy, named])
  })

  it('releases nothing of its own accord when the quote and the terms have long expired', async () => {
    const store = await open()
    const id = await attemptAt(store, 'prepared')
    clock = 9_999_999

    const unresolved = await store.listUnresolvedCarrierAttempts()
    expect(unresolved.map((r) => r.row.id)).toEqual([id])
    expect(unresolved[0]!.attempt.phase).toBe('prepared')
    expect((await store.get(id)).state).toBe('filling')
  })
})

describe('two independent connections to one database', () => {
  it('lets exactly one win each of prepare, bind and submitting', async () => {
    const file = tempDb()
    const a = await open(file)
    const b = await open(file)
    const id = await rowIn(a, 'filling')

    const prepared = await Promise.all([a.prepareCarrierAttempt(id, SNAPSHOT), b.prepareCarrierAttempt(id, SNAPSHOT)])
    expect(prepared.filter(Boolean)).toHaveLength(1)

    const one = (await a.readCarrierAttempt(id))!
    const bound = await Promise.all([a.bindCarrierAttempt(id, one, BINDING), b.bindCarrierAttempt(id, one, BINDING)])
    expect(bound.filter(Boolean)).toHaveLength(1)

    const two = (await a.readCarrierAttempt(id))!
    const marked = await Promise.all([a.markCarrierAttemptSubmitting(id, two), b.markCarrierAttemptSubmitting(id, two)])
    expect(marked.filter(Boolean)).toHaveLength(1)
    expect((await b.readCarrierAttempt(id))?.phase).toBe('submitting')
  })

  it('lets exactly one win the never-submitted terminal', async () => {
    const file = tempDb()
    const a = await open(file)
    const b = await open(file)
    const id = await attemptAt(a, 'quoted')
    const attempt = (await a.readCarrierAttempt(id))!

    const refused = await Promise.all([
      a.refuseNeverSubmittedCarrierAttempt(id, attempt, 'taxi refused'),
      b.refuseNeverSubmittedCarrierAttempt(id, attempt, 'taxi refused'),
    ])
    expect(refused.filter(Boolean)).toHaveLength(1)
    expect((await b.get(id)).state).toBe('refused')
  })
})
