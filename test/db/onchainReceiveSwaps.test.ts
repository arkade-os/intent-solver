import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { OnchainReceiveSwapStore } from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'
import type { SqlDriver } from '@arkade-os/solver-corridors/db/driver.js'

let now = 1_000_000
const clock = () => now

let store: OnchainReceiveSwapStore

const baseQuote = {
  id: 'swap-1',
  paymentHash: 'aa'.repeat(32),
  amountSats: 50_000,
  payoutSats: 49_500,
  htlcLocktime: now + 1800,
  refundLocktime: now + 900,
  minConfirmations: 1,
  providerPubkey: 'bb'.repeat(32),
  clientPayoutPubkey: 'dd'.repeat(32),
  serverPubkey: 'cc'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  emulatorPubkey: 'ff'.repeat(33),
  pkScript: 'dd'.repeat(34),
  lockupAddress: 'tark1example',
  refundPkScript: 'ee'.repeat(34),
  clientPayoutPkScript: '77'.repeat(34),
  htlcPubkey: '22'.repeat(32),
  clientOnchainRefundPubkey: '11'.repeat(32),
  onchainAddress: 'bcrt1pexample',
  onchainPkScript: '33'.repeat(34),
  claimPacket: Buffer.from('sealed-packet').toString('base64'),
  nonInteractiveParameters: true,
}

beforeEach(async () => {
  now = 1_000_000
  store = await OnchainReceiveSwapStore.open(':memory:', clock)
})

afterEach(async () => {
  await store.close()
})

describe('OnchainReceiveSwapStore', () => {
  it('insertQuote() persists a quoted row', async () => {
    const row = await store.insertQuote(baseQuote)
    expect(row.state).toBe('quoted')
    expect(row.onchainAddress).toBe('bcrt1pexample')
    expect(row.claimPacket).toBe(baseQuote.claimPacket)
    expect(row.preimage).toBeNull()
    expect(row.fundingTxid).toBeNull()
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

  it('rejects a duplicate live payment hash via the unique index', async () => {
    await store.insertQuote(baseQuote)
    await expect(store.insertQuote({ ...baseQuote, id: 'swap-2' })).rejects.toThrow(/UNIQUE/i)
  })

  it('allows re-quoting a payment hash once the prior row is refused', async () => {
    await store.insertQuote(baseQuote)
    await store.transition('swap-1', 'quoted', 'refused', {})
    await expect(store.insertQuote({ ...baseQuote, id: 'swap-2' })).resolves.toMatchObject({ id: 'swap-2' })
  })

  it('transition() only allows legal edges', async () => {
    await store.insertQuote(baseQuote)
    await expect(store.transition('swap-1', 'quoted', 'settled', {})).rejects.toThrow(/illegal transition/)
    await expect(store.transition('swap-1', 'quoted', 'claimed', {})).rejects.toThrow(/illegal transition/)
  })

  it('refuses to set a column outside the transition allowlist', async () => {
    await store.insertQuote(baseQuote)
    await expect(store.transition('swap-1', 'quoted', 'awaiting_confirmations', { state: 'settled' })).rejects.toThrow(
      /may not set/,
    )
    await expect(store.transition('swap-1', 'quoted', 'awaiting_confirmations', { payment_hash: 'x' })).rejects.toThrow(
      /may not set/,
    )
  })

  it('refuses to touch a column outside the patch allowlist — never state', async () => {
    await store.insertQuote(baseQuote)
    await expect(store.patch('swap-1', { state: 'settled' })).rejects.toThrow(/may not set/)
    await expect(store.patch('swap-1', { preimage: 'aa' })).rejects.toThrow(/may not set/)
  })

  it('transition() moves the row forward and records fields', async () => {
    await store.insertQuote(baseQuote)
    const won = await store.transition('swap-1', 'quoted', 'awaiting_confirmations', {
      funding_txid: 'tx1',
      funding_vout: 0,
    })
    expect(won).toBe(true)
    const row = await store.get('swap-1')
    expect(row.state).toBe('awaiting_confirmations')
    expect(row.fundingTxid).toBe('tx1')
    expect(row.fundingVout).toBe(0)
  })

  it('transition() is a compare-and-swap: only one caller wins a race', async () => {
    await store.insertQuote(baseQuote)
    const [a, b] = await Promise.all([
      store.transition('swap-1', 'quoted', 'awaiting_confirmations', {}),
      store.transition('swap-1', 'quoted', 'awaiting_confirmations', {}),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('drives the full happy path quoted -> ... -> settled', async () => {
    await store.insertQuote(baseQuote)
    await store.transition('swap-1', 'quoted', 'awaiting_confirmations', { funding_txid: 'f1', funding_vout: 0 })
    await store.transition('swap-1', 'awaiting_confirmations', 'funding_arkade', {})
    await store.transition('swap-1', 'funding_arkade', 'awaiting_claim', { arkade_fund_txid: 'ark1' })
    await store.transition('swap-1', 'awaiting_claim', 'claimed', {
      preimage: 'ab'.repeat(32),
      arkade_claim_txid: 'ark2',
    })
    await store.transition('swap-1', 'claimed', 'settled', { onchain_claim_txid: 'oc1' })
    const row = await store.get('swap-1')
    expect(row.state).toBe('settled')
    expect(row.preimage).toBe('ab'.repeat(32))
    expect(row.onchainClaimTxid).toBe('oc1')
  })

  it('drives the arkade-refund failure path with a late claim recovering it', async () => {
    await store.insertQuote(baseQuote)
    await store.transition('swap-1', 'quoted', 'awaiting_confirmations', { funding_txid: 'f1', funding_vout: 0 })
    await store.transition('swap-1', 'awaiting_confirmations', 'funding_arkade', {})
    await store.transition('swap-1', 'funding_arkade', 'awaiting_claim', { arkade_fund_txid: 'ark1' })
    await store.transition('swap-1', 'awaiting_claim', 'refunding_arkade', {})
    // A late-but-valid covclaimd claim recovers the row instead of stranding it.
    const won = await store.transition('swap-1', 'refunding_arkade', 'claimed', {
      preimage: 'cd'.repeat(32),
      arkade_claim_txid: 'ark3',
    })
    expect(won).toBe(true)
    expect((await store.get('swap-1')).state).toBe('claimed')
  })

  it('drives the arkade-refund success path to refunded', async () => {
    await store.insertQuote(baseQuote)
    await store.transition('swap-1', 'quoted', 'awaiting_confirmations', { funding_txid: 'f1', funding_vout: 0 })
    await store.transition('swap-1', 'awaiting_confirmations', 'funding_arkade', {})
    await store.transition('swap-1', 'funding_arkade', 'awaiting_claim', { arkade_fund_txid: 'ark1' })
    await store.transition('swap-1', 'awaiting_claim', 'refunding_arkade', {})
    await store.transition('swap-1', 'refunding_arkade', 'refunded', { arkade_refund_txid: 'ref1' })
    const row = await store.get('swap-1')
    expect(row.state).toBe('refunded')
    expect(row.arkadeRefundTxid).toBe('ref1')
  })

  it('fail() routes an EXPOSED state to stuck and a non-exposed one to refused', async () => {
    await store.insertQuote(baseQuote)
    await store.fail('swap-1', 'quoted', 'lockup timeout')
    expect((await store.get('swap-1')).state).toBe('refused')

    await store.insertQuote({ ...baseQuote, id: 'swap-2', paymentHash: 'bb'.repeat(32) })
    await store.transition('swap-2', 'quoted', 'awaiting_confirmations', {})
    await store.transition('swap-2', 'awaiting_confirmations', 'funding_arkade', {})
    await store.fail('swap-2', 'funding_arkade', 'broadcast RPC unreachable')
    expect((await store.get('swap-2')).state).toBe('stuck')
  })

  it('committedSats sums only non-terminal rows', async () => {
    await store.insertQuote(baseQuote)
    await store.insertQuote({ ...baseQuote, id: 'swap-2', paymentHash: 'bb'.repeat(32), amountSats: 10_000 })
    await store.transition('swap-2', 'quoted', 'refused', {})
    expect(await store.committedSats()).toBe(50_000)
  })

  it('findLiveByPaymentHash finds a non-refused row and ignores refused ones', async () => {
    await store.insertQuote(baseQuote)
    expect(await store.findLiveByPaymentHash(baseQuote.paymentHash)).toMatchObject({ id: 'swap-1' })
    await store.transition('swap-1', 'quoted', 'refused', {})
    expect(await store.findLiveByPaymentHash(baseQuote.paymentHash)).toBeNull()
  })

  it('findRecoverable returns every non-terminal row, oldest first', async () => {
    await store.insertQuote(baseQuote)
    await store.insertQuote({ ...baseQuote, id: 'swap-2', paymentHash: 'bb'.repeat(32) })
    await store.transition('swap-2', 'quoted', 'refused', {})
    const rows = await store.findRecoverable()
    expect(rows.map((r) => r.id)).toEqual(['swap-1'])
  })

  it('findByRfqId finds the most recent row for a correlation id', async () => {
    await store.insertQuote({ ...baseQuote, rfqId: 'r'.repeat(64) })
    const found = await store.findByRfqId('r'.repeat(64))
    expect(found?.id).toBe('swap-1')
  })
})

describe('OnchainReceiveSwapStore — migration', () => {
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
    // The exact pre-fees shape: receive_onchain_swap without payout_sats
    // (every other column as the current schema has them, nullable tails
    // included).
    db.exec(`
      CREATE TABLE receive_onchain_swap (
        id                            TEXT PRIMARY KEY,
        state                         TEXT NOT NULL,
        created_at                    INTEGER NOT NULL,
        updated_at                    INTEGER NOT NULL,
        payment_hash                  TEXT NOT NULL,
        amount_sats                   INTEGER NOT NULL,
        htlc_locktime                 INTEGER NOT NULL,
        refund_locktime               INTEGER NOT NULL,
        min_confirmations             INTEGER NOT NULL,
        provider_pubkey               TEXT NOT NULL,
        client_payout_pubkey          TEXT NOT NULL,
        server_pubkey                 TEXT NOT NULL,
        claim_delay                   INTEGER NOT NULL,
        refund_delay                  INTEGER NOT NULL,
        refund_without_receiver_delay INTEGER NOT NULL,
        emulator_pubkey               TEXT NOT NULL,
        pk_script                     TEXT NOT NULL,
        lockup_address                TEXT NOT NULL,
        refund_pk_script              TEXT NOT NULL,
        client_payout_pk_script       TEXT NOT NULL,
        htlc_pubkey                   TEXT NOT NULL,
        client_onchain_refund_pubkey  TEXT NOT NULL,
        onchain_address               TEXT NOT NULL,
        onchain_pk_script             TEXT NOT NULL,
        claim_packet                  TEXT NOT NULL,
        funding_txid                  TEXT,
        funding_vout                  INTEGER,
        arkade_fund_txid              TEXT,
        preimage                      TEXT,
        arkade_claim_txid             TEXT,
        onchain_claim_txid            TEXT,
        arkade_refund_txid            TEXT,
        refund_outcome                TEXT,
        failure_reason                TEXT,
        rfq_id                        TEXT
      );
    `)
    db.prepare(
      `INSERT INTO receive_onchain_swap (
        id, state, created_at, updated_at, payment_hash, amount_sats,
        htlc_locktime, refund_locktime, min_confirmations,
        provider_pubkey, client_payout_pubkey, server_pubkey, claim_delay, refund_delay, refund_without_receiver_delay, emulator_pubkey,
        pk_script, lockup_address, refund_pk_script, client_payout_pk_script,
        htlc_pubkey, client_onchain_refund_pubkey, onchain_address, onchain_pk_script, claim_packet
      ) VALUES ('pre-existing-row', 'quoted', 1, 1, ?, 50000, 1, 1, 1, 'bb', 'dd', 'cc', 1, 1, 1, 'ff', 'dd', 'tark1x', 'ee', '77', '22', '11', 'bcrt1x', '33', 'cA==')`,
    ).run('99'.repeat(32))

    const migrated = await OnchainReceiveSwapStore.open(driver, clock)
    const row = await migrated.get('pre-existing-row')
    // Quoted before fees existed: it charged nothing, so the payout WAS the
    // amount — the honest reading of a missing payout_sats, not a default.
    expect(row.payoutSats).toBe(50_000)
    // And the new column round-trips for rows quoted after the migration.
    await migrated.insertQuote(baseQuote)
    expect((await migrated.get('swap-1')).payoutSats).toBe(49_500)
  })
})
