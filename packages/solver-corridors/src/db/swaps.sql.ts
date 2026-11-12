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

/** Every statement {@link SwapStore} runs beyond {@link baseSwapSql}, for `send_swap` and `send_swap_event`. */
export const swapsSql = {
  schema: `
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
`,

  tableInfo: `PRAGMA table_info(send_swap)`,
  indexList: `PRAGMA index_list(send_swap)`,
  indexInfo: (index: string) => `PRAGMA index_info(${index})`,
  setForeignKeys: (on: boolean) => `PRAGMA foreign_keys = ${on ? 'ON' : 'OFF'}`,
  dropRebuildTable: `DROP TABLE IF EXISTS send_swap_next`,
  createRebuildTable: `CREATE TABLE send_swap_next (${SEND_SWAP_COLUMNS})`,
  copyIntoRebuildTable: (names: string) => `INSERT INTO send_swap_next (${names}) SELECT ${names} FROM send_swap`,
  dropTable: `DROP TABLE send_swap`,
  renameRebuildTable: `ALTER TABLE send_swap_next RENAME TO send_swap`,
  backfillExternalRefundOutcome: `UPDATE send_swap SET refund_outcome = 'external', refund_ark_txid = NULL
       WHERE refund_ark_txid = 'external' AND refund_outcome IS NULL`,
  backfillPushedRefundOutcome: `UPDATE send_swap SET refund_outcome = 'pushed'
       WHERE refund_ark_txid IS NOT NULL AND refund_outcome IS NULL`,

  insertQuoteUnlessHashLive: `INSERT INTO send_swap (
        id, state, created_at, updated_at, invoice, payment_hash, amount_sats, invoice_expires_at,
        quoted_refund_deadline, refund_locktime, sender_pubkey, receiver_pubkey, server_pubkey,
        claim_delay, refund_delay, refund_without_receiver_delay, pk_script, lockup_address,
        refund_pk_script, emulator_pubkey, client_refund_pubkey, receiver_pk_script,
        non_interactive_parameters, quoted_routing_fee_sats, rfq_id
      ) SELECT ?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM send_swap WHERE payment_hash = ?
        AND (state != 'refused' OR (COALESCE(lockup_value, 0) > 0 AND refund_outcome IS NULL))
      )`,
  compareAndSwapClaimBatch: `UPDATE send_swap SET claim_batch = ?, updated_at = ?
       WHERE id = ? AND state = 'claiming' AND claim_batch IS ?`,
  selectNewestByLockupTxid: 'SELECT * FROM send_swap WHERE lockup_txid = ? ORDER BY created_at DESC LIMIT 1',
  selectBlockingByPaymentHash: `SELECT * FROM send_swap WHERE payment_hash = ?
       AND (state != 'refused' OR (COALESCE(lockup_value, 0) > 0 AND refund_outcome IS NULL)) LIMIT 1`,
  selectRefundable: `SELECT * FROM send_swap
       WHERE state = 'refused'
         AND refund_outcome IS NULL
         AND refund_pk_script IS NOT NULL
         AND (client_refund_pubkey IS NOT NULL OR refund_locktime <= ?)
       ORDER BY created_at`,
  selectMostRecent: 'SELECT * FROM send_swap ORDER BY created_at DESC, rowid DESC LIMIT 1',
  selectStateById: 'SELECT state FROM send_swap WHERE id = ?',
  selectFundingNotes: "SELECT detail FROM send_swap_event WHERE swap_id = ? AND detail LIKE 'funding %'",
} as const
