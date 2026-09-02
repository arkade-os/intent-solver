/**
 * The SQL drivers this runtime ships. The PORT type lives in core
 * (`core/driver.ts`) — a corridor's store must compile against nothing but
 * that interface, and this file's implementations are the runtime-specific
 * halves: file pragmas on Node, statement splitting on D1.
 */

import Database from 'better-sqlite3'
import { ensureDatabaseDir } from '@arkade-os/solver-core/util/sqlite.js'
import type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'

export type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'

/** Node driver: better-sqlite3 over a file path (or ':memory:' in tests). */
export const betterSqliteDriver = (path: string): SqlDriver => {
  ensureDatabaseDir(path)
  const db = new Database(path)
  // The durability pragmas are a Node-file concern, so they live in this
  // driver and not in the store: D1 manages its own durability.
  db.pragma('journal_mode = WAL')
  // WAL's default (NORMAL) can lose the most recent commit on power loss, and
  // the most recent commit is precisely the one recording that we are about to
  // spend money. Durability is worth more here than write throughput.
  db.pragma('synchronous = FULL')
  return {
    exec: async (sql) => {
      db.exec(sql)
    },
    run: async (sql, params = []) => ({ changes: db.prepare(sql).run(...(params as never[])).changes }),
    get: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])) as T | undefined,
    all: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
    transaction: async <T>(fn: () => Promise<T>): Promise<T> => {
      // Manual BEGIN/COMMIT rather than db.transaction(), which wraps a SYNC
      // function — our driver surface is async. A failure rolls back and rethrows.
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = await fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    close: async () => {
      // Guarded, not merely tolerated. Under the consolidated layout every
      // store shares this handle and each one closes it, so this runs up to
      // five times per shutdown. better-sqlite3 11 happens to make the repeats
      // a no-op, but that is a property of the installed version rather than a
      // documented guarantee, and `Services.close()` would log four spurious
      // failures the day it changed. `open` is the library's own flag.
      if (db.open) db.close()
    },
  }
}

/**
 * The subset of Cloudflare D1's `D1Database` this service touches, declared
 * structurally so `@cloudflare/workers-types` never becomes a dependency: a
 * real `D1Database` binding satisfies this by shape, and the tests satisfy it
 * with a fake over better-sqlite3.
 */
export interface D1BoundStatementLike {
  run(): Promise<{ meta: { changes: number } }>
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<{ results: T[] }>
}

export interface D1Like {
  prepare(sql: string): { bind(...params: unknown[]): D1BoundStatementLike }
  exec(sql: string): Promise<unknown>
}

/** Cloudflare Workers driver over a D1 binding. */
export const d1Driver = (db: D1Like): SqlDriver => ({
  // D1's exec() dislikes multi-statement strings with comments, and it treats
  // each newline as its own statement — so a multi-line CREATE TABLE fails
  // outright. Split on ';' and flatten every statement to a single line, then
  // exec them one at a time. (Safe for this schema: no string literal here
  // ever contains ';' or meaningful whitespace.)
  exec: async (sql) => {
    const statements = sql
      .split(';')
      .map((statement) => statement.replace(/\s+/g, ' ').trim())
      .filter((statement) => statement.length > 0)
    for (const statement of statements) await db.exec(statement)
  },
  run: async (sql, params = []) => {
    const { meta } = await db
      .prepare(sql)
      .bind(...params)
      .run()
    return { changes: meta.changes }
  },
  get: async <T>(sql: string, params: unknown[] = []) => {
    // D1 says "no row" with null; the port says undefined, so both drivers
    // read identically to the store.
    const row = await db
      .prepare(sql)
      .bind(...params)
      .first<T>()
    return row ?? undefined
  },
  all: async <T>(sql: string, params: unknown[] = []) => {
    const { results } = await db
      .prepare(sql)
      .bind(...params)
      .all<T>()
    return results
  },
  // D1 has no interactive BEGIN/COMMIT across discrete exec calls, so run the
  // body as-is. This is only reached by the legacy table rebuild, which a fresh
  // D1 database never needs; issuing a bare `BEGIN` here would instead throw and
  // brick the isolate.
  transaction: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  // A D1 binding has no close: its lifetime is the isolate's, not ours.
  close: async () => {},
})
