import { tableInfo } from './baseSwapStore.sql.js'

const COLUMNS = `
  id               TEXT PRIMARY KEY,
  state            TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  rfq_id           TEXT NOT NULL,
  pair             TEXT NOT NULL,
  from_asset_id    TEXT,
  from_amount      TEXT NOT NULL,
  to_asset_id      TEXT,
  to_amount        TEXT NOT NULL,
  maker_pk_script  TEXT NOT NULL,
  maker_public_key TEXT NOT NULL,
  offer_pk_script  TEXT NOT NULL,
  offer_address    TEXT NOT NULL,
  solver_pubkey    TEXT NOT NULL,
  valid_until      INTEGER NOT NULL,
  deposit_txid     TEXT,
  deposit_vout     INTEGER,
  fill_txid        TEXT,
  failure_reason   TEXT,
  quote_implied_mantissa TEXT,
  quote_implied_scale    INTEGER,
  quote_gives_base       INTEGER,
  fill_price_mantissa    TEXT,
  fill_price_scale       INTEGER,
  fill_phase             TEXT
`

/** Every statement `AssetRfqSwapStore` runs beyond `BaseSwapStore`'s. */
export const assetRfqSwapsSql = {
  schema: `
CREATE TABLE IF NOT EXISTS asset_rfq_swap (${COLUMNS});
CREATE INDEX IF NOT EXISTS idx_asset_rfq_swap_state ON asset_rfq_swap(state);

-- § 4.5's natural key. The atomic class has no payment hash, and the spec says
-- so outright: "a profile without one — the atomic class today — is identified
-- by rfq_id alone". UNIQUE across ALL states, not merely the live ones: a
-- reused rfq_id is a conflict whatever became of the first negotiation, which
-- is the rule the two send legs already enforce by looking the id up.
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_rfq_swap_rfq_id ON asset_rfq_swap(rfq_id);

-- Two LIVE rows must never watch one offer address. Identical terms derive an
-- identical covenant (§ 7.2), so two negotiations can legitimately land on the
-- same script — and a single deposit there would then have two rows claiming
-- it, of which at most one fill can succeed. Partial, so a lapsed or stuck
-- negotiation does not block a later legitimate one at the same address.
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_rfq_swap_live_offer
  ON asset_rfq_swap(offer_pk_script) WHERE state IN ('quoted', 'funded', 'filling', 'filled');

CREATE TABLE IF NOT EXISTS asset_rfq_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES asset_rfq_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_asset_rfq_swap_event_swap ON asset_rfq_swap_event(swap_id);
`,
  tableInfo: tableInfo('asset_rfq_swap'),
  recordFillMark: `UPDATE asset_rfq_swap SET fill_price_mantissa = ?, fill_price_scale = ? WHERE id = ?`,
  insertQuote: `INSERT INTO asset_rfq_swap (
         id, state, created_at, updated_at, rfq_id, pair, from_asset_id, from_amount,
         to_asset_id, to_amount, maker_pk_script, maker_public_key, offer_pk_script,
         offer_address, solver_pubkey, valid_until, deposit_txid, deposit_vout, fill_txid, failure_reason,
         quote_implied_mantissa, quote_implied_scale, quote_gives_base
       ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
  selectById: `SELECT * FROM asset_rfq_swap WHERE id = ?`,
  selectLiveByOfferScript: `SELECT * FROM asset_rfq_swap WHERE offer_pk_script = ? AND state IN ('quoted', 'funded', 'filling', 'filled')`,
  selectFillingBtcPayouts: (byPair: boolean) =>
    `SELECT to_amount FROM asset_rfq_swap WHERE state = 'filling' AND to_asset_id IS NULL` +
    (byPair ? ' AND pair = ?' : ''),
  selectUpdatedInWindow: (byPair: boolean) =>
    `SELECT * FROM asset_rfq_swap WHERE updated_at >= ? AND updated_at < ?` +
    (byPair ? ' AND pair = ?' : '') +
    ` ORDER BY updated_at DESC LIMIT ?`,
  revertUnsubmitted: `UPDATE asset_rfq_swap SET state = 'funded', fill_phase = NULL, updated_at = ?
       WHERE id = ? AND state = 'filling' AND fill_phase = 'selecting'`,
  markSubmitting: `UPDATE asset_rfq_swap SET fill_phase = 'submitting', updated_at = ?
       WHERE id = ? AND state = 'filling' AND fill_phase = 'selecting'`,
} as const
