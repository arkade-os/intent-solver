/** Every SQL statement the offer fill store runs. */

const OFFER_FILL_COLUMNS = `
  id              TEXT PRIMARY KEY,
  state           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  offer_txid      TEXT NOT NULL,
  offer_vout      INTEGER NOT NULL,
  offer_pk_script TEXT NOT NULL,
  contract_version TEXT,
  want_asset_id   TEXT,
  want_amount     TEXT NOT NULL,
  offer_asset_id  TEXT,
  offer_amount    TEXT NOT NULL,
  fill_txid       TEXT,
  failure_reason  TEXT,
  rfq_id          TEXT,
  fill_phase      TEXT
`

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS offer_fill (${OFFER_FILL_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_offer_fill_state ON offer_fill(state);

-- The whole reason a row exists before anything is submitted. Two workers that
-- both like the same offer must not both send fulfill for it: the second insert
-- loses here, before either spends. Partial on the live states so a lost or
-- stuck row does not block a later, legitimate re-attempt at the same outpoint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_offer_fill_live_outpoint
  ON offer_fill(offer_txid, offer_vout) WHERE state IN ('fillable', 'filling', 'filled');

CREATE INDEX IF NOT EXISTS idx_offer_fill_rfq_id
  ON offer_fill(rfq_id) WHERE rfq_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS offer_fill_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  fill_id    TEXT NOT NULL REFERENCES offer_fill(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_offer_fill_event_fill ON offer_fill_event(fill_id);
`

export const ADDED_COLUMNS: readonly (readonly [column: string, type: string])[] = [
  ['contract_version', 'TEXT'],
  ['fill_phase', 'TEXT'],
]

export const insertIntent = `INSERT INTO offer_fill (
         id, state, created_at, updated_at, offer_txid, offer_vout, offer_pk_script, contract_version,
         want_asset_id, want_amount, offer_asset_id, offer_amount, fill_txid, failure_reason, rfq_id
       ) VALUES (?, 'fillable', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`

export const byId = `SELECT * FROM offer_fill WHERE id = ?`

export const liveByOutpoint = `SELECT * FROM offer_fill WHERE offer_txid = ? AND offer_vout = ? AND state IN ('fillable', 'filling', 'filled')`

export const byRfqId = `SELECT * FROM offer_fill WHERE rfq_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`

export const nonTerminal = (placeholders: string): string =>
  `SELECT * FROM offer_fill WHERE state IN (${placeholders}) ORDER BY created_at ASC`

export const transition = (assignments: string): string =>
  `UPDATE offer_fill SET ${assignments} WHERE id = ? AND state = ?`

export const revertFilling = `UPDATE offer_fill SET state = 'fillable', fill_phase = NULL, updated_at = ?
       WHERE id = ? AND state = 'filling' AND fill_phase = ?`

export const loseRejectedSubmit = `UPDATE offer_fill SET state = 'lost', fill_phase = NULL, failure_reason = ?, updated_at = ?
       WHERE id = ? AND state = 'filling' AND fill_phase IN ('selecting', 'submitting')`

export const markSubmitting = `UPDATE offer_fill SET fill_phase = 'submitting', updated_at = ?
       WHERE id = ? AND state = 'filling' AND fill_phase = 'selecting'`

export const recordEvent = `INSERT INTO offer_fill_event (fill_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?)`
