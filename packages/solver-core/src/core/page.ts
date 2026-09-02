/**
 * Keyset pagination for the admin read paths.
 *
 * Keyset rather than OFFSET because these tables are read WHILE they are being
 * written: an operator paging through swaps at the same time as the solver
 * quotes new ones would see rows skipped or repeated under OFFSET, since every
 * insert shifts the window out from under the page they are already holding.
 * A cursor pins an absolute position instead, so the page an operator is
 * looking at means the same thing a second later.
 *
 * Shared by all four stores rather than written four times: the ordering and
 * the tie-break are the part that has to agree across corridors, since the
 * admin swap list merges their pages into one stream.
 */

export interface PageOptions {
  /** Corridor-native state words. Empty or absent means every state. */
  states?: readonly string[]
  limit?: number
  cursor?: string | null
  /**
   * Substring match across identifier columns, for an operator holding a
   * fragment of something — the first characters of a txid, a payment hash
   * pasted from a wallet, part of an address.
   *
   * `columns` is supplied by each store from its own schema and must never be
   * taken from a request: column names cannot be parameters, so they are
   * interpolated, and {@link assertSearchable} is what keeps that safe.
   */
  search?: { term: string; columns: readonly string[] }
  /**
   * What a CALLER asks for: the term alone.
   *
   * Each store turns this into {@link search} using its own column list, so a
   * route never names a column. The two exist separately because the four
   * corridors spell the same identifier differently — a lockup txid is
   * `lockup_txid` on one and `arkade_lockup_txid` on another — and a caller
   * searching across all of them cannot know which.
   */
  searchTerm?: string
}

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 500

/**
 * Shortest term worth running.
 *
 * One or two characters match nearly every row, so the result is a full scan
 * presented as an answer. Every identifier an operator actually pastes — a txid
 * prefix, a payment hash, an address — is far longer than this.
 */
export const MIN_SEARCH_LENGTH = 3

/** The escape character declared to LIKE. Backslash is not one by default. */
const LIKE_ESCAPE = '\\'

/**
 * Make a user's term literal.
 *
 * `%` and `_` are LIKE wildcards, so an unescaped `100%` matches every row and
 * `a_b` matches `axb`. The escape character goes first: escaping it after the
 * others would double the backslashes they just added.
 */
export const escapeLike = (term: string): string =>
  term
    .replaceAll(LIKE_ESCAPE, LIKE_ESCAPE + LIKE_ESCAPE)
    .replaceAll('%', `${LIKE_ESCAPE}%`)
    .replaceAll('_', `${LIKE_ESCAPE}_`)

/**
 * Refuse anything that is not a bare column identifier.
 *
 * These reach the SQL by interpolation because SQLite cannot parameterise an
 * identifier. Today every caller passes a constant from its own schema, and
 * this is what keeps a future one from passing a request field instead.
 */
const assertSearchable = (columns: readonly string[]): void => {
  if (columns.length === 0) throw new Error('search needs at least one column')
  for (const column of columns) {
    if (!/^[a-z_][a-z0-9_]*$/.test(column)) throw new Error(`search column ${column} is not a plain identifier`)
  }
}

/**
 * How a `findByStates` caller wants the set shaped. Both fields default off, so
 * the sweep — the caller that matters, and the one that must see every row —
 * keeps exactly the behaviour it always had.
 *
 * They exist for the console, whose case is the opposite: it reads a TERMINAL
 * set (`stuck`) on the first screen, on every SSE event, and that set only ever
 * grows. Unbounded, each parked row costs a full-row read on every load,
 * forever, and the payload grows with it. Bounded and newest-first, the screen
 * shows the most recently parked rows — the actionable ones — and the caller
 * reports the true total separately.
 */
export interface FindByStatesOptions {
  /** Rows to return at most. Absent means every match. */
  limit?: number
  /** Order by `updated_at` descending instead of `created_at` ascending. */
  newestFirst?: boolean
}

export interface Cursor {
  createdAt: number
  rowid: number
}

export const encodeCursor = (cursor: Cursor): string => `${cursor.createdAt}.${cursor.rowid}`

export const decodeCursor = (raw: string | null | undefined): Cursor | null => {
  if (!raw) return null
  const parts = raw.split('.')
  const createdAt = Number(parts[0])
  const rowid = Number(parts[1])
  if (parts.length !== 2 || !Number.isInteger(createdAt) || !Number.isInteger(rowid)) {
    throw new Error(`malformed page cursor: ${raw}`)
  }
  return { createdAt, rowid }
}

/**
 * A caller-supplied limit, bounded. Rejects rather than clamps at the bottom:
 * `limit=0` or `limit=-1` is a caller bug, and silently answering it with the
 * default hides the bug behind a page that looks fine.
 */
export const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`page limit must be a positive integer, got ${limit}`)
  }
  return Math.min(limit, MAX_PAGE_LIMIT)
}

/**
 * The SQL every store's `page()` runs, and its parameters.
 *
 * `table` is a module constant at each call site, never caller data — the
 * states are the only caller-supplied values that reach the statement, and
 * they go through placeholders.
 *
 * One row more than the limit is requested so the caller can tell "this is the
 * last page" from "there is exactly one more" without a second COUNT query.
 */
export const pageQuery = (table: string, options: PageOptions): { sql: string; params: unknown[]; limit: number } => {
  const limit = clampLimit(options.limit)
  const cursor = decodeCursor(options.cursor)
  const clauses: string[] = []
  const params: unknown[] = []

  if (options.states && options.states.length > 0) {
    clauses.push(`state IN (${options.states.map(() => '?').join(',')})`)
    params.push(...options.states)
  }
  // The tie-break on rowid is what makes the cursor total: created_at is a
  // second-resolution clock, so several swaps quoted in the same second would
  // otherwise be an unordered set the cursor could land in the middle of.
  if (cursor) {
    clauses.push('(created_at < ? OR (created_at = ? AND rowid < ?))')
    params.push(cursor.createdAt, cursor.createdAt, cursor.rowid)
  }

  if (options.search) {
    const term = options.search.term.trim()
    if (term.length < MIN_SEARCH_LENGTH) {
      throw new Error(`search term must be at least ${MIN_SEARCH_LENGTH} characters`)
    }
    assertSearchable(options.search.columns)
    // Bracketed as one clause. Without the outer parentheses this ORs against
    // the state and cursor conditions instead of ANDing with them — SQLite
    // binds AND tighter than OR — and a search silently returns rows the
    // caller filtered out.
    clauses.push(`(${options.search.columns.map((c) => `${c} LIKE ? ESCAPE '${LIKE_ESCAPE}'`).join(' OR ')})`)
    params.push(...options.search.columns.map(() => `%${escapeLike(term)}%`))
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const sql = `SELECT *, rowid AS _rowid FROM ${table} ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`
  return { sql, params: [...params, limit + 1], limit }
}

/**
 * The two columns {@link pageQuery}'s SELECT guarantees on top of whatever the
 * store's own raw row shape declares.
 *
 * Stated as a named type because each store's `Raw` is an index signature, and
 * an index signature does NOT satisfy a required property in TypeScript — so
 * the call sites intersect this in explicitly rather than casting the result.
 */
export interface PageRawFields {
  created_at: string | number | null
  _rowid: number
}

/**
 * Split an over-fetched result into the page and the cursor that follows it.
 *
 * Generic over the raw row so each store keeps its own `toRow` mapper; this
 * only ever touches the two columns in {@link PageRawFields}.
 */
export const takePage = <T extends PageRawFields>(
  raw: T[],
  limit: number,
): { page: T[]; nextCursor: string | null } => {
  const page = raw.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor =
    raw.length > limit && last ? encodeCursor({ createdAt: Number(last.created_at), rowid: Number(last._rowid) }) : null
  return { page, nextCursor }
}
