/**
 * The SQL driver port: one async surface, one driver per runtime.
 *
 * The port lives in core because a corridor's store is a corridor's own code —
 * a corridor package owns its store and must be able to compile it against
 * nothing but this interface. The DRIVERS stay beside their runtime:
 * `better-sqlite3` in the corridors package today (and the node host
 * tomorrow), the D1 driver beside the Workers host. Neither may leak INTO this
 * file: `better-sqlite3` is a native binding and D1's types would drag in a
 * Workers dependency, and either makes core unshippable as a type-level
 * package.
 *
 * The surface is async even though better-sqlite3 is synchronous, because a
 * port has to be as asynchronous as its most asynchronous implementation, and
 * D1 only speaks promises.
 */
export interface SqlDriver {
  /** Run one or more statements that return no rows (schema, ALTER TABLE). */
  exec(sql: string): Promise<void>
  /** Run one write statement. `changes` is SQLite's changes() count — the compare-and-swap depends on it. */
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>
  /** First row or undefined. Drivers whose runtime says "no row" differently must normalise to undefined. */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /**
   * Run `fn` inside a transaction where the runtime supports one, rolling back
   * if it throws. better-sqlite3 gives real atomicity; D1 has no interactive
   * transaction over discrete calls, so it runs `fn` as-is (best effort). Used
   * only by the one-time legacy table rebuild, so the D1 best-effort path is
   * acceptable — a fresh D1 database never carries the constraint being rebuilt.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>
  close(): Promise<void>
}
