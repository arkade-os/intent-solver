/** Every SQL statement the four swap stores share. Each takes the table it runs against. */

const sqlStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`

const placeholdersFor = (values: readonly unknown[]): string => values.map(() => '?').join(',')

export const tableInfo = (table: string): string => `PRAGMA table_info(${table})`

export const addColumn = (table: string, column: string, type: string): string =>
  `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`

export const byId = (table: string): string => `SELECT * FROM ${table} WHERE id = ?`

export const byRfqId = (table: string): string =>
  `SELECT * FROM ${table} WHERE rfq_id = ? ORDER BY created_at DESC LIMIT 1`

export const byPkScript = (table: string): string =>
  `SELECT * FROM ${table} WHERE pk_script = ? ORDER BY created_at DESC LIMIT 1`

export const byPaymentHash = (table: string): string =>
  `SELECT * FROM ${table} WHERE payment_hash = ? ORDER BY created_at DESC LIMIT 1`

export const liveByPaymentHash = (table: string): string =>
  `SELECT * FROM ${table} WHERE payment_hash = ? AND state != 'refused' LIMIT 1`

export const committedSats = (table: string, states: readonly string[]): string =>
  `SELECT COALESCE(SUM(amount_sats), 0) AS total FROM ${table} WHERE state IN (${placeholdersFor(states)})`

const notIn = (excludeIds: readonly string[]): string =>
  excludeIds.length === 0 ? '' : ` AND id NOT IN (${placeholdersFor(excludeIds)})`

export const countByStates = (table: string, states: readonly string[], excludeIds: readonly string[] = []): string =>
  `SELECT COUNT(*) AS total FROM ${table} WHERE state IN (${placeholdersFor(states)})${notIn(excludeIds)}`

export const byStates = (
  table: string,
  states: readonly string[],
  newestFirst: boolean,
  limit: number | undefined,
  excludeIds: readonly string[] = [],
): string => {
  // Oldest-first and unbounded by default: that is what the sweep wants, and
  // the sweep is the caller that matters. The options exist for the console,
  // which reads a TERMINAL set that only ever grows.
  const order = newestFirst ? 'updated_at DESC' : 'created_at'
  const cap = limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.trunc(limit))}`
  return `SELECT * FROM ${table} WHERE state IN (${placeholdersFor(states)})${notIn(excludeIds)} ORDER BY ${order}${cap}`
}

export const pageRecoverable = (
  table: string,
  states: readonly string[],
  recoveryOrderIndex: string | undefined,
  afterCursor: boolean,
): string => {
  const indexClause = recoveryOrderIndex ? ` INDEXED BY ${recoveryOrderIndex}` : ''
  const stateClause = recoveryOrderIndex
    ? `state IN (${states.map(sqlStringLiteral).join(',')})`
    : `state IN (${placeholdersFor(states)})`
  const cursorClause = afterCursor ? ' AND (created_at, rowid) > (?, ?)' : ''
  return `SELECT *, rowid AS _rowid FROM ${table}${indexClause}
       WHERE ${stateClause}${cursorClause}
       ORDER BY created_at ASC, rowid ASC LIMIT ?`
}

export const ledgerRows = (table: string): string =>
  `SELECT * FROM ${table} WHERE updated_at >= ? AND updated_at < ? ORDER BY updated_at DESC LIMIT ?`

export const history = (eventTable: string): string =>
  `SELECT at, from_state, to_state, detail FROM ${eventTable} WHERE swap_id = ? ORDER BY id`

export const transition = (table: string, columns: readonly string[], guard: string): string => {
  const assignments = ['state = ?', 'updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')
  const where = `id = ? AND state = ?${guard ? ` AND ${guard}` : ''}`
  return `UPDATE ${table} SET ${assignments} WHERE ${where}`
}

export const patch = (table: string, columns: readonly string[]): string => {
  const assignments = ['updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')
  return `UPDATE ${table} SET ${assignments} WHERE id = ?`
}

export const claimFundLease = (table: string): string =>
  `UPDATE ${table} SET fund_started_at = ?, updated_at = ?
       WHERE id = ? AND state = ? AND (fund_started_at IS NULL OR fund_started_at <= ?)`

export const releaseFundLease = (table: string): string => `UPDATE ${table} SET fund_started_at = NULL WHERE id = ?`

export const insertEvent = (eventTable: string): string =>
  `INSERT INTO ${eventTable} (swap_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?)`
