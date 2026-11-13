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
 * Follows the same shape as the swap stores (statements in a sibling `db.sql.ts`,
 * private constructor, `open()` taking a driver or a path) so it is read and
 * maintained like the rest of `src/db/`.
 */

import { betterSqliteDriver, type SqlDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { addColumns } from '@arkade-os/solver-corridors/db/baseSwapStore.js'
import {
  assetMarketKey,
  rfqSymbolFor,
  type AssetMarketConfig,
  type CarrierMode,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { adminColumnMigrations, adminSql } from './db.sql.js'
import { servingFor, type AssetRfqToken, type ServingFields } from '../ops/assetRfqMarkets.js'
import type { BalanceCheckpoint } from '../ops/balanceCheckpoints.js'

export const MARKET_SERVING_SEED = 'market-serving-seed-v1'

/** The environment's answer, for the ONE boot that finds the marker absent. */
export interface ServingSeed {
  offerMarkets: readonly { a: string | null; b: string | null }[]
  tokens: readonly AssetRfqToken[]
}

/** A swap the gate is holding. `assetId` null is BTC and `amount` is sats. */
export interface SwapApprovalRequest {
  swapId: string
  corridor: string
  assetId: string | null
  amount: bigint
}

export interface SwapApprovalRow extends SwapApprovalRequest {
  requestedAt: number
}

export interface AuditEntry {
  action: string
  /** What it acted on — a swap id, usually. Null for whole-wallet actions. */
  target: string | null
  /** JSON, ALREADY REDACTED by the caller. Never carries key material. */
  params: string
  outcome: 'ok' | 'error'
  detail: string | null
  /** Groups every row one save wrote, so a partial save is legible. */
  revision?: string | null
}

export interface AuditRow extends AuditEntry {
  id: number
  at: number
}

export type OperatorWithdrawalState = 'preparing' | 'sending' | 'sent' | 'uncertain' | 'failed'

export interface OperatorWithdrawal {
  id: string
  scope: string
  source: string
  address: string
  amountSats: number
  feeSats: number | null
  reference: string | null
  state: OperatorWithdrawalState
  createdAt: number
  updatedAt: number
}

const operatorWithdrawalFrom = (row: Record<string, string | number | null>): OperatorWithdrawal => ({
  id: String(row.id),
  scope: String(row.scope),
  source: String(row.source),
  address: String(row.address),
  amountSats: Number(row.amount_sats),
  feeSats: row.fee_sats === null ? null : Number(row.fee_sats),
  reference: row.reference === null ? null : String(row.reference),
  state: String(row.state) as OperatorWithdrawalState,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

const nonnegativeSats = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be non-negative safe integer sats`)
}

const operatorWithdrawalTransitions: Record<OperatorWithdrawalState, readonly OperatorWithdrawalState[]> = {
  preparing: ['sending', 'uncertain', 'failed'],
  sending: ['sent', 'uncertain'],
  uncertain: ['sent', 'failed'],
  sent: [],
  failed: [],
}

export interface AdminOverrideRow {
  key: string
  value: string
  updated_at: number
}

export interface AdminNotifyStateRow {
  key: string
  value: string
  updated_at: number
}

export interface AdminMigrationRow {
  name: string
  at: number
}

/** `snapshot` is the JSON of a {@link BalanceCheckpoint} without its id. */
export interface BalanceCheckpointRow {
  id: number
  scope: string
  complete: 0 | 1
  snapshot: string
}

export interface BalanceReportCheckpointRow {
  scope: string
  checkpoint_id: number
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

// Unrecognised reads as `inherit`: a row nobody can read is a row nobody can delete.
const carrierModeFrom = (raw: string | number | null | undefined): CarrierMode =>
  raw === 'off' || raw === 'priced' ? raw : 'inherit'

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
  sellBaseFeeFlat: BigInt(String(raw.sell_base_fee_flat ?? 0)),
  buyBaseFeeFlat: BigInt(String(raw.buy_base_fee_flat ?? 0)),
  ...(raw.sell_base_fee_bps === null || raw.sell_base_fee_bps === undefined
    ? {}
    : { sellBaseFeeBps: Number(raw.sell_base_fee_bps) }),
  ...(raw.buy_base_fee_bps === null || raw.buy_base_fee_bps === undefined
    ? {}
    : { buyBaseFeeBps: Number(raw.buy_base_fee_bps) }),
  sellBase: boundsFrom(raw.sell_base_min, raw.sell_base_max),
  buyBase: boundsFrom(raw.buy_base_min, raw.buy_base_max),
  symbol: raw.symbol === null || raw.symbol === undefined ? null : String(raw.symbol),
  servesOffer: Number(raw.serves_offer ?? 0) === 1,
  servesRfq: Number(raw.serves_rfq ?? 1) === 1,
  rfqSellBase: Number(raw.rfq_sell_base ?? 1) === 1,
  rfqBuyBase: Number(raw.rfq_buy_base ?? 1) === 1,
  carrierMode: carrierModeFrom(raw.carrier_mode),
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

/** DROPPED, not altered: `amount_sats` is NOT NULL, so ADD COLUMN still fails every insert. */
const dropLegacyApprovals = async (driver: SqlDriver): Promise<void> => {
  let columns: { name: string }[]
  try {
    columns = await driver.all<{ name: string }>(adminSql.selectSwapApprovalColumns)
  } catch {
    // A driver that cannot answer the pragma leaves the table alone rather than
    // failing the boot: `d1Driver` is a SqlDriver too, and this runs at startup.
    return
  }
  if (columns.some((column) => column.name === 'amount_sats')) {
    await driver.exec(adminSql.dropSwapApprovals)
  }
}
export interface AdminRepository {
  readonly repairedServing: readonly string[]
  close(): Promise<void>
  getOverrides(): Promise<Record<string, string>>
  setOverride(key: string, value: string | null): Promise<void>
  setOverrideWithAudit(key: string, value: string | null, entry: AuditEntry): Promise<void>
  revertToConfig(
    serving: readonly { marketKey: string; fields: ServingFields }[],
    overrideKeys: readonly string[],
    entry: AuditEntry,
  ): Promise<void>
  listMarkets(): Promise<AssetMarketRow[]>
  getMarket(marketKey: string): Promise<AssetMarketRow | null>
  putMarket(market: AssetMarketConfig): Promise<AssetMarketRow>
  deleteMarket(marketKey: string): Promise<boolean>
  recordBalanceCheckpoint(entry: Omit<BalanceCheckpoint, 'id'>): Promise<BalanceCheckpoint>
  latestCompleteBalanceCheckpoint(scope: string): Promise<BalanceCheckpoint | undefined>
  latestBalanceCheckpoint(scope: string): Promise<BalanceCheckpoint | undefined>
  previousBalanceReportCheckpoint(scope: string): Promise<BalanceCheckpoint | undefined>
  markBalanceReportCheckpoint(id: number): Promise<void>
  listBalanceCheckpoints(scope: string, limit?: number): Promise<BalanceCheckpoint[]>
  recordAction(entry: AuditEntry): Promise<void>
  createOperatorWithdrawal(input: {
    id: string
    scope: string
    source: string
    address: string
    amountSats: number
  }): Promise<OperatorWithdrawal>
  getOperatorWithdrawal(id: string): Promise<OperatorWithdrawal | undefined>
  transitionOperatorWithdrawal(
    id: string,
    from: OperatorWithdrawalState,
    to: OperatorWithdrawalState,
    data?: { feeSats?: number; reference?: string },
  ): Promise<OperatorWithdrawal>
  listOperatorWithdrawals(scope: string, since: number): Promise<OperatorWithdrawal[]>
  recordApprovalRequest(request: SwapApprovalRequest): Promise<boolean>
  approveSwap(swapId: string): Promise<boolean>
  isSwapApproved(swapId: string): Promise<boolean>
  listPendingApprovals(): Promise<SwapApprovalRow[]>
  listActions(limit?: number): Promise<AuditRow[]>
}

export class AdminStore implements AdminRepository {
  private repaired: readonly string[] = []

  private constructor(
    private readonly driver: SqlDriver,
    private readonly now: () => number,
  ) {}

  /** One operator-readable sentence per row the boot repair touched; empty on a healthy file. */
  get repairedServing(): readonly string[] {
    return this.repaired
  }

  /**
   * `seed` absent means do not consult the ENVIRONMENT and do not mark. It does
   * NOT mean "no writes": `exec(SCHEMA)` and `migrate()` run on every opener.
   */
  static async open(
    driver: SqlDriver | string,
    now: () => number = nowSeconds,
    seed?: ServingSeed,
  ): Promise<AdminStore> {
    const store = new AdminStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await dropLegacyApprovals(store.driver)
    await store.driver.exec(adminSql.createSchema)
    await store.migrate()
    // MUST stay: the symbol index names a column the ALTER loop adds, so SCHEMA cannot carry it.
    await store.driver.exec(adminSql.createMigratedIndexes)
    if (seed) await store.seedServing(seed)
    // AFTER the seed, and unconditional: a pre-upgrade row is old, not unhealthy,
    // and judging one before the seed resolves it reports a repair it overwrites.
    await store.repairServing()
    return store
  }

  /**
   * Read the environment into the rows, ONCE. The marker is explicit (every
   * candidate signal in the data is a supported state) and written in the SAME
   * transaction, so no crash half-seeds rows beneath a marker saying they are
   * done. `carrier_mode` is left out: `inherit` IS the environment's answer.
   */
  private async seedServing(seed: ServingSeed): Promise<void> {
    const done = await this.driver.get<Pick<AdminMigrationRow, 'name'>>(adminSql.selectMigration, [MARKET_SERVING_SEED])
    if (done) return
    const rows = await this.listMarkets()
    const taken = new Set<string>()
    await this.driver.transaction(async () => {
      for (const row of rows) {
        const serving = servingFor(row, seed, taken)
        if (serving.symbol !== null) taken.add(serving.symbol)
        await this.driver.run(adminSql.seedMarketServing, [
          serving.symbol,
          serving.servesOffer ? 1 : 0,
          serving.servesRfq ? 1 : 0,
          serving.rfqSellBase ? 1 : 0,
          serving.rfqBuyBase ? 1 : 0,
          row.marketKey,
        ])
      }
      await this.driver.run(adminSql.insertMigration, [MARKET_SERVING_SEED, this.now()])
    })
  }

  private async migrate(): Promise<void> {
    for (const [table, columns] of adminColumnMigrations) await addColumns(this.driver, table, columns)
  }

  /**
   * Make every row's serving fields internally coherent, whatever wrote them.
   * NOT marker-gated and NOT env-gated, unlike `seedServing`: `serves_rfq = 1`
   * beside a NULL symbol is unreachable through `validateAssetMarket`, so it
   * means only that a binary predating these columns INSERTed the row, which a
   * rollback allows long after the marker was written. Throwing instead would
   * be a permanent boot failure fixable only by hand SQL. Each row's repair is
   * independent and idempotent, so no transaction wraps them.
   * A row this fails closed STOPS quoting: `assetRfqMarketsFrom` drops it on
   * `servesRfq`. The notes record what was written to the row, so an operator
   * can see exactly what the boot touched.
   */
  private async repairServing(): Promise<void> {
    const rows = await this.listMarkets()
    const taken = new Set(rows.flatMap((row) => (row.symbol === null ? [] : [row.symbol])))
    const notes: string[] = []
    for (const row of rows) {
      if (!row.servesRfq) continue
      const assetId = row.base !== null && row.quote !== null ? null : (row.base ?? row.quote)
      const close = (why: string): void => void notes.push(`${row.marketKey}: ${why}; wrote serves_rfq = 0 to the row.`)
      if (assetId === null) {
        close('an asset on both legs cannot be expressed over RFQ')
      } else if (row.symbol === null) {
        const symbol = rfqSymbolFor(assetId)
        // Fail-OPEN, and only here: this is the symbol `assetRfqMarketsFrom` already derives for an un-named asset.
        if (taken.has(symbol)) close(`symbol ${symbol} is already carried by another market`)
        else {
          taken.add(symbol)
          notes.push(
            `${row.marketKey}: no symbol stored; wrote symbol = ${symbol} to the row, the stem an older binary ` +
              `served when the config named no asset for it.`,
          )
          await this.driver.run(adminSql.setMarketSymbol, [symbol, row.marketKey])
          continue
        }
      } else if (!row.rfqSellBase && !row.rfqBuyBase) {
        close('both RFQ directions are closed')
      } else continue
      await this.driver.run(adminSql.closeMarketRfq, [row.marketKey])
    }
    this.repaired = notes
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  /** Every override, as raw strings. Interpreting them is `settings.ts`'s job. */
  async getOverrides(): Promise<Record<string, string>> {
    const rows = await this.driver.all<Pick<AdminOverrideRow, 'key' | 'value'>>(adminSql.selectOverrides)
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
      await this.driver.run(adminSql.deleteOverride, [key])
      return
    }
    await this.driver.run(adminSql.upsertOverride, [key, value, this.now()])
  }

  async setOverrideWithAudit(key: string, value: string | null, entry: AuditEntry): Promise<void> {
    await this.driver.transaction(async () => {
      await this.setOverride(key, value)
      await this.recordAction(entry)
    })
  }

  /** The console's own state put back to what the config implies, in one transaction with its audit row. */
  async revertToConfig(
    serving: readonly { marketKey: string; fields: ServingFields }[],
    overrideKeys: readonly string[],
    entry: AuditEntry,
  ): Promise<void> {
    await this.driver.transaction(async () => {
      // Symbols first, all of them: a symbol moving between rows would otherwise meet itself in the unique index.
      for (const { marketKey } of serving) {
        await this.driver.run(adminSql.clearMarketSymbol, [marketKey])
      }
      for (const { marketKey, fields } of serving) {
        await this.driver.run(adminSql.setMarketServing, [
          fields.symbol,
          fields.servesOffer ? 1 : 0,
          fields.servesRfq ? 1 : 0,
          fields.rfqSellBase ? 1 : 0,
          fields.rfqBuyBase ? 1 : 0,
          this.now(),
          marketKey,
        ])
      }
      for (const key of overrideKeys) await this.setOverride(key, null)
      await this.recordAction(entry)
    })
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
    const rows = await this.driver.all<MarketRaw>(adminSql.selectMarkets)
    return rows.map(marketFrom)
  }

  async getMarket(marketKey: string): Promise<AssetMarketRow | null> {
    const rows = await this.driver.all<MarketRaw>(adminSql.selectMarket, [marketKey])
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
    await this.driver.run(adminSql.upsertMarket, [
      key,
      market.base,
      market.quote,
      market.baseDecimals,
      market.quoteDecimals,
      market.feedUrl,
      market.pricePath,
      market.toleranceBps,
      market.feeBps,
      String(market.sellBaseFeeFlat ?? 0n),
      String(market.buyBaseFeeFlat ?? 0n),
      market.sellBaseFeeBps ?? null,
      market.buyBaseFeeBps ?? null,
      // Decimal strings, per the note on `boundsFrom`. `null` for both halves
      // when the direction inherits the deployment-wide pair.
      market.sellBase === null ? null : String(market.sellBase.min),
      market.sellBase === null ? null : String(market.sellBase.max),
      market.buyBase === null ? null : String(market.buyBase.min),
      market.buyBase === null ? null : String(market.buyBase.max),
      market.enabled ? 1 : 0,
      market.symbol ?? null,
      market.servesOffer ? 1 : 0,
      market.servesRfq ? 1 : 0,
      market.rfqSellBase ? 1 : 0,
      market.rfqBuyBase ? 1 : 0,
      market.carrierMode,
      at,
      at,
    ])
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
    await this.driver.run(adminSql.deleteMarket, [marketKey])
    return true
  }

  async recordBalanceCheckpoint(entry: Omit<BalanceCheckpoint, 'id'>): Promise<BalanceCheckpoint> {
    const row = await this.driver.get<Pick<BalanceCheckpointRow, 'id'>>(adminSql.insertBalanceCheckpoint, [
      entry.scope,
      entry.totalSats === null ? 0 : 1,
      JSON.stringify(entry),
    ])
    if (!row) throw new Error('balance checkpoint insert returned no id')
    return { ...entry, id: row.id }
  }

  async latestCompleteBalanceCheckpoint(scope: string): Promise<BalanceCheckpoint | undefined> {
    const row = await this.driver.get<Pick<BalanceCheckpointRow, 'id' | 'snapshot'>>(
      adminSql.selectLatestCompleteBalanceCheckpoint,
      [scope],
    )
    return row ? { ...JSON.parse(row.snapshot), id: row.id } : undefined
  }

  async latestBalanceCheckpoint(scope: string): Promise<BalanceCheckpoint | undefined> {
    const row = await this.driver.get<Pick<BalanceCheckpointRow, 'id' | 'snapshot'>>(
      adminSql.selectLatestBalanceCheckpoint,
      [scope],
    )
    return row ? { ...JSON.parse(row.snapshot), id: row.id } : undefined
  }

  async previousBalanceReportCheckpoint(scope: string): Promise<BalanceCheckpoint | undefined> {
    const row = await this.driver.get<Pick<BalanceCheckpointRow, 'id' | 'snapshot'>>(
      adminSql.selectReportedBalanceCheckpoint,
      [scope],
    )
    return row ? { ...JSON.parse(row.snapshot), id: row.id } : undefined
  }

  async markBalanceReportCheckpoint(id: number): Promise<void> {
    await this.driver.run(adminSql.advanceBalanceReportCheckpoint, [id])
  }

  async listBalanceCheckpoints(scope: string, limit = 100): Promise<BalanceCheckpoint[]> {
    const rows = await this.driver.all<Pick<BalanceCheckpointRow, 'id' | 'snapshot'>>(
      adminSql.selectBalanceCheckpoints,
      [scope, limit],
    )
    return rows.map((row) => ({ ...JSON.parse(row.snapshot), id: row.id }))
  }

  async recordAction(entry: AuditEntry): Promise<void> {
    await this.driver.run(adminSql.insertAction, [
      this.now(),
      entry.action,
      entry.target,
      entry.params,
      entry.outcome,
      entry.detail,
      entry.revision ?? null,
    ])
  }

  async createOperatorWithdrawal(input: {
    id: string
    scope: string
    source: string
    address: string
    amountSats: number
  }): Promise<OperatorWithdrawal> {
    for (const field of ['id', 'scope', 'source', 'address'] as const) {
      if (!input[field]) throw new Error(`operator withdrawal ${field} is required`)
    }
    nonnegativeSats(input.amountSats, 'operator withdrawal amount')
    if (input.amountSats === 0) throw new Error('operator withdrawal amount must be positive')
    const at = this.now()
    await this.driver.run(adminSql.insertOperatorWithdrawal, [
      input.id,
      input.scope,
      input.source,
      input.address,
      String(input.amountSats),
      'preparing',
      at,
      at,
    ])
    const row = await this.getOperatorWithdrawal(input.id)
    if (!row) throw new Error('operator withdrawal insert returned no row')
    return row
  }

  async getOperatorWithdrawal(id: string): Promise<OperatorWithdrawal | undefined> {
    const row = await this.driver.get<Record<string, string | number | null>>(adminSql.selectOperatorWithdrawal, [id])
    return row ? operatorWithdrawalFrom(row) : undefined
  }

  async transitionOperatorWithdrawal(
    id: string,
    from: OperatorWithdrawalState,
    to: OperatorWithdrawalState,
    data: { feeSats?: number; reference?: string } = {},
  ): Promise<OperatorWithdrawal> {
    if (!operatorWithdrawalTransitions[from].includes(to))
      throw new Error(`invalid operator withdrawal transition ${from} -> ${to}`)
    if (data.feeSats !== undefined) nonnegativeSats(data.feeSats, 'operator withdrawal fee')
    const previous = await this.getOperatorWithdrawal(id)
    if (!previous || previous.state !== from) throw new Error(`operator withdrawal ${id} is not ${from}`)
    const feeSats = data.feeSats ?? previous.feeSats
    const reference = data.reference ?? previous.reference
    if (to === 'sent' && (feeSats === null || !reference))
      throw new Error('sent operator withdrawal requires fee and transaction reference')
    const result = await this.driver.run(adminSql.transitionOperatorWithdrawal, [
      to,
      feeSats === null ? null : String(feeSats),
      reference,
      this.now(),
      id,
      from,
    ])
    if (result.changes !== 1) throw new Error(`operator withdrawal ${id} changed before transition`)
    const row = await this.getOperatorWithdrawal(id)
    if (!row) throw new Error(`operator withdrawal ${id} vanished after transition`)
    return row
  }

  /** Keeps sending/uncertain rows reachable even when they predate `since`. */
  async listOperatorWithdrawals(scope: string, since: number): Promise<OperatorWithdrawal[]> {
    if (!scope) throw new Error('operator withdrawal scope is required')
    if (!Number.isSafeInteger(since) || since < 0) throw new Error('operator withdrawal cursor must be non-negative')
    const rows = await this.driver.all<Record<string, string | number | null>>(
      adminSql.selectOperatorWithdrawalsSince,
      [scope, since],
    )
    return rows.map(operatorWithdrawalFrom)
  }

  /**
   * Idempotent; answers whether the row was NEW, which is what stops the
   * notifier firing once per tick. `DO NOTHING` so a re-record cannot move
   * `requested_at` — its age is the operator's remaining window.
   */
  async recordApprovalRequest(request: SwapApprovalRequest): Promise<boolean> {
    const result = await this.driver.run(adminSql.insertApprovalRequest, [
      request.swapId,
      request.corridor,
      request.assetId,
      request.amount.toString(),
      this.now(),
    ])
    return result.changes === 1
  }

  /**
   * False when there was nothing to approve: an operator cannot pre-authorise an
   * id the gate never held, which is the one way this table could wave a swap
   * through before anyone saw it.
   */
  async approveSwap(swapId: string): Promise<boolean> {
    const result = await this.driver.run(adminSql.approveSwap, [this.now(), swapId])
    return result.changes === 1
  }

  /** THROWS on a sick database rather than answering false — the caller turns that into a HOLD. */
  async isSwapApproved(swapId: string): Promise<boolean> {
    const row = await this.driver.get<{ approved_at: number | null }>(adminSql.selectSwapApprovedAt, [swapId])
    return row !== undefined && row !== null && row.approved_at !== null
  }

  /** What is waiting on a human, oldest first — the order they should be answered in. */
  async listPendingApprovals(): Promise<SwapApprovalRow[]> {
    const rows = await this.driver.all<Record<string, string | number | null>>(adminSql.selectPendingApprovals)
    return rows.map((row) => ({
      swapId: String(row.swap_id),
      corridor: String(row.corridor),
      assetId: row.asset_id === null || row.asset_id === undefined ? null : String(row.asset_id),
      amount: BigInt(String(row.amount)),
      requestedAt: Number(row.requested_at),
    }))
  }

  /**
   * Newest first. The `id` tie-break matters: several actions can land in the
   * same second, and an operator reading a refund followed by its retry needs
   * them in the order they happened.
   */
  async listActions(limit = 200): Promise<AuditRow[]> {
    const rows = await this.driver.all<Record<string, string | number | null>>(adminSql.selectNewestActions, [limit])
    return rows.map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      action: String(row.action),
      target: row.target === null ? null : String(row.target),
      params: String(row.params),
      outcome: String(row.outcome) as 'ok' | 'error',
      detail: row.detail === null ? null : String(row.detail),
      revision: row.revision === null ? null : String(row.revision),
    }))
  }
}
