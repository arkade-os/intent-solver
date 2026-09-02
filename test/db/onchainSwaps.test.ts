import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import type { SqlDriver } from '@arkade-os/solver-corridors/db/driver.js'

let now = 1_000_000
const clock = () => now

let store: OnchainSendSwapStore

const baseQuote = {
  id: 'swap-1',
  paymentHash: 'aa'.repeat(32),
  amountSats: 50_000,
  payoutSats: 49_500,
  refundLocktime: now + 3600,
  providerPubkey: 'bb'.repeat(32),
  serverPubkey: 'cc'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  pkScript: 'dd'.repeat(34),
  lockupAddress: 'tark1example',
  refundPkScript: 'ee'.repeat(34),
  emulatorPubkey: 'ff'.repeat(33),
  clientRefundPubkey: '44'.repeat(32),
  receiverPkScript: '55'.repeat(34),
  payoutPubkey: '11'.repeat(32),
  htlcPubkey: '22'.repeat(32),
  htlcLocktime: now + 1800,
  minConfirmations: 1,
  onchainAddress: 'bcrt1pexample',
  onchainPkScript: '33'.repeat(34),
  nonInteractiveParameters: true,
}

beforeEach(async () => {
  now = 1_000_000
  store = await OnchainSendSwapStore.open(':memory:', clock)
})

afterEach(async () => {
  await store.close()
})

describe('OnchainSendSwapStore', () => {
  it('insertQuote() persists a quoted row', async () => {
    const row = await store.insertQuote(baseQuote)
    expect(row.state).toBe('quoted')
    expect(row.onchainAddress).toBe('bcrt1pexample')
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
    await expect(store.transition('swap-1', 'quoted', 'claimed', {})).rejects.toThrow(/illegal transition/)
  })

  // Same regression this allowlist itself once caught too late: funding_vout
  // was added to the row/schema/toRow() before it was added here, and only
  // the orchestrator's own integration test happening to exercise that exact
  // column caught it. A column added to a state transition nobody's written
  // a dedicated test for yet would sail through silently without this guard.
  it('refuses to set a column outside the transition allowlist', async () => {
    await store.insertQuote(baseQuote)
    await expect(store.transition('swap-1', 'quoted', 'funded', { state: 'claimed' })).rejects.toThrow(/may not set/)
    await expect(store.transition('swap-1', 'quoted', 'funded', { payment_hash: 'x' })).rejects.toThrow(/may not set/)
  })

  it('refuses to touch a column outside the patch allowlist — never state', async () => {
    await store.insertQuote(baseQuote)
    await expect(store.patch('swap-1', { state: 'claimed' })).rejects.toThrow(/may not set/)
    await expect(store.patch('swap-1', { preimage: 'aa' })).rejects.toThrow(/may not set/)
    // A permitted column still works.
    await store.patch('swap-1', { onchain_lockup_value: 500 })
    expect((await store.get('swap-1')).onchainLockupValue).toBe(500)
  })

  it('transition() moves the row forward and records fields', async () => {
    await store.insertQuote(baseQuote)
    const won = await store.transition('swap-1', 'quoted', 'funded', { onchain_lockup_txid: null })
    expect(won).toBe(true)
    expect((await store.get('swap-1')).state).toBe('funded')
  })

  it('transition() is a compare-and-swap: only one caller wins a race', async () => {
    await store.insertQuote(baseQuote)
    const [a, b] = await Promise.all([
      store.transition('swap-1', 'quoted', 'funded', {}),
      store.transition('swap-1', 'quoted', 'funded', {}),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('fail() routes to stuck once the swap is exposed (funding_onchain), refused otherwise', async () => {
    await store.insertQuote(baseQuote)
    await store.fail('swap-1', 'quoted', 'refused before anything moved')
    expect((await store.get('swap-1')).state).toBe('refused')

    await store.insertQuote({ ...baseQuote, id: 'swap-2', paymentHash: 'ab'.repeat(32) })
    await store.transition('swap-2', 'quoted', 'funded', {})
    await store.transition('swap-2', 'funded', 'funding_onchain', {})
    await store.fail('swap-2', 'funding_onchain', 'onchain broadcast failed after exposure')
    expect((await store.get('swap-2')).state).toBe('stuck')
  })

  it('committedSats() sums every non-terminal row', async () => {
    await store.insertQuote(baseQuote)
    await store.insertQuote({ ...baseQuote, id: 'swap-2', paymentHash: 'ab'.repeat(32), amountSats: 10_000 })
    expect(await store.committedSats()).toBe(60_000)
  })

  it('findByRfqId() returns the most recent row for that id', async () => {
    await store.insertQuote({ ...baseQuote, rfqId: 'r1' })
    const found = await store.findByRfqId('r1')
    expect(found?.id).toBe('swap-1')
  })
})

describe('OnchainSendSwapStore — migration', () => {
  /** Minimal SqlDriver over a pre-populated better-sqlite3 handle — same shape betterSqliteDriver wraps, without its file-pragma side effects. */
  const driverOver = (db: Database.Database): SqlDriver => ({
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
  })

  it('adds funding_vout/onchain_refund_txid/client_refund_pubkey/receiver_pk_script to a table predating them, without crashing on open', async () => {
    const db = new Database(':memory:')
    // The exact pre-this-PR shape: send_onchain_swap without the four columns
    // this migration adds — what PR #7's schema left behind.
    db.exec(`
      CREATE TABLE send_onchain_swap (
        id                            TEXT PRIMARY KEY,
        state                         TEXT NOT NULL,
        created_at                    INTEGER NOT NULL,
        updated_at                    INTEGER NOT NULL,
        payment_hash                  TEXT NOT NULL,
        amount_sats                   INTEGER NOT NULL,
        refund_locktime               INTEGER NOT NULL,
        provider_pubkey               TEXT NOT NULL,
        server_pubkey                 TEXT NOT NULL,
        claim_delay                   INTEGER NOT NULL,
        refund_delay                  INTEGER NOT NULL,
        refund_without_receiver_delay INTEGER NOT NULL,
        pk_script                     TEXT NOT NULL,
        lockup_address                TEXT NOT NULL,
        refund_pk_script              TEXT NOT NULL,
        emulator_pubkey               TEXT NOT NULL,
        payout_pubkey                 TEXT NOT NULL,
        htlc_pubkey                   TEXT NOT NULL,
        htlc_locktime                 INTEGER NOT NULL,
        min_confirmations             INTEGER NOT NULL,
        onchain_address                TEXT NOT NULL,
        onchain_pk_script              TEXT NOT NULL,
        onchain_lockup_txid           TEXT,
        onchain_lockup_vout           INTEGER,
        onchain_lockup_value          INTEGER,
        funding_txid                  TEXT,
        preimage                      TEXT,
        claim_ark_txid                TEXT,
        refund_ark_txid               TEXT,
        refund_outcome                TEXT,
        failure_reason                TEXT,
        rfq_id                        TEXT
      );
    `)
    db.prepare(
      `INSERT INTO send_onchain_swap (
        id, state, created_at, updated_at, payment_hash, amount_sats, refund_locktime,
        provider_pubkey, server_pubkey, claim_delay, refund_delay, refund_without_receiver_delay,
        pk_script, lockup_address, refund_pk_script, emulator_pubkey, payout_pubkey, htlc_pubkey,
        htlc_locktime, min_confirmations, onchain_address, onchain_pk_script
      ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'pre-existing-row',
      1_000_000,
      1_000_000,
      '99'.repeat(32),
      50_000,
      1_000_000 + 3600,
      'bb'.repeat(32),
      'cc'.repeat(32),
      512,
      1024,
      1536,
      'dd'.repeat(34),
      'tark1preexisting',
      'ee'.repeat(34),
      'ff'.repeat(33),
      '11'.repeat(32),
      '22'.repeat(32),
      1_000_000 + 1800,
      1,
      'bcrt1pexample',
      '33'.repeat(34),
    )

    const migrated = await OnchainSendSwapStore.open(driverOver(db), clock)
    // The pre-existing row survives and is still readable — the whole point
    // of an additive migration over a table rebuild.
    const row = await migrated.get('pre-existing-row')
    expect(row.state).toBe('quoted')
    expect(row.fundingVout).toBeNull()
    // Quoted before fees existed: it charged nothing, so the payout WAS the
    // amount — the honest reading of a missing payout_sats, not a default.
    expect(row.payoutSats).toBe(50_000)

    // And the table now genuinely has the new columns: a fresh row exercising
    // all four migrated columns round-trips correctly.
    await migrated.insertQuote(baseQuote)
    const fresh = await migrated.get('swap-1')
    expect(fresh.clientRefundPubkey).toBe(baseQuote.clientRefundPubkey)
    expect(fresh.receiverPkScript).toBe(baseQuote.receiverPkScript)
    await migrated.close()
  })

  it('is idempotent — opening an already-migrated table a second time does not error', async () => {
    const db = new Database(':memory:')
    const once = await OnchainSendSwapStore.open(driverOver(db), clock)
    await once.insertQuote(baseQuote)
    const twice = await OnchainSendSwapStore.open(driverOver(db), clock)
    expect((await twice.get('swap-1')).id).toBe('swap-1')
    await twice.close()
  })
})
