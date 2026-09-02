import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import type { SqlDriver } from '@arkade-os/solver-corridors/db/driver.js'

let now = 1_800_000_000
const clock = () => now

let store: ReceiveSwapStore

const baseQuote = {
  id: 'swap-1',
  paymentHash: 'aa'.repeat(32),
  amountSats: 5_000,
  payoutSats: 4_950,
  invoice: 'lnbcrt50000n1...',
  invoiceExpiresAt: now + 600,
  payoutAddress: 'tark1payoutexample',
  payoutPkScript: '11'.repeat(34),
  payoutPubkey: '22'.repeat(32),
  claimPacket: 'ZWFsZWQtY2lwaGVydGV4dA==',
  refundLocktime: now + 7200,
  solverPubkey: '33'.repeat(32),
  serverPubkey: '44'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  emulatorPubkey: '55'.repeat(33),
  pkScript: '66'.repeat(34),
  lockupAddress: 'tark1lockupexample',
  solverRefundPkScript: '77'.repeat(34),
  nonInteractiveParameters: true,
}

beforeEach(async () => {
  now = 1_800_000_000
  store = await ReceiveSwapStore.open(':memory:', clock)
})

afterEach(async () => {
  await store.close()
})

describe('ReceiveSwapStore', () => {
  it('insertQuote() persists a quoted row', async () => {
    const row = await store.insertQuote(baseQuote)
    expect(row.state).toBe('quoted')
    expect(row.paymentHash).toBe(baseQuote.paymentHash)
    expect(row.htlcExpiresAt).toBeNull()
    expect(row.preimage).toBeNull()
    expect(row.arkadeLockupTxid).toBeNull()
    expect(row.revealedAt).toBeNull()
  })

  it('round-trips nonInteractiveParameters through the real store, both ways', async () => {
    // The encode/decode path ('1'/null on the wire, boolean|null in the row)
    // is asserted by inspection in covenant.ts and arkadeOps.test.ts, but
    // never actually exercised through insertQuote()+get() until now — an
    // inconsistency here is a silent address divergence for this corridor
    // alone, so it earns its own test rather than staying inspection-only.
    const on = await store.insertQuote({ ...baseQuote, nonInteractiveParameters: true })
    expect(on.nonInteractiveParameters).toBe(true)

    const off = await store.insertQuote({
      ...baseQuote,
      id: 'swap-2',
      paymentHash: 'ab'.repeat(32),
      nonInteractiveParameters: false,
    })
    expect(off.nonInteractiveParameters).toBeNull()
  })

  it('transition() only allows legal edges', async () => {
    await store.insertQuote(baseQuote)
    await expect(store.transition('swap-1', 'quoted', 'settled', {})).rejects.toThrow(/illegal transition/)
    await expect(store.transition('swap-1', 'quoted', 'claimed', {})).rejects.toThrow(/illegal transition/)
  })

  it('walks the full happy path: quoted -> armed -> funded -> claimed -> settled', async () => {
    await store.insertQuote(baseQuote)
    expect(await store.transition('swap-1', 'quoted', 'armed', { htlc_expires_at: now + 5400 })).toBe(true)
    expect((await store.get('swap-1')).htlcExpiresAt).toBe(now + 5400)

    expect(
      await store.transition('swap-1', 'armed', 'funded', {
        arkade_lockup_txid: 'fundtx',
        arkade_lockup_vout: 0,
        arkade_lockup_value: 5_000,
      }),
    ).toBe(true)
    const funded = await store.get('swap-1')
    expect(funded.state).toBe('funded')
    // Unchanged from the quote — `pk_script` is derived from it, so funding
    // must not move it. See `refund_locktime`'s absence from TRANSITION_COLUMNS.
    expect(funded.refundLocktime).toBe(baseQuote.refundLocktime)
    expect(funded.arkadeLockupTxid).toBe('fundtx')

    expect(await store.transition('swap-1', 'funded', 'claimed', { preimage: 'ab'.repeat(32) })).toBe(true)
    expect((await store.get('swap-1')).preimage).toBe('ab'.repeat(32))

    expect(await store.transition('swap-1', 'claimed', 'settled', {})).toBe(true)
    expect((await store.get('swap-1')).state).toBe('settled')
  })

  it('walks the refund path: funded -> refunding -> refunded', async () => {
    await store.insertQuote(baseQuote)
    await store.transition('swap-1', 'quoted', 'armed', { htlc_expires_at: now + 5400 })
    await store.transition('swap-1', 'armed', 'funded', {})
    expect(await store.transition('swap-1', 'funded', 'refunding', {})).toBe(true)
    expect(await store.transition('swap-1', 'refunding', 'refunded', { refund_ark_txid: 'refundtx' })).toBe(true)
    const row = await store.get('swap-1')
    expect(row.state).toBe('refunded')
    expect(row.refundArkTxid).toBe('refundtx')
  })

  it('refunding can recover to claimed on a late-but-valid claim, mirroring refunding_onchain', async () => {
    await store.insertQuote(baseQuote)
    await store.transition('swap-1', 'quoted', 'armed', { htlc_expires_at: now + 5400 })
    await store.transition('swap-1', 'armed', 'funded', {})
    await store.transition('swap-1', 'funded', 'refunding', {})
    expect(await store.transition('swap-1', 'refunding', 'claimed', { preimage: 'cd'.repeat(32) })).toBe(true)
    expect((await store.get('swap-1')).state).toBe('claimed')
  })

  it('refuses to set a column outside the transition allowlist', async () => {
    await store.insertQuote(baseQuote)
    await expect(store.transition('swap-1', 'quoted', 'armed', { state: 'settled' })).rejects.toThrow(/may not set/)
    await expect(store.transition('swap-1', 'quoted', 'armed', { payment_hash: 'x' })).rejects.toThrow(/may not set/)
  })

  it('refuses to move refund_locktime — the covenant pkScript is derived from it', async () => {
    // Not merely "not currently written": forbidden. A row whose
    // refund_locktime no longer matches the funded script derives a DIFFERENT
    // script, and the solver's own refund is then refused against its own
    // lockup (`assertScriptMatchesRow`, src/receive/arkadeOps.ts).
    await store.insertQuote(baseQuote)
    await store.transition('swap-1', 'quoted', 'armed', { htlc_expires_at: now + 5400 })
    await expect(store.transition('swap-1', 'armed', 'funded', { refund_locktime: now + 5100 })).rejects.toThrow(
      /may not set column 'refund_locktime'/,
    )
    await expect(store.patch('swap-1', { refund_locktime: now + 5100 })).rejects.toThrow(/may not set/)
  })

  it('refuses to touch a column outside the patch allowlist — never state', async () => {
    await store.insertQuote(baseQuote)
    await expect(store.patch('swap-1', { state: 'settled' })).rejects.toThrow(/may not set/)
    await expect(store.patch('swap-1', { preimage: 'aa' })).rejects.toThrow(/may not set/)
    await store.patch('swap-1', { revealed_at: now })
    expect((await store.get('swap-1')).revealedAt).toBe(now)
  })

  it('transition() is a compare-and-swap: only one caller wins a race', async () => {
    await store.insertQuote(baseQuote)
    await store.transition('swap-1', 'quoted', 'armed', { htlc_expires_at: now + 5400 })
    const [a, b] = await Promise.all([
      store.transition('swap-1', 'armed', 'funded', {}),
      store.transition('swap-1', 'armed', 'funded', {}),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('fail() routes to stuck once the swap is exposed (funded), refused otherwise', async () => {
    await store.insertQuote(baseQuote)
    await store.fail('swap-1', 'quoted', 'invoice expired before it was ever armed')
    expect((await store.get('swap-1')).state).toBe('refused')

    await store.insertQuote({ ...baseQuote, id: 'swap-2', paymentHash: 'bb'.repeat(32) })
    await store.transition('swap-2', 'quoted', 'armed', { htlc_expires_at: now + 5400 })
    await store.transition('swap-2', 'armed', 'funded', {})
    await store.fail('swap-2', 'funded', 'ambiguous witness on the funded lockup; needs review')
    expect((await store.get('swap-2')).state).toBe('stuck')
  })

  it('committedSats() sums every non-terminal row', async () => {
    await store.insertQuote(baseQuote)
    await store.insertQuote({ ...baseQuote, id: 'swap-2', paymentHash: 'bb'.repeat(32), amountSats: 1_000 })
    expect(await store.committedSats()).toBe(6_000)
  })

  it('findLiveByPaymentHash() blocks a re-quote while live, allows it once refused', async () => {
    await store.insertQuote(baseQuote)
    expect(await store.findLiveByPaymentHash(baseQuote.paymentHash)).not.toBeNull()
    await store.fail('swap-1', 'quoted', 'lapsed')
    expect(await store.findLiveByPaymentHash(baseQuote.paymentHash)).toBeNull()
  })

  it('findByRfqId() returns the most recent row for that id', async () => {
    await store.insertQuote({ ...baseQuote, rfqId: 'r1' })
    const found = await store.findByRfqId('r1')
    expect(found?.id).toBe('swap-1')
  })

  it('findByStates() filters and orders by creation time', async () => {
    await store.insertQuote(baseQuote)
    await store.insertQuote({ ...baseQuote, id: 'swap-2', paymentHash: 'bb'.repeat(32) })
    await store.transition('swap-2', 'quoted', 'armed', { htlc_expires_at: now + 5400 })
    expect((await store.findByStates(['quoted'])).map((r) => r.id)).toEqual(['swap-1'])
    expect((await store.findByStates(['armed'])).map((r) => r.id)).toEqual(['swap-2'])
  })

  it('findRecoverable() returns every non-terminal row', async () => {
    await store.insertQuote(baseQuote)
    await store.insertQuote({ ...baseQuote, id: 'swap-2', paymentHash: 'bb'.repeat(32) })
    await store.fail('swap-2', 'quoted', 'lapsed')
    expect((await store.findRecoverable()).map((r) => r.id)).toEqual(['swap-1'])
  })

  it('a UNIQUE constraint on payment_hash blocks two live rows for the same hash', async () => {
    await store.insertQuote(baseQuote)
    await expect(store.insertQuote({ ...baseQuote, id: 'swap-2' })).rejects.toThrow()
  })

  it('a refused payment_hash may be re-quoted', async () => {
    await store.insertQuote(baseQuote)
    await store.fail('swap-1', 'quoted', 'lapsed')
    await expect(store.insertQuote({ ...baseQuote, id: 'swap-2' })).resolves.toBeDefined()
  })

  it('history() records every transition in order', async () => {
    await store.insertQuote(baseQuote)
    await store.transition('swap-1', 'quoted', 'armed', { htlc_expires_at: now + 5400 })
    const events = await store.history('swap-1')
    expect(events.map((e) => e.to)).toEqual(['quoted', 'armed'])
  })
})

describe('ReceiveSwapStore — migration', () => {
  it('CREATE TABLE IF NOT EXISTS leaves an already-migrated table untouched on reopen', async () => {
    const db = new Database(':memory:')
    const driver: SqlDriver = {
      exec: async (sql) => {
        db.exec(sql)
      },
      run: async (sql, params = []) => ({ changes: db.prepare(sql).run(...(params as never[])).changes }),
      get: async (sql, params = []) => db.prepare(sql).get(...(params as never[])) as never,
      all: async (sql, params = []) => db.prepare(sql).all(...(params as never[])) as never,
      transaction: async (fn) => fn(),
      close: async () => {
        db.close()
      },
    }
    const first = await ReceiveSwapStore.open(driver, clock)
    await first.insertQuote(baseQuote)
    const second = await ReceiveSwapStore.open(driver, clock)
    expect((await second.get('swap-1')).id).toBe('swap-1')
  })

  it('adds payout_sats to a table predating it, reading pre-fee rows as amount-minus-nothing', async () => {
    const db = new Database(':memory:')
    const driver: SqlDriver = {
      exec: async (sql) => {
        db.exec(sql)
      },
      run: async (sql, params = []) => ({ changes: db.prepare(sql).run(...(params as never[])).changes }),
      get: async (sql, params = []) => db.prepare(sql).get(...(params as never[])) as never,
      all: async (sql, params = []) => db.prepare(sql).all(...(params as never[])) as never,
      transaction: async (fn) => fn(),
      close: async () => {
        db.close()
      },
    }
    // The exact pre-fees shape: receive_swap without payout_sats (every other
    // column as the current schema has them, nullable tails included).
    db.exec(`
      CREATE TABLE receive_swap (
        id                            TEXT PRIMARY KEY,
        state                         TEXT NOT NULL,
        created_at                    INTEGER NOT NULL,
        updated_at                    INTEGER NOT NULL,
        payment_hash                  TEXT NOT NULL,
        amount_sats                   INTEGER NOT NULL,
        invoice                       TEXT NOT NULL,
        invoice_expires_at            INTEGER NOT NULL,
        htlc_expires_at               INTEGER,
        payout_address                TEXT NOT NULL,
        payout_pk_script              TEXT NOT NULL,
        payout_pubkey                 TEXT NOT NULL,
        claim_packet                  TEXT NOT NULL,
        refund_locktime               INTEGER NOT NULL,
        solver_pubkey                 TEXT NOT NULL,
        server_pubkey                 TEXT NOT NULL,
        claim_delay                   INTEGER NOT NULL,
        refund_delay                  INTEGER NOT NULL,
        refund_without_receiver_delay INTEGER NOT NULL,
        emulator_pubkey               TEXT NOT NULL,
        pk_script                     TEXT NOT NULL,
        lockup_address                TEXT NOT NULL,
        solver_refund_pk_script       TEXT NOT NULL,
        arkade_lockup_txid            TEXT,
        arkade_lockup_vout            INTEGER,
        arkade_lockup_value           INTEGER,
        revealed_at                   INTEGER,
        preimage                      TEXT,
        refund_ark_txid               TEXT,
        failure_reason                TEXT,
        rfq_id                        TEXT
      );
    `)
    db.prepare(
      `INSERT INTO receive_swap (
        id, state, created_at, updated_at, payment_hash, amount_sats, invoice, invoice_expires_at,
        payout_address, payout_pk_script, payout_pubkey, claim_packet,
        refund_locktime, solver_pubkey, server_pubkey, claim_delay, refund_delay, refund_without_receiver_delay,
        emulator_pubkey, pk_script, lockup_address, solver_refund_pk_script
      ) VALUES ('pre-existing-row', 'quoted', 1, 1, ?, 5000, 'lnbcrt50000n1...', 1000, 'tark1x', '11', '22', 'cA==', 1000, '33', '44', 1, 1, 1, '55', '66', 'tark1y', '77')`,
    ).run('99'.repeat(32))

    const migrated = await ReceiveSwapStore.open(driver, clock)
    const row = await migrated.get('pre-existing-row')
    // Quoted before fees existed: it charged nothing, so the payout WAS the
    // amount — the honest reading of a missing payout_sats, not a default.
    expect(row.payoutSats).toBe(5_000)
    // And the new column round-trips for rows quoted after the migration.
    await migrated.insertQuote(baseQuote)
    expect((await migrated.get('swap-1')).payoutSats).toBe(4_950)
  })
})
