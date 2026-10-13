/** Shared by every better-sqlite3 open in this repo. */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Create the directory a SQLite file is about to be opened in: better-sqlite3 does
 * not, and its "directory does not exist" error names neither the path nor the
 * setting. The two non-file paths are left alone — `:memory:` (the unit suite) and
 * `''` (SQLite's own temporary database) name no directory.
 */
export const ensureDatabaseDir = (path: string): void => {
  if (path === ':memory:' || path === '') return
  mkdirSync(dirname(path), { recursive: true })
}
