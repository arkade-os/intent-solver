import { placeholders } from './baseSwapStore.sql.js'

const SEND_ONCHAIN_SWAP_COLUMNS = `
  id                            TEXT PRIMARY KEY,
  state                         TEXT NOT NULL,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  payment_hash                  TEXT NOT NULL,
  amount_sats                   INTEGER NOT NULL,
  payout_sats                   INTEGER NOT NULL,
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
  htlc_pubkey                   TEXT NOT NULL,
  htlc_locktime                 INTEGER NOT NULL,
  min_confirmations             INTEGER NOT NULL,
  onchain_address                TEXT NOT NULL,
  onchain_pk_script              TEXT NOT NULL,
  onchain_lockup_txid           TEXT,
  onchain_lockup_vout           INTEGER,
  onchain_lockup_value          INTEGER,
  funding_txid                  TEXT,
  funding_vout                  INTEGER,
  preimage                      TEXT,
  claim_ark_txid                TEXT,
  onchain_refund_txid           TEXT,
  onchain_refund_fee_rate       REAL,
  onchain_refund_broadcast_at   INTEGER,
  onchain_refund_prior_txids    TEXT,
  refund_ark_txid               TEXT,
  refund_outcome                TEXT,
  failure_reason                TEXT,
  rfq_id                        TEXT,
  fund_started_at               INTEGER,
  funding_tx                    TEXT,
  unrolled_claim                TEXT,
  lockup_outpoints              TEXT
`

/** Every statement `OnchainSendSwapStore` runs beyond `BaseSwapStore`'s. */
export const onchainSwapsSql = {
  schema: `
CREATE TABLE IF NOT EXISTS send_onchain_swap (${SEND_ONCHAIN_SWAP_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_send_onchain_swap_state ON send_onchain_swap(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_send_onchain_swap_live_hash
  ON send_onchain_swap(payment_hash) WHERE state != 'refused';
-- Partial for the same reason as send_swap's: findByRfqId runs on every
-- inbound rfq_status_request, which falls through all four corridors' stores.
CREATE INDEX IF NOT EXISTS idx_send_onchain_swap_rfq_id
  ON send_onchain_swap(rfq_id) WHERE rfq_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS send_onchain_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES send_onchain_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_send_onchain_swap_event_swap ON send_onchain_swap_event(swap_id);
`,
  sumOwedPayoutInStates: (states: number) =>
    `SELECT COALESCE(SUM(COALESCE(payout_sats, amount_sats)), 0) AS total
         FROM send_onchain_swap WHERE state IN (${placeholders(states)})`,
  fundingTxUnrecorded: 'funding_tx IS NULL',
  recordFundingTx: `UPDATE send_onchain_swap SET funding_tx = ?, updated_at = ?
       WHERE id = ? AND state = 'funding_onchain' AND funding_tx IS NULL`,
  insertQuote: `INSERT INTO send_onchain_swap (
        id, state, created_at, updated_at, payment_hash, amount_sats, payout_sats, refund_locktime,
        provider_pubkey, server_pubkey, claim_delay, refund_delay, refund_without_receiver_delay,
        pk_script, lockup_address, refund_pk_script, emulator_pubkey, client_refund_pubkey, receiver_pk_script,
        non_interactive_parameters,
        payout_pubkey, htlc_pubkey, htlc_locktime, min_confirmations,
        onchain_address, onchain_pk_script, rfq_id
      ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  selectRefundable: `SELECT * FROM send_onchain_swap
       WHERE state = 'refused'
         AND refund_outcome IS NULL
         AND (client_refund_pubkey IS NOT NULL OR refund_locktime <= ?)
       ORDER BY created_at`,
  selectReleasable: `SELECT * FROM send_onchain_swap
       WHERE state = 'refunded' AND refund_outcome IS NULL AND updated_at <= ?
       ORDER BY created_at`,
} as const
