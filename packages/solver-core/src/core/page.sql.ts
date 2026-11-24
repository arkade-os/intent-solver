/** The SQL every store's `page()` runs, and the pieces of its WHERE. */

export const stateIn = (placeholders: string): string => `state IN (${placeholders})`

// The tie-break on rowid is what makes the cursor total: created_at is a
// second-resolution clock, so several swaps quoted in the same second would
// otherwise be an unordered set the cursor could land in the middle of.
export const beforeCursor = '(created_at < ? OR (created_at = ? AND rowid < ?))'

// Bracketed as one clause. Without the outer parentheses this ORs against
// the state and cursor conditions instead of ANDing with them — SQLite
// binds AND tighter than OR — and a search silently returns rows the
// caller filtered out.
export const searchColumns = (columns: readonly string[], likeEscape: string): string =>
  `(${columns.map((c) => `${c} LIKE ? ESCAPE '${likeEscape}'`).join(' OR ')})`

export const where = (clauses: readonly string[]): string => `WHERE ${clauses.join(' AND ')}`

export const page = (table: string, where: string): string =>
  `SELECT *, rowid AS _rowid FROM ${table} ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`
