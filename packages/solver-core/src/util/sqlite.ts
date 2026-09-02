/** Shared by every better-sqlite3 open in this repo. */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Create the directory a SQLite file is about to be opened in.
 *
 * better-sqlite3 opens a path; it does not make one. A `SWAP_DB_PATH` or
 * `ARK_DB_PATH` naming a directory that does not exist yet fails with
 *
 *   TypeError: Cannot open database because the directory does not exist
 *
 * which names neither the path it tried nor the setting that chose it, and
 * arrives from inside a vendor constructor several frames below anything in
 * this repo. Both knobs default under `.data/`, so this is what a fresh
 * checkout hits on its very first run — before the service has done anything
 * an operator could have got wrong.
 *
 * Making the directory is the same promise the setting already makes: it says
 * where the database goes, so putting it there is this side's job. The
 * alternative — documenting a `mkdir` next to every command in the runbook —
 * is a step that only ever gets discovered by failing.
 *
 * better-sqlite3's two non-file paths are left alone. `:memory:` is what the
 * unit suite opens, and `''` asks SQLite for its own temporary database;
 * neither names a directory anybody should be creating.
 */
export const ensureDatabaseDir = (path: string): void => {
  if (path === ':memory:' || path === '') return
  mkdirSync(dirname(path), { recursive: true })
}
