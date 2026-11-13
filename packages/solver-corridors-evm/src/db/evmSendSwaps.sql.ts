// No runtime migration on purpose (only unreleased staging databases lack these); run once by hand:
//   ALTER TABLE send_evm_swap ADD COLUMN valid_until INTEGER NOT NULL DEFAULT 0;
//   ALTER TABLE send_evm_swap ADD COLUMN refund_outcome TEXT;
// `DEFAULT 0` makes the next tick refuse every `quoted` row as expired, which is correct.
const COLUMNS = `
  id                            TEXT PRIMARY KEY,
  state                         TEXT NOT NULL,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  payment_hash                  TEXT NOT NULL,
  amount_sats                   INTEGER NOT NULL,
  payout_sats                   INTEGER,
  evm_amount                    TEXT NOT NULL,
  token_address                 TEXT NOT NULL,
  evm_contract_address          TEXT NOT NULL,
  evm_chain_id                   INTEGER NOT NULL,
  evm_timeout                    INTEGER NOT NULL,
  valid_until                    INTEGER NOT NULL,
  min_confirmations              INTEGER NOT NULL,
  min_age_seconds               INTEGER NOT NULL,
  evm_lock_txid                 TEXT,
  evm_refund_txid               TEXT,
  evm_claim_txid                TEXT,
  evm_claim_address             TEXT NOT NULL,
  evm_refund_address            TEXT NOT NULL,
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
  client_refund_pubkey          TEXT NOT NULL,
  receiver_pk_script            TEXT NOT NULL,
  non_interactive_parameters TEXT,
  preimage                      TEXT,
  claim_ark_txid                TEXT,
  refund_ark_txid               TEXT,
  refund_outcome                TEXT,
  rfq_id                        TEXT,
  failure_reason                TEXT
`

export const evmSendSwapSql = {
  createSchema: `
CREATE TABLE IF NOT EXISTS send_evm_swap (${COLUMNS});
CREATE INDEX IF NOT EXISTS idx_send_evm_swap_state ON send_evm_swap(state);
-- One LIVE row per payment hash, as in every other corridor: two lockups
-- against one hash means whichever client loses the race is claimed with no
-- refund.
CREATE UNIQUE INDEX IF NOT EXISTS idx_send_evm_swap_live_hash
  ON send_evm_swap(payment_hash) WHERE state != 'refused';
-- Partial for the reason the other corridors give: findByRfqId runs on every
-- inbound rfq_status_request and falls through every store.
CREATE INDEX IF NOT EXISTS idx_send_evm_swap_rfq_id
  ON send_evm_swap(rfq_id) WHERE rfq_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS send_evm_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES send_evm_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_send_evm_swap_event_swap ON send_evm_swap_event(swap_id);
`,
  selectRefundable: `SELECT * FROM send_evm_swap
       WHERE state = 'refused' AND refund_outcome IS NULL
       ORDER BY created_at`,
  // Keyed on entering `locking_evm`, not `evm_lock_txid`: that is patched after broadcast,
  // so a crash leaves it null over a lock still in the mempool.
  selectClosedOverLock: `SELECT * FROM send_evm_swap AS s
       WHERE s.state IN ('stuck', 'refunded') AND s.refund_locktime > ?
         AND EXISTS (SELECT 1 FROM send_evm_swap_event AS e
                     WHERE e.swap_id = s.id AND e.to_state = 'locking_evm')
       ORDER BY s.created_at`,
  claimRefundTxid:
    'UPDATE send_evm_swap SET updated_at = ?, evm_refund_txid = ? WHERE id = ? AND evm_refund_txid IS NULL',
} as const
