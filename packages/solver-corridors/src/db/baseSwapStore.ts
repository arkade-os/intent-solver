/**
 * What the four swap stores share, which is nearly all of them.
 *
 * Every method here had four copies that differed only in a table name, a row
 * mapper and — in `transition`'s error message — one word. Keeping four was not
 * free: `patch` grew a refund-history note in the Lightning-send copy alone
 * (`db/swaps.ts`), and `history` still read a `detail` column in that one copy
 * while the other three wrote it and never read it back.
 *
 * The differences that are REAL are named in {@link StoreShape} and passed in.
 * Anything a store cannot express through that shape stays in the store.
 *
 * This is money-path code. `transition` is a compare-and-swap whose `from`
 * predicate is what stops two sweeps acting on one row, and whose edge check is
 * what stops a retry walking a swap backwards into re-paying. Neither may be
 * relaxed into a subclass hook.
 */
import type { SqlDriver } from './driver.js'
import {
  pageQuery,
  takePage,
  type FindByStatesOptions,
  type PageOptions,
  type PageRawFields,
} from '@arkade-os/solver-core/core/page.js'

/** A row as the driver hands it back, before the store's own mapper narrows it. */
export type RawRow = Record<string, unknown>

/** Everything the shared methods need that genuinely differs per store. */
export interface StoreShape<Row, State extends string> {
  readonly table: string
  readonly eventTable: string
  /**
   * What this store calls one of its rows in a not-found error — `swap`,
   * `receive swap`, `onchain send swap`, `onchain receive swap`.
   *
   * Its own field rather than derived from {@link lifecycleLabel}, because the
   * two do not line up: `onchain send lifecycle` would give `onchain send`, and
   * the message has always said `onchain send swap`. Deriving it would silently
   * reword an error operators grep for.
   */
  readonly noun: string
  /**
   * How this store names its lifecycle in an illegal-transition error, e.g.
   * `onchain send lifecycle`. Message text is part of what operators read when
   * a swap refuses to move, so it stays per-store rather than becoming generic.
   */
  readonly lifecycleLabel: string
  readonly searchColumns: readonly string[]
  readonly legalEdges: Readonly<Record<State, readonly State[]>>
  readonly transitionColumns: ReadonlySet<string>
  readonly patchColumns: ReadonlySet<string>
  /** Non-terminal states — what the sweep drives and what `committedSats` sums. */
  readonly live: readonly State[]
  /** States in which the solver may have paid out and not been made whole. */
  readonly exposed: readonly State[]
  /**
   * Where `fail()` sends a row.
   *
   * All four stores spell these `stuck` and `refused`, but the words are a
   * corridor's own vocabulary rather than this file's, and a corridor that
   * named them differently would otherwise get a silent illegal-edge throw at
   * the worst possible moment — the moment something already went wrong.
   */
  readonly failStates: { readonly exposed: State; readonly clean: State }
  toRow(raw: RawRow): Row
}

const assertColumns = (columns: string[], allowed: ReadonlySet<string>, method: string): void => {
  for (const column of columns) {
    if (!allowed.has(column)) throw new Error(`${method} may not set column '${column}'`)
  }
}

export abstract class BaseSwapStore<Row, State extends string> {
  protected constructor(
    protected readonly driver: SqlDriver,
    protected readonly now: () => number,
  ) {}

  /**
   * The store's own differences, supplied by the subclass as a class field.
   *
   * `tsconfig` targets ES2023, so `useDefineForClassFields` defaults to true and
   * a subclass field is installed only AFTER `super()` returns. That is safe as
   * written because nothing in this constructor reads `shape` — but it means
   * base-constructor logic that reached for it would silently see `undefined`.
   * If this constructor ever needs the shape, take it as a parameter instead.
   */
  protected abstract readonly shape: StoreShape<Row, State>

  async close(): Promise<void> {
    await this.driver.close()
  }

  async get(id: string): Promise<Row> {
    const raw = await this.driver.get<RawRow>(`SELECT * FROM ${this.shape.table} WHERE id = ?`, [id])
    if (!raw) throw new Error(`${this.shape.noun} ${id} not found`)
    return this.shape.toRow(raw)
  }

  /**
   * Most recent swap carrying this RFQ correlation id, any state.
   *
   * The ordering is load-bearing and identical in all four stores: an rfq id is
   * a CORRELATION id rather than a key, so a client that re-quotes reuses it and
   * the table legitimately holds several. Dropping the `ORDER BY` returns
   * whichever row SQLite reaches first, which is usually the oldest — a stale
   * refused quote in place of the live one.
   */
  async findByRfqId(rfqId: string): Promise<Row | null> {
    const raw = await this.driver.get<RawRow>(
      `SELECT * FROM ${this.shape.table} WHERE rfq_id = ? ORDER BY created_at DESC LIMIT 1`,
      [rfqId],
    )
    return raw ? this.shape.toRow(raw) : null
  }

  async committedSats(): Promise<number> {
    const placeholders = this.shape.live.map(() => '?').join(',')
    const row = await this.driver.get<{ total: number }>(
      `SELECT COALESCE(SUM(amount_sats), 0) AS total FROM ${this.shape.table} WHERE state IN (${placeholders})`,
      [...this.shape.live],
    )
    return Number(row?.total ?? 0)
  }

  async countByStates(states: readonly State[]): Promise<number> {
    if (states.length === 0) return 0
    const placeholders = states.map(() => '?').join(',')
    const row = await this.driver.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${this.shape.table} WHERE state IN (${placeholders})`,
      [...states],
    )
    return Number(row?.total ?? 0)
  }

  async findByStates(states: readonly State[], options: FindByStatesOptions = {}): Promise<Row[]> {
    if (states.length === 0) return []
    const placeholders = states.map(() => '?').join(',')
    // Oldest-first and unbounded by default: that is what the sweep wants, and
    // the sweep is the caller that matters. The options exist for the console,
    // which reads a TERMINAL set that only ever grows.
    const order = options.newestFirst === true ? 'updated_at DESC' : 'created_at'
    const cap = options.limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.trunc(options.limit))}`
    const rows = await this.driver.all<RawRow>(
      `SELECT * FROM ${this.shape.table} WHERE state IN (${placeholders}) ORDER BY ${order}${cap}`,
      [...states],
    )
    return rows.map((raw) => this.shape.toRow(raw))
  }

  async findRecoverable(): Promise<Row[]> {
    return this.findByStates(this.shape.live)
  }

  async page(options: PageOptions = {}): Promise<{ rows: Row[]; nextCursor: string | null }> {
    const { sql, params, limit } = pageQuery(this.shape.table, {
      ...options,
      // The store owns the column list; a caller only ever supplies a term.
      search: options.searchTerm ? { term: options.searchTerm, columns: this.shape.searchColumns } : options.search,
    })
    const raw = await this.driver.all<RawRow & PageRawFields>(sql, params)
    const { page, nextCursor } = takePage(raw, limit)
    return { rows: page.map((r) => this.shape.toRow(r)), nextCursor }
  }

  /**
   * Always selects `detail`, on every store.
   *
   * Three of the four used to omit it while their event tables declared the
   * column and their `recordEvent` already wrote it, so the note was reachable
   * from one corridor and invisible from the others. Widening the other three
   * is additive — a caller that ignored the field still ignores it.
   */
  async history(swapId: string): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]> {
    const rows = await this.driver.all<RawRow>(
      `SELECT at, from_state, to_state, detail FROM ${this.shape.eventTable} WHERE swap_id = ? ORDER BY id`,
      [swapId],
    )
    return rows.map((r) => ({
      at: Number(r.at),
      from: r.from_state === null ? null : String(r.from_state),
      to: String(r.to_state),
      // Non-null only on a note — a thing that happened TO the swap without
      // moving it through the lifecycle. A refund is the only one today.
      detail: r.detail === null || r.detail === undefined ? null : String(r.detail),
    }))
  }

  /**
   * The compare-and-swap. `WHERE id = ? AND state = ?` is what stops two sweeps
   * acting on one row: the loser changes nothing and gets false back.
   *
   * The edge check throws rather than returning false, because an illegal edge
   * is a caller BUG — a retry tool or admin command walking a swap backwards —
   * whereas a lost race is ordinary. Collapsing the two would let the first hide
   * inside the second's return value.
   */
  async transition(
    id: string,
    from: State,
    to: State,
    fields: Partial<Record<string, unknown>> = {},
  ): Promise<boolean> {
    if (!this.shape.legalEdges[from].includes(to)) {
      throw new Error(`illegal transition ${from} -> ${to}: not an edge of the ${this.shape.lifecycleLabel}`)
    }
    const columns = Object.keys(fields)
    assertColumns(columns, this.shape.transitionColumns, 'transition()')
    const assignments = ['state = ?', 'updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')
    const result = await this.driver.run(`UPDATE ${this.shape.table} SET ${assignments} WHERE id = ? AND state = ?`, [
      to,
      this.now(),
      ...columns.map((c) => fields[c]),
      id,
      from,
    ])
    if (result.changes === 1) await this.recordEvent(id, from, to, null)
    return result.changes === 1
  }

  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(fields)
    if (columns.length === 0) return
    assertColumns(columns, this.shape.patchColumns, 'patch()')
    const assignments = ['updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')
    await this.driver.run(`UPDATE ${this.shape.table} SET ${assignments} WHERE id = ?`, [
      this.now(),
      ...columns.map((c) => fields[c]),
      id,
    ])
  }

  /**
   * `stuck` rather than a generic failure when money is already exposed: those
   * need a human, and flattening them into "failed" hides that.
   */
  async fail(id: string, from: State, reason: string): Promise<void> {
    const to = this.shape.exposed.includes(from) ? this.shape.failStates.exposed : this.shape.failStates.clean
    await this.transition(id, from, to, { failure_reason: reason })
  }

  protected async recordEvent(swapId: string, from: State | null, to: State, detail: string | null): Promise<void> {
    await this.driver.run(
      `INSERT INTO ${this.shape.eventTable} (swap_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?)`,
      [swapId, this.now(), from, to, detail],
    )
  }
}
