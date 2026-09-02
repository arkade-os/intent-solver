import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { d1Driver, type D1Like } from '@arkade-os/solver-corridors/db/driver.js'
import { SwapStore, type QuoteRecord } from '@arkade-os/solver-corridors/db/swaps.js'

/**
 * A minimal in-process D1: the same prepare/bind/run/first/all surface with the
 * same conventions — first() says "no row" with null (never undefined), all()
 * wraps rows in {results}, run() reports {meta:{changes}} — over better-sqlite3.
 * Running the store's behaviour through it proves the d1Driver code path
 * without a Cloudflare runtime in the loop.
 */
const fakeD1 = (db: Database.Database): D1Like => ({
  exec: async (sql: string) => db.exec(sql),
  prepare: (sql: string) => ({
    bind: (...params: unknown[]) => ({
      run: async () => ({ meta: { changes: db.prepare(sql).run(...(params as never[])).changes } }),
      first: async <T>() => (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...(params as never[])) as T[] }),
    }),
  }),
})

let clock: number
let db: Database.Database
let store: SwapStore

/**
 * Every database opened by a test, closed after it.
 *
 * better-sqlite3 handles are native, and an unclosed one is destructed when the
 * vitest worker's Node environment is already gone —
 * `RemoveEnvironmentCleanupHook` then asserts `env != nullptr` and takes the
 * whole worker down with it, surfacing as an unrelated "Channel closed". It is
 * timing-dependent, so it fails a run that has nothing to do with the change
 * under test.
 */
const openDbs: Database.Database[] = []
const openDb = (): Database.Database => {
  const db = new Database(':memory:')
  openDbs.push(db)
  return db
}
afterEach(() => {
  while (openDbs.length) openDbs.pop()!.close()
})

const quote = (over: Partial<QuoteRecord> = {}): QuoteRecord => ({
  id: 'swap-1',
  invoice: 'lnbc5u1p...',
  paymentHash: 'a'.repeat(64),
  amountSats: 500,
  invoiceExpiresAt: clock + 3600,
  refundLocktime: clock + 7200,
  senderPubkey: '01'.repeat(32),
  receiverPubkey: '02'.repeat(32),
  serverPubkey: '03'.repeat(32),
  claimDelay: 605184,
  refundDelay: 605696,
  refundWithoutReceiverDelay: 606208,
  pkScript: '5120' + 'ab'.repeat(32),
  lockupAddress: 'ark1qexample',
  refundPkScript: '5120' + 'cd'.repeat(32),
  emulatorPubkey: '02' + 'ee'.repeat(32),
  nonInteractiveParameters: true,
  ...over,
})

beforeEach(async () => {
  clock = 1_800_000_000
  db = openDb()
  // open() runs the multi-statement SCHEMA through the driver's exec, which is
  // exactly the split-and-run-one-at-a-time path a real D1 needs.
  store = await SwapStore.open(d1Driver(fakeD1(db)), () => clock)
})

describe('the same store behaviour through the D1 driver', () => {
  it('inserts and reads a row back; a missing row is null, not undefined', async () => {
    const row = await store.insertQuote(quote())
    expect(row.state).toBe('quoted')
    expect(row.refundLocktime).toBe(clock + 7200)
    // Nullable columns survive D1's null convention untranslated.
    expect(row.lockupTxid).toBeNull()

    expect((await store.findByPaymentHash('a'.repeat(64)))?.id).toBe('swap-1')
    // first() -> null must come out of the store as null, same as on Node.
    expect(await store.findByPaymentHash('f'.repeat(64))).toBeNull()
  })

  it('keeps the UNIQUE payment_hash backstop', async () => {
    await store.insertQuote(quote())
    await expect(store.insertQuote(quote({ id: 'swap-2' }))).rejects.toThrow(/UNIQUE/i)
  })

  it('lets exactly one caller win a compare-and-swap transition', async () => {
    // The winner is decided by meta.changes — the D1 shape of SQLite's
    // changes() count, which is what the Node driver reports too.
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    expect(await store.transition('swap-1', 'funded', 'paying')).toBe(true)
    expect(await store.transition('swap-1', 'funded', 'paying')).toBe(false)
    expect((await store.get('swap-1')).state).toBe('paying')
    expect((await store.history('swap-1')).map((e) => e.to)).toEqual(['quoted', 'funded', 'paying'])
  })

  it('sums committed capacity over every non-terminal state', async () => {
    await store.insertQuote(quote())
    await store.insertQuote(quote({ id: 'swap-2', paymentHash: 'b'.repeat(64), amountSats: 700 }))
    // Both quoted -> both counted (D1 driver path).
    expect(await store.committedSats()).toBe(500 + 700)

    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'paying')
    expect(await store.committedSats()).toBe(500 + 700)

    await store.fail('swap-1', 'paying', 'lost') // -> stuck (terminal)
    expect(await store.committedSats()).toBe(700)
  })

  it('applies every findRefundable filter', async () => {
    // Eligible: refused, covenant-capable, unrefunded.
    await store.insertQuote(quote())
    await store.fail('swap-1', 'quoted', 'lockup timeout')
    // Ineligible: legacy row with no refund_pk_script.
    await store.insertQuote(quote({ id: 'swap-2', paymentHash: 'b'.repeat(64), refundPkScript: undefined }))
    await store.fail('swap-2', 'quoted', 'lockup timeout')
    // Eligible AT ONCE: an extended row's non-interactive refund leaf has no
    // timelock, so its deadline is not a precondition for pushing it.
    await store.insertQuote(quote({ id: 'swap-3', paymentHash: 'c'.repeat(64), clientRefundPubkey: '04'.repeat(32) }))
    await store.fail('swap-3', 'quoted', 'lockup timeout')

    // Before the deadline only the timelock-free row is due.
    expect((await store.findRefundable(clock)).map((r) => r.id)).toEqual(['swap-3'])
    // Past it the covenant-capable legacy row joins it.
    const due = await store.findRefundable(clock + 7200)
    expect(due.map((r) => r.id).sort()).toEqual(['swap-1', 'swap-3'])

    // Once an outcome is recorded the sweep stops seeing it.
    await store.patch('swap-1', { refund_outcome: 'pushed', refund_ark_txid: 'refund-tx' })
    expect((await store.findRefundable(clock + 7200)).map((r) => r.id)).toEqual(['swap-3'])
    await store.patch('swap-3', { refund_outcome: 'pushed', refund_ark_txid: 'refund-tx-3' })
    expect(await store.findRefundable(clock + 7200)).toEqual([])
  })

  it('adds missing columns to a pre-covenant database on open', async () => {
    // A database created before the covenant columns existed: CREATE TABLE IF
    // NOT EXISTS will not touch it, so open() must ALTER — with the column
    // check going through PRAGMA table_info via prepare().all(), the one form
    // D1 serves.
    const legacy = openDb()
    legacy.exec(`CREATE TABLE send_swap (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      invoice TEXT NOT NULL, payment_hash TEXT NOT NULL UNIQUE, amount_sats INTEGER NOT NULL,
      invoice_expires_at INTEGER NOT NULL, refund_locktime INTEGER NOT NULL, sender_pubkey TEXT NOT NULL,
      receiver_pubkey TEXT NOT NULL, server_pubkey TEXT NOT NULL, claim_delay INTEGER NOT NULL,
      refund_delay INTEGER NOT NULL, refund_without_receiver_delay INTEGER NOT NULL, pk_script TEXT NOT NULL,
      lockup_address TEXT NOT NULL, lockup_txid TEXT, lockup_vout INTEGER, lockup_value INTEGER,
      idempotency_key TEXT, pay_attempted_at INTEGER, payment_id TEXT, preimage TEXT, claim_ark_txid TEXT,
      failure_reason TEXT
    )`)
    const migrated = await SwapStore.open(d1Driver(fakeD1(legacy)), () => clock)
    const row = await migrated.insertQuote(quote())
    expect(row.refundPkScript).toBe('5120' + 'cd'.repeat(32))
    expect(row.refundArkTxid).toBeNull()
  })

  // Deliberately WITHOUT the column-level UNIQUE on payment_hash: that
  // constraint sends open() down the full table rebuild, which recreates the
  // table from the current schema and therefore lands every new column whether
  // or not `migrate()` lists it. Only a database that skips the rebuild
  // exercises the ALTER path, and a column missing from that list fails just
  // once — when a live poll patches a production database.
  it('ALTERs in a column a post-rebuild database has never seen', async () => {
    const legacy = openDb()
    legacy.exec(`CREATE TABLE send_swap (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      invoice TEXT NOT NULL, payment_hash TEXT NOT NULL, amount_sats INTEGER NOT NULL,
      invoice_expires_at INTEGER NOT NULL, refund_locktime INTEGER NOT NULL, sender_pubkey TEXT NOT NULL,
      receiver_pubkey TEXT NOT NULL, server_pubkey TEXT NOT NULL, claim_delay INTEGER NOT NULL,
      refund_delay INTEGER NOT NULL, refund_without_receiver_delay INTEGER NOT NULL, pk_script TEXT NOT NULL,
      lockup_address TEXT NOT NULL, lockup_txid TEXT, lockup_vout INTEGER, lockup_value INTEGER,
      idempotency_key TEXT, pay_attempted_at INTEGER, payment_id TEXT, preimage TEXT, claim_ark_txid TEXT,
      failure_reason TEXT
    )`)
    const migrated = await SwapStore.open(d1Driver(fakeD1(legacy)), () => clock)
    const row = await migrated.insertQuote(quote())

    // Reading proves nothing — the row mapper turns an absent column into null.
    // Writing is what needs the ALTER to have run.
    expect(row.paymentEvidence).toBeNull()
    expect(row.paymentFailureReason).toBeNull()
    await migrated.patch(row.id, { payment_evidence: 'in_flight', payment_failure_reason: 'rejected_by_destination' })
    const back = await migrated.get(row.id)
    expect(back.paymentEvidence).toBe('in_flight')
    expect(back.paymentFailureReason).toBe('rejected_by_destination')
  })

  it('rebuilds a legacy column-UNIQUE table so refused hashes are re-quotable', async () => {
    // A database from before the partial index: payment_hash UNIQUE at column
    // level burned a hash forever. open() must rebuild the table once, keep the
    // rows, keep the event table's foreign key working, and enforce the partial
    // uniqueness thereafter.
    const legacy = openDb()
    legacy.exec(`CREATE TABLE send_swap (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      invoice TEXT NOT NULL, payment_hash TEXT NOT NULL UNIQUE, amount_sats INTEGER NOT NULL,
      invoice_expires_at INTEGER NOT NULL, refund_locktime INTEGER NOT NULL, sender_pubkey TEXT NOT NULL,
      receiver_pubkey TEXT NOT NULL, server_pubkey TEXT NOT NULL, claim_delay INTEGER NOT NULL,
      refund_delay INTEGER NOT NULL, refund_without_receiver_delay INTEGER NOT NULL, pk_script TEXT NOT NULL,
      lockup_address TEXT NOT NULL, lockup_txid TEXT, lockup_vout INTEGER, lockup_value INTEGER,
      idempotency_key TEXT, pay_attempted_at INTEGER, payment_id TEXT, preimage TEXT, claim_ark_txid TEXT,
      failure_reason TEXT
    )`)
    const migrated = await SwapStore.open(d1Driver(fakeD1(legacy)), () => clock)

    // Old data survives the rebuild, and the event FK still records history.
    const first = await migrated.insertQuote(quote())
    await migrated.fail(first.id, 'quoted', 'lockup timeout')
    expect((await migrated.history(first.id)).map((e) => e.to)).toEqual(['quoted', 'refused'])

    // The exact case the rebuild exists for: same hash again after a refusal.
    const again = await migrated.insertQuote(quote({ id: 'swap-2' }))
    expect(again.id).toBe('swap-2')
    // And live uniqueness still holds.
    await expect(migrated.insertQuote(quote({ id: 'swap-3' }))).rejects.toThrow(/UNIQUE/i)
  })
})
