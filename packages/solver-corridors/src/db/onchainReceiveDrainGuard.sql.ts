/** The SQL the onchain-receive drain guard runs against the dead corridor's table. */

export const tableInfo = (table: string): string => `PRAGMA table_info(${table})`

export const countInStates = (table: string, states: readonly string[]): string =>
  `SELECT COUNT(*) AS n FROM ${table} WHERE state IN (${states.map(() => '?').join(',')})`
