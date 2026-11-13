import type { SqlDriver } from './driver.js'
import { addColumn, baseSwapSql, tableInfo, type BaseSwapSql } from './baseSwapStore.sql.js'
import {
  pageQuery,
  takePage,
  type FindByStatesOptions,
  type PageOptions,
  type PageRawFields,
} from '@arkade-os/solver-core/core/page.js'
import { announceTransition, type TransitionHook } from '@arkade-os/solver-core/core/businessEvent.js'
import { clampLedgerLimit, type LedgerWindow } from '@arkade-os/solver-core/analytics/economics.js'

export type RawRow = Record<string, unknown>

/** `fail()` routes to `stuck` / `refused`, so a store whose states lack either must not compile. */
type FailStatesIn<State extends string> = 'stuck' | 'refused' extends State
  ? unknown
  : { 'State must include stuck and refused': never }

export interface StoreShape<Row, State extends string> {
  readonly table: string
  readonly eventTable: string
  /** Not derived from {@link lifecycleLabel}: that would reword `onchain send swap`, an error operators grep for. */
  readonly noun: string
  readonly lifecycleLabel: string
  readonly searchColumns: readonly string[]
  readonly legalEdges: Readonly<Record<State, readonly State[]>>
  readonly transitionColumns: ReadonlySet<string>
  readonly patchColumns: ReadonlySet<string>
  /** Non-terminal states — what the sweep drives and what `committedSats` sums. */
  readonly live: readonly State[]
  /** States in which the solver may have paid out and not been made whole. */
  readonly exposed: readonly State[]
  toRow(raw: RawRow): Row
}

export const assertColumns = (columns: string[], allowed: ReadonlySet<string>, method: string): void => {
  for (const column of columns) {
    if (!allowed.has(column)) throw new Error(`${method} may not set column '${column}'`)
  }
}

/** A nullable column; `undefined` (a column this database predates) reads as null too. */
export const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

/** NULL, a claim from before this column, escalates like `submitting`: that version may have submitted. */
export type FillPhase = 'selecting' | 'submitting'

export const numberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

/** A space-separated txid column: the earlier versions of a spend this row has replaced, oldest last. */
export const txidList = (value: unknown): string[] =>
  value === null || value === undefined ? [] : String(value).split(' ').filter(Boolean)

/** Additive migration: `CREATE TABLE IF NOT EXISTS` never alters an existing table. */
const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const SQL_COLUMN_TYPE = /^(TEXT|INTEGER|REAL|BLOB)( NOT NULL)?( DEFAULT (-?\d+|'[^']*'))?$/

export const addColumns = async (
  driver: SqlDriver,
  table: string,
  columns: readonly (readonly [column: string, type: string])[],
): Promise<void> => {
  for (const name of [table, ...columns.map(([column]) => column)]) {
    if (!SQL_IDENTIFIER.test(name)) throw new Error(`addColumns: not a plain SQL identifier: ${name}`)
  }
  for (const [, type] of columns) {
    if (!SQL_COLUMN_TYPE.test(type)) throw new Error(`addColumns: not a plain column type: ${type}`)
  }
  const existing = new Set((await driver.all<{ name: string }>(tableInfo(table))).map((c) => c.name))
  for (const [column, type] of columns) {
    if (!existing.has(column)) await driver.exec(addColumn(table, column, type))
  }
}

export interface SwapRepository<Row, State extends string> {
  onTransition?: TransitionHook
  close(): Promise<void>
  get(id: string): Promise<Row>
  findByRfqId(rfqId: string): Promise<Row | null>
  findByPkScript(pkScript: string): Promise<Row | null>
  findByPaymentHash(paymentHash: string): Promise<Row | null>
  findLiveByPaymentHash(paymentHash: string): Promise<Row | null>
  committedSats(): Promise<number>
  countByStates(states: readonly State[]): Promise<number>
  findByStates(states: readonly State[], options?: FindByStatesOptions): Promise<Row[]>
  findRecoverable(): Promise<Row[]>
  ledgerRows(window: LedgerWindow): Promise<{ rows: Row[]; truncated: boolean }>
  page(options?: PageOptions): Promise<{ rows: Row[]; nextCursor: string | null }>
  history(swapId: string): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]>
  transition(id: string, from: State, to: State, fields?: Partial<Record<string, unknown>>): Promise<boolean>
  patch(id: string, fields: Record<string, unknown>): Promise<void>
  fail(id: string, from: State, reason: string): Promise<void>
}

export abstract class BaseSwapStore<Row, State extends string> implements SwapRepository<Row, State> {
  protected constructor(
    protected readonly driver: SqlDriver,
    protected readonly now: () => number,
  ) {}

  /** A subclass field, installed only AFTER `super()` returns (`useDefineForClassFields`): the base constructor must not read it. */
  protected abstract readonly shape: StoreShape<Row, State> & FailStatesIn<State>

  #sql?: BaseSwapSql
  protected get sql(): BaseSwapSql {
    return (this.#sql ??= baseSwapSql(this.shape.table, this.shape.eventTable))
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  async get(id: string): Promise<Row> {
    const raw = await this.driver.get<RawRow>(this.sql.selectById, [id])
    if (!raw) throw new Error(`${this.shape.noun} ${id} not found`)
    return this.shape.toRow(raw)
  }

  /** Newest first is required: a re-quote reuses the rfq id, and the oldest row is a stale refused quote. */
  async findByRfqId(rfqId: string): Promise<Row | null> {
    const raw = await this.driver.get<RawRow>(this.sql.selectNewestByRfqId, [rfqId])
    return raw ? this.shape.toRow(raw) : null
  }

  /** Newest first: a re-quote against one secret repeats the script, and the live row is the later. */
  async findByPkScript(pkScript: string): Promise<Row | null> {
    const raw = await this.driver.get<RawRow>(this.sql.selectNewestByPkScript, [pkScript])
    return raw ? this.shape.toRow(raw) : null
  }

  async findByPaymentHash(paymentHash: string): Promise<Row | null> {
    const raw = await this.driver.get<RawRow>(this.sql.selectNewestByPaymentHash, [paymentHash])
    return raw ? this.shape.toRow(raw) : null
  }

  /** Mirrors the partial unique index on `payment_hash`. */
  async findLiveByPaymentHash(paymentHash: string): Promise<Row | null> {
    const raw = await this.driver.get<RawRow>(this.sql.selectLiveByPaymentHash, [paymentHash])
    return raw ? this.shape.toRow(raw) : null
  }

  async committedSats(): Promise<number> {
    const row = await this.driver.get<{ total: number }>(this.sql.sumAmountInStates(this.shape.live.length), [
      ...this.shape.live,
    ])
    return Number(row?.total ?? 0)
  }

  async countByStates(states: readonly State[]): Promise<number> {
    if (states.length === 0) return 0
    const row = await this.driver.get<{ total: number }>(this.sql.countInStates(states.length), [...states])
    return Number(row?.total ?? 0)
  }

  async findByStates(states: readonly State[], options: FindByStatesOptions = {}): Promise<Row[]> {
    if (states.length === 0) return []
    const rows = await this.driver.all<RawRow>(this.sql.selectInStates(states.length, options), [...states])
    return rows.map((raw) => this.shape.toRow(raw))
  }

  async findRecoverable(): Promise<Row[]> {
    return this.findByStates(this.shape.live)
  }

  /**
   * `updated_at`: a swap belongs to the day its money moved. Unindexed on purpose, since every
   * transition writes it. `limit + 1` because a full page cannot tell filled from overflowed.
   */
  async ledgerRows(window: LedgerWindow): Promise<{ rows: Row[]; truncated: boolean }> {
    const limit = clampLedgerLimit(window.limit)
    const raw = await this.driver.all<RawRow>(this.sql.selectUpdatedInWindow, [window.since, window.until, limit + 1])
    return { rows: raw.slice(0, limit).map((r) => this.shape.toRow(r)), truncated: raw.length > limit }
  }

  async page(options: PageOptions = {}): Promise<{ rows: Row[]; nextCursor: string | null }> {
    const { sql, params, limit } = pageQuery(this.shape.table, {
      ...options,
      search: options.searchTerm ? { term: options.searchTerm, columns: this.shape.searchColumns } : options.search,
    })
    const raw = await this.driver.all<RawRow & PageRawFields>(sql, params)
    const { page, nextCursor } = takePage(raw, limit)
    return { rows: page.map((r) => this.shape.toRow(r)), nextCursor }
  }

  async history(swapId: string): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]> {
    const rows = await this.driver.all<RawRow>(this.sql.selectHistory, [swapId])
    return rows.map((r) => ({
      at: Number(r.at),
      from: r.from_state === null ? null : String(r.from_state),
      to: String(r.to_state),
      detail: r.detail === null || r.detail === undefined ? null : String(r.detail),
    }))
  }

  /**
   * Compare-and-swap: a lost race returns false; an illegal edge (a caller walking a swap
   * backwards into re-paying) throws. Neither may be relaxed into a subclass hook.
   */
  async transition(
    id: string,
    from: State,
    to: State,
    fields: Partial<Record<string, unknown>> = {},
  ): Promise<boolean> {
    return this.transitionWhere(id, from, to, fields, '')
  }

  /** {@link transition}, won only where `guard` (an SQL condition on the row) also holds. */
  protected async transitionWhere(
    id: string,
    from: State,
    to: State,
    fields: Partial<Record<string, unknown>>,
    guard: string,
  ): Promise<boolean> {
    if (!this.shape.legalEdges[from].includes(to)) {
      throw new Error(`illegal transition ${from} -> ${to}: not an edge of the ${this.shape.lifecycleLabel}`)
    }
    const columns = Object.keys(fields)
    assertColumns(columns, this.shape.transitionColumns, 'transition()')
    const result = await this.driver.run(this.sql.updateState(columns, guard), [
      to,
      this.now(),
      ...columns.map((c) => fields[c]),
      id,
      from,
    ])
    if (result.changes === 1) {
      await this.recordEvent(id, from, to, null)
      announceTransition(this.onTransition, id, from, to)
    }
    return result.changes === 1
  }

  /** Fires only for the CAS winner. Synchronous: an awaitable hook could delay a settlement. */
  onTransition?: TransitionHook

  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(fields)
    if (columns.length === 0) return
    assertColumns(columns, this.shape.patchColumns, 'patch()')
    await this.driver.run(this.sql.updateFields(columns), [this.now(), ...columns.map((c) => fields[c]), id])
  }

  async fail(id: string, from: State, reason: string): Promise<void> {
    const to = (this.shape.exposed.includes(from) ? 'stuck' : 'refused') as State
    await this.transition(id, from, to, { failure_reason: reason })
  }

  /**
   * Won by ONE caller before it spends. Pass `staleBefore` only if the payment cannot repeat:
   * an expiry lets a second worker pay while the first is in flight. `send_swap` lacks the column.
   */
  protected async claimFundLease(id: string, from: State, staleBefore?: number): Promise<boolean> {
    const result = await this.driver.run(this.sql.claimFundLease, [this.now(), this.now(), id, from, staleBefore ?? -1])
    return result.changes === 1
  }

  protected async releaseFundLease(id: string): Promise<void> {
    await this.driver.run(this.sql.releaseFundLease, [id])
  }

  protected async recordEvent(swapId: string, from: State | null, to: State, detail: string | null): Promise<void> {
    await this.driver.run(this.sql.insertEvent, [swapId, this.now(), from, to, detail])
  }
}
