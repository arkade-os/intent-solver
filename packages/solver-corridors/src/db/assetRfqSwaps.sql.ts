/** Every SQL statement the asset RFQ swap store runs. */

const COLUMNS = `
  id               TEXT PRIMARY KEY,
  state            TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  rfq_id           TEXT NOT NULL,
  pair             TEXT NOT NULL,
  from_asset_id    TEXT,
  from_amount      TEXT NOT NULL,
  from_decimals    INTEGER,
  from_flat_fee    TEXT,
  to_asset_id      TEXT,
  to_amount        TEXT NOT NULL,
  to_decimals      INTEGER,
  to_spread        TEXT,
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
  fill_phase             TEXT,
  contract_version       TEXT,
  emulator_pubkey        TEXT
`

export const schema = (holdsOfferScriptStates: string): string => `
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
  ON asset_rfq_swap(offer_pk_script) WHERE state IN (${holdsOfferScriptStates});

CREATE TABLE IF NOT EXISTS asset_rfq_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES asset_rfq_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_asset_rfq_swap_event_swap ON asset_rfq_swap_event(swap_id);
`

export const tableInfo = `PRAGMA table_info(asset_rfq_swap)`

export const ADDED_COLUMNS: readonly (readonly [column: string, type: string])[] = [
  ['quote_implied_mantissa', 'TEXT'],
  ['quote_implied_scale', 'INTEGER'],
  ['quote_gives_base', 'INTEGER'],
  ['from_decimals', 'INTEGER'],
  ['from_flat_fee', 'TEXT'],
  ['to_decimals', 'INTEGER'],
  ['to_spread', 'TEXT'],
  ['fill_price_mantissa', 'TEXT'],
  ['fill_price_scale', 'INTEGER'],
  ['fill_phase', 'TEXT'],
  ['contract_version', 'TEXT'],
  ['emulator_pubkey', 'TEXT'],
]

export const legacyDirectedQuote = (contractVersion: string): string => `contract_version = '${contractVersion}'`

export const createLegacyDirectedOfferIndex = (legacyDirected: string): string =>
  `CREATE INDEX IF NOT EXISTS idx_asset_rfq_swap_legacy_directed_offer
      ON asset_rfq_swap(offer_pk_script) WHERE ${legacyDirected}`

export const recordFillMark = `UPDATE asset_rfq_swap SET fill_price_mantissa = ?, fill_price_scale = ? WHERE id = ?`

export const insertQuote = `INSERT INTO asset_rfq_swap (
         id, state, created_at, updated_at, rfq_id, pair, from_asset_id, from_amount,
         from_decimals, from_flat_fee, to_asset_id, to_amount, to_decimals, to_spread,
         maker_pk_script, maker_public_key, offer_pk_script,
         offer_address, solver_pubkey, valid_until, deposit_txid, deposit_vout, fill_txid, failure_reason,
         quote_implied_mantissa, quote_implied_scale, quote_gives_base, contract_version, emulator_pubkey
       ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`

export const byId = `SELECT * FROM asset_rfq_swap WHERE id = ?`

export const liveByOfferScript = (holdsOfferScriptStates: string): string =>
  `SELECT * FROM asset_rfq_swap WHERE offer_pk_script = ? AND state IN (${holdsOfferScriptStates})`

export const heldByLiveNegotiation = (liveStates: string): string =>
  `SELECT 1 AS held FROM asset_rfq_swap WHERE offer_pk_script = ? AND state IN (${liveStates})`

export const hasLegacyDirectedQuote = (legacyDirected: string): string =>
  `SELECT 1 FROM asset_rfq_swap WHERE offer_pk_script = ? AND ${legacyDirected} LIMIT 1`

export const committedSats = (outgoingStates: string, byPair: boolean): string =>
  `SELECT to_amount FROM asset_rfq_swap WHERE state IN (${outgoingStates}) AND to_asset_id IS NULL` +
  (byPair ? ' AND pair = ?' : '')

export const ledgerRows = (byPair: boolean): string =>
  `SELECT * FROM asset_rfq_swap WHERE updated_at >= ? AND updated_at < ?` +
  (byPair ? ' AND pair = ?' : '') +
  ` ORDER BY updated_at DESC LIMIT ?`

export const revertFilling = `UPDATE asset_rfq_swap SET state = 'funded', fill_phase = NULL, updated_at = ?
       WHERE id = ? AND state = 'filling' AND fill_phase = ?`

export const phaseIsSubmitting = `fill_phase = 'submitting'`

export const markSubmitting = `UPDATE asset_rfq_swap SET fill_phase = 'submitting', updated_at = ?
       WHERE id = ? AND state = 'filling' AND fill_phase = 'selecting'`
