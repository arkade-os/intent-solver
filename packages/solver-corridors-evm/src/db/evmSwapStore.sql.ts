/** Every SQL statement the shared EVM swap store runs, each for the table it is given. */

export const insertQuote = (table: string, columns: readonly string[]): string =>
  `INSERT INTO ${table} (id, state, created_at, updated_at, ${columns.join(', ')})
       VALUES (?, 'quoted', ?, ?, ${columns.map(() => '?').join(', ')})`

export const recordQuoted = (table: string): string =>
  `INSERT INTO ${table}_event (swap_id, at, from_state, to_state) VALUES (?, ?, NULL, 'quoted')`

export const byId = (table: string): string => `SELECT * FROM ${table} WHERE id = ?`

export const byRfqId = (table: string): string => `SELECT * FROM ${table} WHERE rfq_id = ?`

export const liveByPaymentHash = (table: string): string =>
  `SELECT * FROM ${table} WHERE payment_hash = ? AND state != 'refused'`

export const byPkScript = (table: string): string =>
  `SELECT * FROM ${table} WHERE pk_script = ? ORDER BY created_at DESC`

export const committedSats = (table: string, placeholders: string, byToken: boolean): string =>
  'SELECT COALESCE(SUM(amount_sats), 0) AS total FROM ' +
  table +
  ' WHERE state IN (' +
  placeholders +
  ')' +
  (byToken ? ' AND token_address = ?' : '')

export const byStates = (table: string, placeholders: string): string =>
  'SELECT * FROM ' + table + ' WHERE state IN (' + placeholders + ') ORDER BY created_at ASC'

export const history = (table: string): string =>
  'SELECT at, from_state, to_state, detail FROM ' + table + '_event WHERE swap_id = ? ORDER BY id ASC'

export const ledgerRows = (table: string, byToken: boolean): string =>
  `SELECT * FROM ${table} WHERE updated_at >= ? AND updated_at < ?` +
  (byToken ? ' AND token_address = ?' : '') +
  ` ORDER BY updated_at DESC LIMIT ?`

export const transition = (table: string, assignments: string): string =>
  'UPDATE ' +
  table +
  ' SET state = ?, updated_at = ?' +
  (assignments ? ', ' + assignments : '') +
  ' WHERE id = ? AND state = ?'

export const recordEvent = (table: string): string =>
  'INSERT INTO ' + table + '_event (swap_id, at, from_state, to_state) VALUES (?, ?, ?, ?)'

export const patch = (table: string, assignments: string): string =>
  'UPDATE ' + table + ' SET updated_at = ?, ' + assignments + ' WHERE id = ?'
