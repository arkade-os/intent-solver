/** Every SQL statement the Lightning send store runs. */

// The unique index on payment_hash is PARTIAL on purpose: one LIVE swap per
// hash, but a 'refused' swap never moved money and never learned a preimage, so
// its still-valid invoice may be quoted again. Every other state blocks the
// hash — including terminal 'claimed'/'stuck', whose preimage the provider may
// KNOW: re-quoting one would invite a lockup the provider could take without
// paying again. (No SQL comments in this string: the D1 driver's exec flattens
// newlines, which would turn a `--` comment into a statement-eater.)
const SEND_SWAP_COLUMNS = `
  id                            TEXT PRIMARY KEY,
  state                         TEXT NOT NULL,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  invoice                       TEXT NOT NULL,
  payment_hash                  TEXT NOT NULL,
  amount_sats                   INTEGER NOT NULL,
  invoice_expires_at            INTEGER NOT NULL,
  quoted_refund_deadline        INTEGER,
  refund_locktime               INTEGER NOT NULL,
  sender_pubkey                 TEXT NOT NULL,
  receiver_pubkey               TEXT NOT NULL,
  server_pubkey                 TEXT NOT NULL,
  claim_delay                   INTEGER NOT NULL,
  refund_delay                  INTEGER NOT NULL,
  refund_without_receiver_delay INTEGER NOT NULL,
  pk_script                     TEXT NOT NULL,
  lockup_address                TEXT NOT NULL,
  refund_pk_script              TEXT,
  emulator_pubkey               TEXT,
  client_refund_pubkey          TEXT,
  receiver_pk_script            TEXT,
  non_interactive_parameters TEXT,
  refund_ark_txid               TEXT,
  refund_outcome                TEXT,
  refund_attempt                TEXT,
  payment_backend               TEXT,
  payment_wallet                TEXT,
  quoted_routing_fee_sats       INTEGER,
  fee_handle                    TEXT,
  lockup_txid                   TEXT,
  lockup_vout                   INTEGER,
  lockup_value                  INTEGER,
  idempotency_key               TEXT,
  pay_attempted_at              INTEGER,
  payment_id                    TEXT,
  preimage                      TEXT,
  claim_ark_txid                TEXT,
  claim_batch                   TEXT,
  failure_reason                TEXT,
  rfq_id                        TEXT,
  payment_evidence              TEXT,
  payment_failure_reason        TEXT,
  routing_fee_paid_sats         INTEGER,
  unrolled_claim                TEXT,
  lockup_outpoints              TEXT
`

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS send_swap (${SEND_SWAP_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_send_swap_state ON send_swap(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_send_swap_live_hash
  ON send_swap(payment_hash) WHERE state != 'refused';
-- Both partial: the columns are nullable and NULL is never what we look up, so
-- each index carries only the rows a lookup can match. rfq_id is the hot one --
-- findByRfqId runs on EVERY inbound rfq_request and rfq_status_request
-- (src/ingress/rfq.ts), so without it each request scanned the whole table.
-- lockup_txid is the cold one, but it is the only identifier an operator
-- actually has: the swap id is ours and appears in no UI, and a finished swap
-- is terminal so the list command will not show it either.
CREATE INDEX IF NOT EXISTS idx_send_swap_rfq_id
  ON send_swap(rfq_id) WHERE rfq_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_send_swap_lockup_txid
  ON send_swap(lockup_txid) WHERE lockup_txid IS NOT NULL;

CREATE TABLE IF NOT EXISTS send_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES send_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_send_swap_event_swap ON send_swap_event(swap_id);
`

/**
 * Columns an operator search matches against, for this corridor.
 *
 * Identifiers only — every one is something a user can hand you: the swap
 * id, the payment hash, the invoice, an address, a txid, the rfq id. Amounts
 * and timestamps are deliberately absent; they are filters, not identifiers,
 * and a substring match on a number matches far too much to be a search.
 *
 * Interpolated into SQL, so it lives here beside the schema rather than
 * anywhere a request can reach.
 */
export const SEND_SEARCH_COLUMNS: readonly string[] = [
  'id',
  'payment_hash',
  'invoice',
  'lockup_address',
  'lockup_txid',
  'claim_ark_txid',
  'refund_ark_txid',
  'unrolled_claim',
  'rfq_id',
]

/** Columns a database created before they existed is given on open. */
export const ADDED_COLUMNS: readonly (readonly [column: string, type: string])[] = [
  ['refund_attempt', 'TEXT'],
  ['payment_backend', 'TEXT'],
  ['payment_wallet', 'TEXT'],
  ['refund_pk_script', 'TEXT'],
  ['emulator_pubkey', 'TEXT'],
  ['refund_ark_txid', 'TEXT'],
  ['refund_outcome', 'TEXT'],
  ['rfq_id', 'TEXT'],
  ['client_refund_pubkey', 'TEXT'],
  ['receiver_pk_script', 'TEXT'],
  ['payment_evidence', 'TEXT'],
  ['payment_failure_reason', 'TEXT'],
  ['non_interactive_parameters', 'TEXT'],
  ['quoted_routing_fee_sats', 'INTEGER'],
  // Nothing reads or writes it; kept because dropping a column is a table rebuild.
  ['fee_handle', 'TEXT'],
  // INTEGER, matching the schema above rather than defaulting to TEXT: a
  // migrated database would otherwise give this column TEXT affinity and
  // store sats as strings, which reads back correctly through `Number()`
  // and sorts and sums wrongly the day anything asks SQLite to do either.
  ['routing_fee_paid_sats', 'INTEGER'],
  ['quoted_refund_deadline', 'INTEGER'],
  ['unrolled_claim', 'TEXT'],
  ['claim_batch', 'TEXT'],
  ['lockup_outpoints', 'TEXT'],
]

export const setClaimBatch = `UPDATE send_swap SET claim_batch = ?, updated_at = ?
       WHERE id = ? AND state = 'claiming' AND claim_batch IS ?`

export const tableInfo = `PRAGMA table_info(send_swap)`

export const dropNext = `DROP TABLE IF EXISTS send_swap_next`

export const dropTable = `DROP TABLE send_swap`

export const renameNext = `ALTER TABLE send_swap_next RENAME TO send_swap`

export const backfillExternalRefund = `UPDATE send_swap SET refund_outcome = 'external', refund_ark_txid = NULL
       WHERE refund_ark_txid = 'external' AND refund_outcome IS NULL`

export const backfillPushedRefund = `UPDATE send_swap SET refund_outcome = 'pushed'
       WHERE refund_ark_txid IS NOT NULL AND refund_outcome IS NULL`

export const indexList = `PRAGMA index_list(send_swap)`

export const byLockupTxid = 'SELECT * FROM send_swap WHERE lockup_txid = ? ORDER BY created_at DESC LIMIT 1'

export const liveByPaymentHash = `SELECT * FROM send_swap WHERE payment_hash = ?
       AND (state != 'refused' OR (COALESCE(lockup_value, 0) > 0 AND refund_outcome IS NULL)) LIMIT 1`

export const refundable = `SELECT * FROM send_swap
       WHERE state = 'refused'
         AND refund_outcome IS NULL
         AND refund_pk_script IS NOT NULL
         AND (client_refund_pubkey IS NOT NULL OR refund_locktime <= ?)
       ORDER BY created_at`

export const mostRecent = 'SELECT * FROM send_swap ORDER BY created_at DESC, rowid DESC LIMIT 1'

export const stateById = 'SELECT state FROM send_swap WHERE id = ?'

export const fundingNotes = "SELECT detail FROM send_swap_event WHERE swap_id = ? AND detail LIKE 'funding %'"

export const byId = 'SELECT * FROM send_swap WHERE id = ?'

export const insertQuote = `INSERT INTO send_swap (
        id, state, created_at, updated_at, invoice, payment_hash, amount_sats, invoice_expires_at,
        quoted_refund_deadline, refund_locktime, sender_pubkey, receiver_pubkey, server_pubkey,
        claim_delay, refund_delay, refund_without_receiver_delay, pk_script, lockup_address,
        refund_pk_script, emulator_pubkey, client_refund_pubkey, receiver_pk_script,
        non_interactive_parameters, quoted_routing_fee_sats, rfq_id
      ) SELECT ?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM send_swap WHERE payment_hash = ?
        AND (state != 'refused' OR (COALESCE(lockup_value, 0) > 0 AND refund_outcome IS NULL))
      )`

export const createNext = `CREATE TABLE send_swap_next (${SEND_SWAP_COLUMNS})`

export const copyIntoNext = (columns: string): string =>
  `INSERT INTO send_swap_next (${columns}) SELECT ${columns} FROM send_swap`

export const foreignKeys = (on: boolean): string => `PRAGMA foreign_keys = ${on ? 'ON' : 'OFF'}`

export const indexInfo = (index: string): string => `PRAGMA index_info(${index})`
