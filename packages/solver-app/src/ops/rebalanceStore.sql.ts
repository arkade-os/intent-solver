const ACTIVE = "'submitting', 'pending', 'needs_reconciliation'"

/** Every statement {@link RebalanceStore} runs. */
export const rebalanceSql = {
  createSchema: `
CREATE TABLE IF NOT EXISTS rebalance_transfer (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  charged_at INTEGER,
  debit_sats TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rebalance_critical_source
  ON rebalance_transfer ((1)) WHERE state IN ('submitting', 'needs_reconciliation');
DROP INDEX IF EXISTS idx_rebalance_active_source;
CREATE INDEX IF NOT EXISTS idx_rebalance_charged ON rebalance_transfer (charged_at);
CREATE INDEX IF NOT EXISTS idx_rebalance_history ON rebalance_transfer (created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS rebalance_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt INTEGER NOT NULL
);
`,
  insertTransfer:
    'INSERT INTO rebalance_transfer (state, created_at, charged_at, debit_sats, data, id, request_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
  saveTransfer: `UPDATE rebalance_transfer SET state = ?, created_at = ?, charged_at = ?, debit_sats = ?, data = ?
       WHERE id = ? AND request_key = ?
       AND (state NOT IN (${ACTIVE}) OR ? NOT IN ('quoted', 'cancelled', 'failed'))
       AND (state NOT IN ('completed', 'refunded', 'failed', 'cancelled') OR state = ?)
       AND (charged_at IS NULL OR (charged_at = ? AND debit_sats = ?))`,
  selectTransferById: 'SELECT data FROM rebalance_transfer WHERE id = ?',
  selectTransferByRequestKey: 'SELECT data FROM rebalance_transfer WHERE request_key = ?',
  selectNewestTransfers: 'SELECT data FROM rebalance_transfer ORDER BY created_at DESC, id DESC LIMIT ?',
  selectTransferPage: (before: boolean) => `SELECT data, created_at AS createdAt, id FROM rebalance_transfer
       ${before ? 'WHERE created_at < ? OR (created_at = ? AND id < ?)' : ''}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
  selectActiveTransfers: `SELECT data FROM rebalance_transfer WHERE state IN (${ACTIVE})`,
  selectChargedTerminalTransfers:
    "SELECT data FROM rebalance_transfer WHERE charged_at IS NOT NULL AND state IN ('completed', 'refunded')",
  selectCheckpointTransfers: `SELECT data FROM rebalance_transfer WHERE charged_at >= ? OR state IN (${ACTIVE}) ORDER BY charged_at, id`,
  sumChargedDebitInWindow:
    "SELECT COALESCE(SUM(CAST(debit_sats AS INTEGER)), 0) AS total FROM rebalance_transfer WHERE charged_at > ? AND charged_at <= ? AND state NOT IN ('failed', 'cancelled')",
  selectLastAttempt: `SELECT MAX(at) AS at FROM (
        SELECT COALESCE(MAX(charged_at), 0) AS at FROM rebalance_transfer
        UNION ALL SELECT last_attempt AS at FROM rebalance_clock WHERE id = 1
      )`,
  recordAttempt:
    'INSERT INTO rebalance_clock (id, last_attempt) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last_attempt = MAX(last_attempt, excluded.last_attempt)',
} as const

/** Every statement {@link SqliteRebalanceRfqRepository} runs. */
export const rebalanceRfqSql = {
  createTable:
    'CREATE TABLE IF NOT EXISTS rebalance_rfq (rfq_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, fund_amount INTEGER NOT NULL, valid_until INTEGER NOT NULL)',
  insert: 'INSERT INTO rebalance_rfq (rfq_id, record_json, fund_amount, valid_until) VALUES (?, ?, ?, ?)',
  selectById: 'SELECT record_json, fund_amount, valid_until FROM rebalance_rfq WHERE rfq_id = ?',
  updateRecord: 'UPDATE rebalance_rfq SET record_json = ? WHERE rfq_id = ?',
  selectAllRecords: 'SELECT record_json FROM rebalance_rfq',
  deleteById: 'DELETE FROM rebalance_rfq WHERE rfq_id = ?',
} as const
