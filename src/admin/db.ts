/**
 * Admin-owned durable state: settings overrides and the action audit log.
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
