export const placeholders = (count: number): string => Array.from({ length: count }, () => '?').join(', ')

/** Every statement {@link EvmSwapStore} runs, for one swap table and its `<table>_event`. */
export const evmSwapSql = (table: string) =>
  ({
    insertQuoted: (columns: readonly string[]) =>
      `INSERT INTO ${table} (id, state, created_at, updated_at, ${columns.join(', ')})
       VALUES (?, 'quoted', ?, ?, ${placeholders(columns.length)})`,
    insertQuotedEvent: `INSERT INTO ${table}_event (swap_id, at, from_state, to_state) VALUES (?, ?, NULL, 'quoted')`,
    selectById: `SELECT * FROM ${table} WHERE id = ?`,
    selectByRfqId: `SELECT * FROM ${table} WHERE rfq_id = ?`,
    selectLiveByPaymentHash: `SELECT * FROM ${table} WHERE payment_hash = ? AND state != 'refused'`,
    selectNewestByPkScript: `SELECT * FROM ${table} WHERE pk_script = ? ORDER BY created_at DESC`,
    sumAmountInStates: (states: number, byToken: boolean) =>
      `SELECT COALESCE(SUM(amount_sats), 0) AS total FROM ${table} WHERE state IN (${placeholders(states)})${byToken ? ' AND token_address = ?' : ''}`,
    selectInStates: (states: number) =>
      `SELECT * FROM ${table} WHERE state IN (${placeholders(states)}) ORDER BY created_at ASC`,
    selectHistory: `SELECT at, from_state, to_state, detail FROM ${table}_event WHERE swap_id = ? ORDER BY id ASC`,
    selectUpdatedInWindow: (byToken: boolean) =>
      `SELECT * FROM ${table} WHERE updated_at >= ? AND updated_at < ?${byToken ? ' AND token_address = ?' : ''} ORDER BY updated_at DESC LIMIT ?`,
    updateState: (columns: readonly string[]) =>
      `UPDATE ${table} SET ${['state = ?', 'updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')} WHERE id = ? AND state = ?`,
    insertEvent: `INSERT INTO ${table}_event (swap_id, at, from_state, to_state) VALUES (?, ?, ?, ?)`,
    updateFields: (columns: readonly string[]) =>
      `UPDATE ${table} SET ${['updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')} WHERE id = ?`,
  }) as const

export type EvmSwapSql = ReturnType<typeof evmSwapSql>
