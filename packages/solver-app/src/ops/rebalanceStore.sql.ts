/** Every SQL statement the rebalance transfer store runs, with its schema. */

const ACTIVE = "'submitting', 'pending', 'needs_reconciliation'"
export const SCHEMA = `
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
`

export const insertTransfer =
  'INSERT INTO rebalance_transfer (state, created_at, charged_at, debit_sats, data, id, request_key) VALUES (?, ?, ?, ?, ?, ?, ?)'

export const saveTransfer = `UPDATE rebalance_transfer SET state = ?, created_at = ?, charged_at = ?, debit_sats = ?, data = ?
       WHERE id = ? AND request_key = ?
       AND (state NOT IN (${ACTIVE}) OR ? NOT IN ('quoted', 'cancelled', 'failed'))
       AND (state NOT IN ('completed', 'refunded', 'failed', 'cancelled') OR state = ?)
       AND (charged_at IS NULL OR (charged_at = ? AND debit_sats = ?))`

export const byId = 'SELECT data FROM rebalance_transfer WHERE id = ?'

export const byRequestKey = 'SELECT data FROM rebalance_transfer WHERE request_key = ?'

export const list = 'SELECT data FROM rebalance_transfer ORDER BY created_at DESC, id DESC LIMIT ?'

export const page = (before: boolean): string =>
  `SELECT data, created_at AS createdAt, id FROM rebalance_transfer
       ${before ? 'WHERE created_at < ? OR (created_at = ? AND id < ?)' : ''}
       ORDER BY created_at DESC, id DESC LIMIT ?`

export const active = `SELECT data FROM rebalance_transfer WHERE state IN (${ACTIVE})`

export const protectedTerminalInputs =
  "SELECT data FROM rebalance_transfer WHERE charged_at IS NOT NULL AND state IN ('completed', 'refunded')"

export const checkpointTransfers = `SELECT data FROM rebalance_transfer WHERE charged_at >= ? OR state IN (${ACTIVE}) ORDER BY charged_at, id`

export const rollingDebit =
  "SELECT COALESCE(SUM(CAST(debit_sats AS INTEGER)), 0) AS total FROM rebalance_transfer WHERE charged_at > ? AND charged_at <= ? AND state NOT IN ('failed', 'cancelled')"

export const lastAttempt = `SELECT MAX(at) AS at FROM (
        SELECT COALESCE(MAX(charged_at), 0) AS at FROM rebalance_transfer
        UNION ALL SELECT last_attempt AS at FROM rebalance_clock WHERE id = 1
      )`

export const recordAttempt =
  'INSERT INTO rebalance_clock (id, last_attempt) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last_attempt = MAX(last_attempt, excluded.last_attempt)'
