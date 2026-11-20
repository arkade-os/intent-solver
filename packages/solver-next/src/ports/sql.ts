/** The database, as a repository needs it. One statement per call; nothing here holds a transaction open. */
export interface SqlDriver {
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}
