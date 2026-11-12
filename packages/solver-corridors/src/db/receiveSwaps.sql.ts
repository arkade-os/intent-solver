// The unique index on payment_hash is PARTIAL for the identical reason
// `send_swap`'s is: one LIVE swap per hash, but a `refused` swap never funded
// anything and never learned a preimage, so its hash may be re-quoted.
const RECEIVE_SWAP_COLUMNS = `
  id                            TEXT PRIMARY KEY,
  state                         TEXT NOT NULL,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  payment_hash                  TEXT NOT NULL,
  amount_sats                   INTEGER NOT NULL,
  payout_sats                   INTEGER NOT NULL,
  invoice                       TEXT NOT NULL,
  invoice_expires_at            INTEGER NOT NULL,
  htlc_expires_at                INTEGER,
  payout_address                TEXT NOT NULL,
  payout_pk_script               TEXT NOT NULL,
  payout_pubkey                  TEXT NOT NULL,
  claim_packet                  TEXT NOT NULL,
  refund_locktime               INTEGER NOT NULL,
  solver_pubkey                  TEXT NOT NULL,
  server_pubkey                  TEXT NOT NULL,
  claim_delay                    INTEGER NOT NULL,
  refund_delay                   INTEGER NOT NULL,
  refund_without_receiver_delay  INTEGER NOT NULL,
  emulator_pubkey                TEXT NOT NULL,
  pk_script                     TEXT NOT NULL,
  lockup_address                 TEXT NOT NULL,
  solver_refund_pk_script         TEXT NOT NULL,
  non_interactive_parameters TEXT,
  arkade_lockup_txid             TEXT,
  arkade_lockup_vout             INTEGER,
  arkade_lockup_value            INTEGER,
  revealed_at                    INTEGER,
  stamped_at                     INTEGER,
  settle_attempted_at            INTEGER,
  preimage                      TEXT,
  refund_ark_txid                TEXT,
  failure_reason                TEXT,
  rfq_id                        TEXT,
  fund_started_at               INTEGER,
  invoice_wallet_fingerprint    TEXT,
  invoice_backend_name          TEXT,
  unrolled_refund               TEXT
`

/** Every statement {@link ReceiveSwapStore} runs beyond {@link baseSwapSql}, for `receive_swap` and `receive_swap_event`. */
export const receiveSwapsSql = {
  schema: `
CREATE TABLE IF NOT EXISTS receive_swap (${RECEIVE_SWAP_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_receive_swap_state ON receive_swap(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_receive_swap_live_hash
  ON receive_swap(payment_hash) WHERE state != 'refused';
-- Partial for the same reason as send_swap's: findByRfqId runs on every
-- inbound rfq_status_request, which falls through all four corridors' stores.
CREATE INDEX IF NOT EXISTS idx_receive_swap_rfq_id
  ON receive_swap(rfq_id) WHERE rfq_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS receive_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES receive_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_receive_swap_event_swap ON receive_swap_event(swap_id);
`,
  insertQuote: `INSERT INTO receive_swap (
        id, state, created_at, updated_at, payment_hash, amount_sats, payout_sats, invoice, invoice_expires_at,
        payout_address, payout_pk_script, payout_pubkey, claim_packet,
        refund_locktime, solver_pubkey, server_pubkey, claim_delay, refund_delay, refund_without_receiver_delay,
        emulator_pubkey, pk_script, lockup_address, solver_refund_pk_script,
        non_interactive_parameters, rfq_id, invoice_wallet_fingerprint, invoice_backend_name
      ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
} as const
