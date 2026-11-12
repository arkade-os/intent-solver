// SCHEMA HISTORY. `valid_until` was added after this table first shipped on
// the feat/evm-corridors branch; see the twin comment on send_evm_swap for the
// why and the failure modes. For a database predating that column:
//
//   ALTER TABLE receive_evm_swap ADD COLUMN valid_until INTEGER NOT NULL DEFAULT 0;
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
  payout_pubkey                 TEXT NOT NULL,
  preimage                      TEXT,
  fund_ark_txid                 TEXT,
  refund_ark_txid               TEXT,
  rfq_id                        TEXT,
  failure_reason                TEXT
`

export const evmReceiveSwapSql = {
  createSchema: `
CREATE TABLE IF NOT EXISTS receive_evm_swap (${COLUMNS});
CREATE INDEX IF NOT EXISTS idx_receive_evm_swap_state ON receive_evm_swap(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_receive_evm_swap_live_hash
  ON receive_evm_swap(payment_hash) WHERE state != 'refused';
CREATE INDEX IF NOT EXISTS idx_receive_evm_swap_rfq_id
  ON receive_evm_swap(rfq_id) WHERE rfq_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS receive_evm_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES receive_evm_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_receive_evm_swap_event_swap ON receive_evm_swap_event(swap_id);
`,
} as const
