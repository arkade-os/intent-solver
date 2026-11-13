import type { FindByStatesOptions } from '@arkade-os/solver-core/core/page.js'

export const placeholders = (count: number): string => Array.from({ length: count }, () => '?').join(',')

/** Every statement {@link BaseSwapStore} runs, for one swap table and its event table. */
export const baseSwapSql = (table: string, eventTable: string) =>
  ({
    selectById: `SELECT * FROM ${table} WHERE id = ?`,
    selectNewestByRfqId: `SELECT * FROM ${table} WHERE rfq_id = ? ORDER BY created_at DESC LIMIT 1`,
    selectNewestByPkScript: `SELECT * FROM ${table} WHERE pk_script = ? ORDER BY created_at DESC LIMIT 1`,
    selectNewestByPaymentHash: `SELECT * FROM ${table} WHERE payment_hash = ? ORDER BY created_at DESC LIMIT 1`,
    selectLiveByPaymentHash: `SELECT * FROM ${table} WHERE payment_hash = ? AND state != 'refused' LIMIT 1`,
    sumAmountInStates: (states: number) =>
      `SELECT COALESCE(SUM(amount_sats), 0) AS total FROM ${table} WHERE state IN (${placeholders(states)})`,
    countInStates: (states: number) =>
      `SELECT COUNT(*) AS total FROM ${table} WHERE state IN (${placeholders(states)})`,
    selectInStates: (states: number, options: FindByStatesOptions) =>
      `SELECT * FROM ${table} WHERE state IN (${placeholders(states)}) ORDER BY ${options.newestFirst === true ? 'updated_at DESC' : 'created_at'}${options.limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.trunc(options.limit))}`}`,
    selectUpdatedInWindow: `SELECT * FROM ${table} WHERE updated_at >= ? AND updated_at < ? ORDER BY updated_at DESC LIMIT ?`,
    selectHistory: `SELECT at, from_state, to_state, detail FROM ${eventTable} WHERE swap_id = ? ORDER BY id`,
    updateState: (columns: readonly string[], guard: string) =>
      `UPDATE ${table} SET ${['state = ?', 'updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')} WHERE id = ? AND state = ?${guard ? ` AND ${guard}` : ''}`,
    updateFields: (columns: readonly string[]) =>
      `UPDATE ${table} SET ${['updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')} WHERE id = ?`,
    claimFundLease: `UPDATE ${table} SET fund_started_at = ?, updated_at = ?
       WHERE id = ? AND state = ? AND (fund_started_at IS NULL OR fund_started_at <= ?)`,
    releaseFundLease: `UPDATE ${table} SET fund_started_at = NULL WHERE id = ?`,
    insertEvent: `INSERT INTO ${eventTable} (swap_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?)`,
  }) as const

export type BaseSwapSql = ReturnType<typeof baseSwapSql>

/** Answers empty for a missing table rather than throwing. */
export const tableInfo = (table: string) => `PRAGMA table_info(${table})`

export const addColumn = (table: string, column: string, type: string) =>
  `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`
