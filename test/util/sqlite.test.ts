/**
 * Opening a database into a directory that does not exist yet.
 *
 * The regression this pins down is a first-run one: both `SWAP_DB_PATH` and
 * `ARK_DB_PATH` default under `.data/`, better-sqlite3 opens paths rather than
 * creating them, and so a fresh checkout died on its first command with a
 * `TypeError` from inside a vendor constructor that named neither the path nor
 * the setting. It is the kind of failure that only ever shows up to someone
 * setting the project up for the first time — which is exactly who is least
 * equipped to read it.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sqliteExecutor } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { ensureDatabaseDir } from '@arkade-os/solver-core/util/sqlite.js'

const created: string[] = []

/** A temp root that no test has touched yet, cleaned up afterwards. */
const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'lnswap-sqlite-'))
  created.push(root)
  return root
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ensureDatabaseDir', () => {
  it('creates a missing directory, however deep', () => {
    const dir = join(freshRoot(), 'a', 'b', 'c')
    // Asserted, not assumed: a test that cannot see the absent state is not
    // testing the creation.
    expect(existsSync(dir)).toBe(false)
    ensureDatabaseDir(join(dir, 'swaps.sqlite'))
    expect(existsSync(dir)).toBe(true)
  })

  it('is a no-op when the directory is already there', () => {
    const root = freshRoot()
    const path = join(root, 'swaps.sqlite')
    ensureDatabaseDir(path)
    // Twice: a second open of an existing database must not throw EEXIST.
    expect(() => ensureDatabaseDir(path)).not.toThrow()
    expect(existsSync(root)).toBe(true)
  })

  it.each([':memory:', ''])('leaves the non-file path %j alone', (path) => {
    // Neither names a directory. `:memory:` is what the unit suite opens, so
    // treating it as a path would have every test in this repo mkdir a folder
    // called `.` — harmless, but it would mean the guard is not understood.
    expect(() => ensureDatabaseDir(path)).not.toThrow()
  })
})

describe('betterSqliteDriver', () => {
  it('opens a database whose directory does not exist yet', async () => {
    // THE ACTUAL REPRO. Before the fix this threw
    // "Cannot open database because the directory does not exist".
    const path = join(freshRoot(), '.data', 'swaps.sqlite')
    const driver = betterSqliteDriver(path)
    try {
      await driver.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')
      await driver.run('INSERT INTO t (id) VALUES (?)', ['x'])
      expect(await driver.get<{ id: string }>('SELECT id FROM t')).toEqual({ id: 'x' })
      expect(existsSync(path)).toBe(true)
    } finally {
      // Closed in a finally for the reason test/db/driver.test.ts documents: a
      // leaked native handle is destructed after the worker's Node environment
      // is gone and takes the whole worker down with it, as an unrelated error.
      await driver.close()
    }
  })
})

describe('sqliteExecutor', () => {
  it('opens the Arkade wallet store whose directory does not exist yet', () => {
    // The OTHER call site, and the one the failure was actually reported from:
    // `scripts/regtest-fund.mjs` builds an Arkade context before anything has
    // created `.data/`, so this is the exact first-run path. Pinned separately
    // because the two opens live in different subsystems and nothing but this
    // test stops one of them losing the guard.
    const path = join(freshRoot(), '.data', 'ark.sqlite')
    const executor = sqliteExecutor(path)
    try {
      expect(existsSync(path)).toBe(true)
    } finally {
      executor.close()
    }
  })
})
