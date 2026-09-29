/** The read paths `send_evm_swap` and `receive_evm_swap` share verbatim, keyed by table name. */

import type { SqlDriver } from '@arkade-os/solver-db/driver.js'
import { clampLedgerLimit, type LedgerWindow } from '@arkade-os/solver-core/analytics/economics.js'

export type Raw = Record<string, string | number | null>

// `| undefined` because `noUncheckedIndexedAccess` makes every raw column
// lookup possibly-absent, and a column this store does not know about is
// absent rather than null.
export const text = (value: string | number | null | undefined): string | null =>
  value === null || value === undefined ? null : String(value)

export const assertColumns = (columns: readonly string[], allowed: ReadonlySet<string>, where: string): void => {
  for (const column of columns) {
    if (!allowed.has(column)) throw new Error(where + ': unknown column ' + column)
  }
}

export const findByStates = async <Row>(
  driver: SqlDriver,
  table: string,
  states: readonly string[],
  toRow: (raw: Raw) => Row,
): Promise<Row[]> => {
  if (states.length === 0) return []
  const placeholders = states.map(() => '?').join(', ')
  const rows = (await driver.all(
    'SELECT * FROM ' + table + ' WHERE state IN (' + placeholders + ') ORDER BY created_at ASC',
    [...states],
  )) as Raw[]
  return rows.map(toRow)
}

export const history = async (
  driver: SqlDriver,
  eventTable: string,
  swapId: string,
): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]> => {
  const rows = (await driver.all(
    'SELECT at, from_state, to_state, detail FROM ' + eventTable + ' WHERE swap_id = ? ORDER BY id ASC',
    [swapId],
  )) as Raw[]
  return rows.map((raw) => ({
    at: Number(raw.at),
    from: text(raw.from_state),
    to: String(raw.to_state),
    detail: text(raw.detail),
  }))
}

/**
 * Rows whose last movement falls in a window. @see BaseSwapStore.ledgerRows
 *
 * `tokenAddress` NARROWS IN SQL, and must: one table serves every token, so
 * filtering after the `LIMIT` would let a busy token's rows push a quiet one's
 * out, and that corridor would silently report no profit for the window.
 */
export const ledgerRows = async <Row>(
  driver: SqlDriver,
  table: string,
  toRow: (raw: Raw) => Row,
  window: LedgerWindow,
  tokenAddress?: string,
): Promise<{ rows: Row[]; truncated: boolean }> => {
  const limit = clampLedgerLimit(window.limit)
  const raw = await driver.all<Raw>(
    `SELECT * FROM ${table} WHERE updated_at >= ? AND updated_at < ?` +
      (tokenAddress === undefined ? '' : ' AND token_address = ?') +
      ` ORDER BY updated_at DESC LIMIT ?`,
    tokenAddress === undefined
      ? [window.since, window.until, limit + 1]
      : [window.since, window.until, tokenAddress, limit + 1],
  )
  return { rows: raw.slice(0, limit).map(toRow), truncated: raw.length > limit }
}
