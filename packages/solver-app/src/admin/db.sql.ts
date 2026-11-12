const SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_override (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_action (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  params  TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_action_at ON admin_action(at);

CREATE TABLE IF NOT EXISTS operator_withdrawal (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  source      TEXT NOT NULL,
  address     TEXT NOT NULL,
  amount_sats TEXT NOT NULL,
  fee_sats    TEXT,
  reference   TEXT,
  state       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operator_withdrawal_scope_at ON operator_withdrawal(scope, created_at);

CREATE TABLE IF NOT EXISTS balance_checkpoint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  complete INTEGER NOT NULL,
  snapshot TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_balance_checkpoint_scope ON balance_checkpoint(scope, complete, id);
CREATE INDEX IF NOT EXISTS idx_balance_checkpoint_latest ON balance_checkpoint(scope, id);

CREATE TABLE IF NOT EXISTS balance_report_checkpoint (
  scope TEXT PRIMARY KEY,
  checkpoint_id INTEGER NOT NULL
);

-- The asset markets this deployment trades, one row per PAIR.
--
-- Its own table rather than rows in admin_override, which is a scalar key/value
-- store: a market is a record of eleven fields, and getOverrides() hands
-- settings.ts a Record<string, string> it layers onto a Config field by field.
-- Packing a market into one JSON value would have to be special-cased out of
-- that path, and deleting ONE market is not "clearing a key" -- the two shapes
-- only look alike.
--
-- In THIS database rather than a sixth file, for the reason db/layout.ts gives
-- for the EVM tables: a table with no previous release has no file it already
-- has, so nothing can be stranded by putting it here, and a new suffixed path
-- would be another file for an operator to discover, back up and eventually
-- consolidate in service of a history it does not have. It lands in the
-- consolidated swap file or in the -admin one exactly as the two tables above
-- already do.
--
-- The key is DERIVED from the legs (see assetMarketConfig.assetMarketKey), so a
-- PRIMARY KEY on it is what makes one pair unrepresentable twice -- including
-- with its legs swapped, which would otherwise be two rows describing one market
-- with two different feeds.
CREATE TABLE IF NOT EXISTS admin_market (
  market_key      TEXT PRIMARY KEY,
  base            TEXT,
  quote           TEXT,
  base_decimals   INTEGER NOT NULL,
  quote_decimals  INTEGER NOT NULL,
  feed_url        TEXT NOT NULL,
  price_path      TEXT NOT NULL,
  tolerance_bps   INTEGER NOT NULL,
  fee_bps         INTEGER NOT NULL,
  sell_base_fee_flat TEXT NOT NULL DEFAULT '0',
  buy_base_fee_flat  TEXT NOT NULL DEFAULT '0',
  sell_base_fee_bps  INTEGER,
  buy_base_fee_bps   INTEGER,
  sell_base_min   TEXT,
  sell_base_max   TEXT,
  buy_base_min    TEXT,
  buy_base_max    TEXT,
  enabled         INTEGER NOT NULL,
  symbol          TEXT,
  serves_offer    INTEGER NOT NULL DEFAULT 0,
  serves_rfq      INTEGER NOT NULL DEFAULT 1,
  rfq_sell_base   INTEGER NOT NULL DEFAULT 1,
  rfq_buy_base    INTEGER NOT NULL DEFAULT 1,
  carrier_mode    TEXT NOT NULL DEFAULT 'inherit',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- One row per swap the approval gate has held. HERE rather than a column on
-- each swap table: that is why the gate needs no migration on the money path.
-- A NULL approved_at is the pending state, which the gate reads directly.
-- amount is TEXT and asset_id NULL-for-BTC for the reason assetRfqSwaps.ts
-- gives: an asset's atomic units outrun SQLite's signed 64-bit INTEGER.
CREATE TABLE IF NOT EXISTS admin_swap_approval (
  swap_id      TEXT PRIMARY KEY,
  corridor     TEXT NOT NULL,
  asset_id     TEXT,
  amount       TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  approved_at  INTEGER
);

-- Scalar notifier state. Not a row in admin_override: getOverrides() hands
-- settings.ts a Record it layers onto Config. The balance-change key is no
-- longer written; the table stays so a database that has it still opens.
CREATE TABLE IF NOT EXISTS admin_notify_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One-shot DATA migrations, by name. NOT a schema version: the ALTER loop below
-- is idempotent, so only a seed reading the ENVIRONMENT needs an explicit marker.
CREATE TABLE IF NOT EXISTS admin_migration (
  name TEXT PRIMARY KEY,
  at   INTEGER NOT NULL
);
`

// Exec'd AFTER migrate(): a table that shipped without `symbol` has no such
// column when SCHEMA runs. Partial, so an offer-only deployment's NULLs survive.
const MIGRATED_SCHEMA = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_market_symbol ON admin_market(symbol) WHERE symbol IS NOT NULL;
`

/** Columns {@link AdminStore} adds to tables an older release created, per table. */
export const adminColumnMigrations: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  [
    'admin_market',
    [
      ['sell_base_fee_flat', "TEXT NOT NULL DEFAULT '0'"],
      ['buy_base_fee_flat', "TEXT NOT NULL DEFAULT '0'"],
      ['sell_base_fee_bps', 'INTEGER'],
      ['buy_base_fee_bps', 'INTEGER'],
      ['symbol', 'TEXT'],
      // What a row an OLDER binary inserted means on roll-forward: offers have
      // always needed declaring, RFQ has always served any enabled one-leg row.
      ['serves_offer', 'INTEGER NOT NULL DEFAULT 0'],
      ['serves_rfq', 'INTEGER NOT NULL DEFAULT 1'],
      ['rfq_sell_base', 'INTEGER NOT NULL DEFAULT 1'],
      ['rfq_buy_base', 'INTEGER NOT NULL DEFAULT 1'],
      ['carrier_mode', "TEXT NOT NULL DEFAULT 'inherit'"],
    ],
  ],
  ['admin_action', [['revision', 'TEXT']]],
]

/** Every statement {@link AdminStore} runs. */
export const adminSql = {
  createSchema: SCHEMA,
  createMigratedIndexes: MIGRATED_SCHEMA,
  selectSwapApprovalColumns: "SELECT name FROM pragma_table_info('admin_swap_approval')",
  dropSwapApprovals: 'DROP TABLE admin_swap_approval',

  selectMigration: 'SELECT name FROM admin_migration WHERE name = ?',
  insertMigration: 'INSERT INTO admin_migration (name, at) VALUES (?, ?)',

  selectOverrides: 'SELECT key, value FROM admin_override',
  deleteOverride: 'DELETE FROM admin_override WHERE key = ?',
  upsertOverride:
    'INSERT INTO admin_override (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',

  selectMarkets: 'SELECT * FROM admin_market ORDER BY market_key',
  selectMarketPairs: 'SELECT base, quote FROM admin_market',
  selectMarket: 'SELECT * FROM admin_market WHERE market_key = ?',
  upsertMarket:
    'INSERT INTO admin_market (market_key, base, quote, base_decimals, quote_decimals, feed_url, price_path, ' +
    'tolerance_bps, fee_bps, sell_base_fee_flat, buy_base_fee_flat, sell_base_fee_bps, buy_base_fee_bps, ' +
    'sell_base_min, sell_base_max, buy_base_min, buy_base_max, enabled, symbol, serves_offer, serves_rfq, ' +
    'rfq_sell_base, rfq_buy_base, carrier_mode, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(market_key) DO UPDATE SET base = excluded.base, quote = excluded.quote, ' +
    'base_decimals = excluded.base_decimals, quote_decimals = excluded.quote_decimals, ' +
    'feed_url = excluded.feed_url, price_path = excluded.price_path, ' +
    'tolerance_bps = excluded.tolerance_bps, fee_bps = excluded.fee_bps, ' +
    'sell_base_fee_flat = excluded.sell_base_fee_flat, buy_base_fee_flat = excluded.buy_base_fee_flat, ' +
    'sell_base_fee_bps = excluded.sell_base_fee_bps, buy_base_fee_bps = excluded.buy_base_fee_bps, ' +
    'sell_base_min = excluded.sell_base_min, sell_base_max = excluded.sell_base_max, ' +
    'buy_base_min = excluded.buy_base_min, buy_base_max = excluded.buy_base_max, ' +
    'symbol = excluded.symbol, serves_offer = excluded.serves_offer, serves_rfq = excluded.serves_rfq, ' +
    'rfq_sell_base = excluded.rfq_sell_base, rfq_buy_base = excluded.rfq_buy_base, ' +
    'carrier_mode = excluded.carrier_mode, ' +
    'enabled = excluded.enabled, updated_at = excluded.updated_at',
  deleteMarket: 'DELETE FROM admin_market WHERE market_key = ?',
  seedMarketServing:
    'UPDATE admin_market SET symbol = ?, serves_offer = ?, serves_rfq = ?, rfq_sell_base = ?, ' +
    'rfq_buy_base = ? WHERE market_key = ?',
  setMarketServing:
    'UPDATE admin_market SET symbol = ?, serves_offer = ?, serves_rfq = ?, rfq_sell_base = ?, ' +
    'rfq_buy_base = ?, updated_at = ? WHERE market_key = ?',
  setMarketSymbol: 'UPDATE admin_market SET symbol = ? WHERE market_key = ?',
  clearMarketSymbol: 'UPDATE admin_market SET symbol = NULL WHERE market_key = ?',
  closeMarketRfq: 'UPDATE admin_market SET serves_rfq = 0 WHERE market_key = ?',

  insertBalanceCheckpoint: 'INSERT INTO balance_checkpoint (scope, complete, snapshot) VALUES (?, ?, ?) RETURNING id',
  selectLatestCompleteBalanceCheckpoint:
    'SELECT id, snapshot FROM balance_checkpoint WHERE scope = ? AND complete = 1 ORDER BY id DESC LIMIT 1',
  selectLatestBalanceCheckpoint: 'SELECT id, snapshot FROM balance_checkpoint WHERE scope = ? ORDER BY id DESC LIMIT 1',
  selectReportedBalanceCheckpoint:
    'SELECT c.id, c.snapshot FROM balance_checkpoint c JOIN balance_report_checkpoint r ' +
    'ON c.id = r.checkpoint_id AND c.scope = r.scope WHERE r.scope = ?',
  advanceBalanceReportCheckpoint:
    'INSERT INTO balance_report_checkpoint (scope, checkpoint_id) ' +
    'SELECT scope, id FROM balance_checkpoint WHERE id = ? AND complete = 1 ' +
    'ON CONFLICT(scope) DO UPDATE SET checkpoint_id = excluded.checkpoint_id ' +
    'WHERE excluded.checkpoint_id > balance_report_checkpoint.checkpoint_id',
  selectBalanceCheckpoints: 'SELECT id, snapshot FROM balance_checkpoint WHERE scope = ? ORDER BY id DESC LIMIT ?',

  insertAction:
    'INSERT INTO admin_action (at, action, target, params, outcome, detail, revision) VALUES (?, ?, ?, ?, ?, ?, ?)',
  selectNewestActions: 'SELECT * FROM admin_action ORDER BY at DESC, id DESC LIMIT ?',

  insertOperatorWithdrawal:
    'INSERT INTO operator_withdrawal (id, scope, source, address, amount_sats, state, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  selectOperatorWithdrawal: 'SELECT * FROM operator_withdrawal WHERE id = ?',
  transitionOperatorWithdrawal:
    'UPDATE operator_withdrawal SET state = ?, fee_sats = ?, reference = ?, updated_at = ? WHERE id = ? AND state = ?',
  selectOperatorWithdrawalsSince:
    "SELECT * FROM operator_withdrawal WHERE scope = ? AND (created_at >= ? OR state IN ('sending', 'uncertain')) " +
    'ORDER BY created_at, id',

  insertApprovalRequest:
    'INSERT INTO admin_swap_approval (swap_id, corridor, asset_id, amount, requested_at, approved_at) ' +
    'VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(swap_id) DO NOTHING',
  approveSwap: 'UPDATE admin_swap_approval SET approved_at = ? WHERE swap_id = ?',
  selectSwapApprovedAt: 'SELECT approved_at FROM admin_swap_approval WHERE swap_id = ?',
  selectPendingApprovals: 'SELECT * FROM admin_swap_approval WHERE approved_at IS NULL ORDER BY requested_at, swap_id',

  selectNotifyState: 'SELECT value FROM admin_notify_state WHERE key = ?',
  upsertNotifyState:
    'INSERT INTO admin_notify_state (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
} as const
