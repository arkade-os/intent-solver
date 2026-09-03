/**
 * Admin-owned durable state: settings overrides, asset markets, and the action
 * audit log.
 *
 * Its own database file, derived from SWAP_DB_PATH the same way the other four
 * swap databases are. Separate because those are the money-critical files —
 * the ones on the Docker volume, the ones whose schema every orchestrator
 * depends on — and an operator convenience has no business sharing a schema
 * with them. Losing this file loses preferences and history; losing a swap
 * database loses funds. The two deserve different blast radii.
 *
 * Follows the same shape as the swap stores (module-scoped SCHEMA, private
 * constructor, `open()` taking a driver or a path) so it is read and
 * maintained like the rest of `src/db/`.
 */

import { betterSqliteDriver, type SqlDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { assetMarketKey, type AssetMarketConfig } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'

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
  sell_base_min   TEXT,
  sell_base_max   TEXT,
  buy_base_min    TEXT,
  buy_base_max    TEXT,
  enabled         INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
`

export interface AuditEntry {
  action: string
  /** What it acted on — a swap id, usually. Null for whole-wallet actions. */
  target: string | null
  /** JSON, ALREADY REDACTED by the caller. Never carries key material. */
  params: string
  outcome: 'ok' | 'error'
  detail: string | null
}

export interface AuditRow extends AuditEntry {
  id: number
  at: number
}

/** A stored market, plus the key it is filed under and when it last moved. */
export interface AssetMarketRow extends AssetMarketConfig {
  /** The canonical § 2 market key — derived from the legs, never supplied. */
  marketKey: string
  createdAt: number
  updatedAt: number
}

type MarketRaw = Record<string, string | number | null>

/**
 * Bounds are TEXT, not INTEGER, for the reason `db/offerFills.ts` states: an
 * asset amount is a bigint in atomic units and SQLite's INTEGER is a signed
 * 64-bit, so a bound the protocol admits is one the column would silently
 * mangle. Stored as the canonical decimal string and parsed back.
 */
const boundsFrom = (
  min: string | number | null | undefined,
  max: string | number | null | undefined,
): AssetMarketConfig['sellBase'] =>
  // `undefined` as well as null, because `noUncheckedIndexedAccess` is on and a
  // column absent from a row reads as undefined rather than throwing. Treated as
  // "unbounded" — the same answer as NULL — so a driver that omits nulls cannot
  // turn an inherited bound into a crash inside BigInt().
  min === null || min === undefined || max === null || max === undefined
    ? null
    : { min: BigInt(String(min)), max: BigInt(String(max)) }

const marketFrom = (raw: MarketRaw): AssetMarketRow => ({
  marketKey: String(raw.market_key),
  // NULL is the BTC leg, and `String(null)` would turn it into the four-letter
  // string "null" — a leg id nothing matches and nothing refuses.
  base: raw.base === null ? null : String(raw.base),
  quote: raw.quote === null ? null : String(raw.quote),
  baseDecimals: Number(raw.base_decimals),
  quoteDecimals: Number(raw.quote_decimals),
  feedUrl: String(raw.feed_url),
  pricePath: String(raw.price_path),
  toleranceBps: Number(raw.tolerance_bps),
  feeBps: Number(raw.fee_bps),
  sellBase: boundsFrom(raw.sell_base_min, raw.sell_base_max),
  buyBase: boundsFrom(raw.buy_base_min, raw.buy_base_max),
  enabled: Number(raw.enabled) === 1,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
})

/**
 * Beside the swap database, never inside it — the same suffixing rule
 * `onchainDbPath`/`receiveDbPath` in `src/cli.ts` use, including the
 * extensionless case, so all five database paths are derived identically.
 */
export const adminDbPath = (swapDbPath: string): string =>
  swapDbPath.endsWith('.sqlite') ? swapDbPath.replace(/\.sqlite$/, '-admin.sqlite') : `${swapDbPath}-admin`

export class AdminStore {
  private constructor(
    private readonly driver: SqlDriver,
    private readonly now: () => number,
  ) {}

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<AdminStore> {
    const store = new AdminStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    return store
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  /** Every override, as raw strings. Interpreting them is `settings.ts`'s job. */
  async getOverrides(): Promise<Record<string, string>> {
    const rows = await this.driver.all<{ key: string; value: string }>('SELECT key, value FROM admin_override')
    return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]))
  }

  /**
   * Set an override, or clear it with null.
   *
   * Clearing DELETES rather than storing an empty string, so "no override"
   * has exactly one representation and `getOverrides()` never hands the
   * layering code a value it has to special-case.
   */
  async setOverride(key: string, value: string | null): Promise<void> {
    if (value === null) {
      await this.driver.run('DELETE FROM admin_override WHERE key = ?', [key])
      return
    }
    await this.driver.run(
      'INSERT INTO admin_override (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, value, this.now()],
    )
  }

  /**
   * Every configured market, disabled ones included.
   *
   * Ordered by key so two reads of an unchanged table answer identically — the
   * console lists these and a set that reshuffles between polls is unreadable.
   *
   * NOT validated here. The store's job is what is on disk; deciding whether a
   * row is one this solver may act on belongs to `assetMarketConfig.ts`, and
   * putting it here would leave a bad row unreadable and therefore
   * un-deletable from the console.
   */
  async listMarkets(): Promise<AssetMarketRow[]> {
    const rows = await this.driver.all<MarketRaw>('SELECT * FROM admin_market ORDER BY market_key')
    return rows.map(marketFrom)
  }

  async getMarket(marketKey: string): Promise<AssetMarketRow | null> {
    const rows = await this.driver.all<MarketRaw>('SELECT * FROM admin_market WHERE market_key = ?', [marketKey])
    return rows[0] ? marketFrom(rows[0]) : null
  }

  /**
   * Insert or replace one market, filed under the key its own legs derive.
   *
   * UPSERT rather than separate create and update, because the key is derived:
   * an operator re-submitting a pair they already have is editing it, and there
   * is no third thing that could mean. `created_at` survives an edit — a market
   * edited today is not a market added today, and the audit question an
   * operator asks of this table is "how long have we been trading this pair".
   */
  async putMarket(market: AssetMarketConfig): Promise<AssetMarketRow> {
    const key = assetMarketKey(market.base, market.quote)
    const at = this.now()
    await this.driver.run(
      'INSERT INTO admin_market (market_key, base, quote, base_decimals, quote_decimals, feed_url, price_path, ' +
        'tolerance_bps, fee_bps, sell_base_min, sell_base_max, buy_base_min, buy_base_max, enabled, created_at, ' +
        'updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(market_key) DO UPDATE SET base = excluded.base, quote = excluded.quote, ' +
        'base_decimals = excluded.base_decimals, quote_decimals = excluded.quote_decimals, ' +
        'feed_url = excluded.feed_url, price_path = excluded.price_path, ' +
        'tolerance_bps = excluded.tolerance_bps, fee_bps = excluded.fee_bps, ' +
        'sell_base_min = excluded.sell_base_min, sell_base_max = excluded.sell_base_max, ' +
        'buy_base_min = excluded.buy_base_min, buy_base_max = excluded.buy_base_max, ' +
        'enabled = excluded.enabled, updated_at = excluded.updated_at',
      [
        key,
        market.base,
        market.quote,
        market.baseDecimals,
        market.quoteDecimals,
        market.feedUrl,
        market.pricePath,
        market.toleranceBps,
        market.feeBps,
        // Decimal strings, per the note on `boundsFrom`. `null` for both halves
        // when the direction inherits the deployment-wide pair.
        market.sellBase === null ? null : String(market.sellBase.min),
        market.sellBase === null ? null : String(market.sellBase.max),
        market.buyBase === null ? null : String(market.buyBase.min),
        market.buyBase === null ? null : String(market.buyBase.max),
        market.enabled ? 1 : 0,
        at,
        at,
      ],
    )
    // Read back rather than returned from the argument: `created_at` is the
    // ORIGINAL insert's on an edit, and echoing `at` would report a market as
    // added at the moment its spread was last nudged.
    const row = await this.getMarket(key)
    if (!row) throw new Error(`market ${key} vanished immediately after being written`)
    return row
  }

  /** True when a row was removed, false when the key named nothing. */
  async deleteMarket(marketKey: string): Promise<boolean> {
    const before = await this.getMarket(marketKey)
    if (!before) return false
    await this.driver.run('DELETE FROM admin_market WHERE market_key = ?', [marketKey])
    return true
  }

  async recordAction(entry: AuditEntry): Promise<void> {
    await this.driver.run(
      'INSERT INTO admin_action (at, action, target, params, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)',
      [this.now(), entry.action, entry.target, entry.params, entry.outcome, entry.detail],
    )
  }

  /**
   * Newest first. The `id` tie-break matters: several actions can land in the
   * same second, and an operator reading a refund followed by its retry needs
   * them in the order they happened.
   */
  async listActions(limit = 200): Promise<AuditRow[]> {
    const rows = await this.driver.all<Record<string, string | number | null>>(
      'SELECT * FROM admin_action ORDER BY at DESC, id DESC LIMIT ?',
      [limit],
    )
    return rows.map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      action: String(row.action),
      target: row.target === null ? null : String(row.target),
      params: String(row.params),
      outcome: String(row.outcome) as 'ok' | 'error',
      detail: row.detail === null ? null : String(row.detail),
    }))
  }
}
