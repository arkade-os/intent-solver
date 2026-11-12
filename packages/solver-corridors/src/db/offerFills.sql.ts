import { placeholders } from './baseSwapStore.sql.js'

const OFFER_FILL_COLUMNS = `
  id              TEXT PRIMARY KEY,
  state           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  offer_txid      TEXT NOT NULL,
  offer_vout      INTEGER NOT NULL,
  offer_pk_script TEXT NOT NULL,
  want_asset_id   TEXT,
  want_amount     TEXT NOT NULL,
  offer_asset_id  TEXT,
  offer_amount    TEXT NOT NULL,
  fill_txid       TEXT,
  failure_reason  TEXT,
  rfq_id          TEXT,
  fill_phase      TEXT
`

/** Every statement `OfferFillStore` runs. */
export const offerFillsSql = {
  schema: `
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
`,
  insertIntent: `INSERT INTO offer_fill (
         id, state, created_at, updated_at, offer_txid, offer_vout, offer_pk_script,
         want_asset_id, want_amount, offer_asset_id, offer_amount, fill_txid, failure_reason, rfq_id
       ) VALUES (?, 'fillable', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  selectById: `SELECT * FROM offer_fill WHERE id = ?`,
  selectLiveByOutpoint: `SELECT * FROM offer_fill WHERE offer_txid = ? AND offer_vout = ? AND state IN ('fillable', 'filling', 'filled')`,
  selectNewestByRfqId: `SELECT * FROM offer_fill WHERE rfq_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  selectInStates: (states: number) =>
    `SELECT * FROM offer_fill WHERE state IN (${placeholders(states)}) ORDER BY created_at ASC`,
  updateState: (columns: readonly string[]) =>
    `UPDATE offer_fill SET ${['state = ?', 'updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')} WHERE id = ? AND state = ?`,
  revertUnsubmitted: `UPDATE offer_fill SET state = 'fillable', fill_phase = NULL, updated_at = ?
       WHERE id = ? AND state = 'filling' AND fill_phase = 'selecting'`,
  markSubmitting: `UPDATE offer_fill SET fill_phase = 'submitting', updated_at = ?
       WHERE id = ? AND state = 'filling' AND fill_phase = 'selecting'`,
  insertEvent: `INSERT INTO offer_fill_event (fill_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?)`,
} as const
