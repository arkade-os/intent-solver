import { describe, it, expect, afterEach } from 'vitest'
import { betterSqliteDriver, d1Driver, type D1Like, type SqlDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { DuplicateKeyError, isDuplicateKeyError } from '@arkade-os/solver-core/core/driver.js'

const TABLE = `CREATE TABLE swap (id TEXT PRIMARY KEY, payment_hash TEXT NOT NULL, note TEXT NOT NULL);
CREATE UNIQUE INDEX idx_swap_hash ON swap(payment_hash);`

const INSERT = 'INSERT INTO swap (id, payment_hash, note) VALUES (?, ?, ?)'

const opened: SqlDriver[] = []
const openDriver = async (): Promise<SqlDriver> => {
  const driver = betterSqliteDriver(':memory:')
  opened.push(driver)
  await driver.exec(TABLE)
  await driver.run(INSERT, ['swap-1', 'hash-a', 'first'])
  return driver
}
afterEach(async () => {
  while (opened.length) await opened.pop()!.close()
})

/** A D1 whose run() fails exactly as the real one does: an Error, a message, no code. */
const d1Failing = (message: string): D1Like => ({
  exec: async () => {},
  prepare: () => ({
    bind: () => ({
      run: async () => {
        throw new Error(message)
      },
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
  }),
})

describe('the better-sqlite3 driver normalises a unique-key refusal', () => {
  it('raises DuplicateKeyError when a unique index refuses the write', async () => {
    const driver = await openDriver()
    await expect(driver.run(INSERT, ['swap-2', 'hash-a', 'second'])).rejects.toBeInstanceOf(DuplicateKeyError)
  })

  it('raises DuplicateKeyError when a primary key refuses the write', async () => {
    const driver = await openDriver()
    // Coded SQLITE_CONSTRAINT_PRIMARYKEY, not _UNIQUE: keying on _UNIQUE alone would miss it.
    await expect(driver.run(INSERT, ['swap-1', 'hash-b', 'second'])).rejects.toBeInstanceOf(DuplicateKeyError)
  })

  it('keeps the runtime wording, which existing callers assert on', async () => {
    const driver = await openDriver()
    await expect(driver.run(INSERT, ['swap-2', 'hash-a', 'second'])).rejects.toThrow(
      /UNIQUE constraint failed: swap\.payment_hash/,
    )
  })

  it('leaves an unrelated write failure alone', async () => {
    const driver = await openDriver()
    const failure = await driver.run(INSERT, ['swap-2', null, 'second']).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(DuplicateKeyError)
    expect(isDuplicateKeyError(failure)).toBe(false)
  })
})

describe('the D1 driver normalises a unique-key refusal', () => {
  it('raises DuplicateKeyError from a message-only D1 failure', async () => {
    const driver = d1Driver(d1Failing('D1_ERROR: UNIQUE constraint failed: swap.payment_hash: SQLITE_CONSTRAINT'))
    await expect(driver.run(INSERT, ['swap-2', 'hash-a', 'second'])).rejects.toBeInstanceOf(DuplicateKeyError)
  })

  it('leaves an unrelated D1 failure alone', async () => {
    const driver = d1Driver(d1Failing('D1_ERROR: no such column: payment_hash'))
    const failure = await driver.run(INSERT, ['swap-2', 'hash-a', 'second']).catch((error: unknown) => error)
    expect(failure).not.toBeInstanceOf(DuplicateKeyError)
    expect(isDuplicateKeyError(failure)).toBe(false)
  })

  it('does not call a D1 failure that merely contains the word a duplicate', async () => {
    const driver = d1Driver(d1Failing('D1_ERROR: UNIQUE quote construction failed'))
    const failure = await driver.run(INSERT, ['swap-2', 'hash-a', 'second']).catch((error: unknown) => error)
    expect(failure).not.toBeInstanceOf(DuplicateKeyError)
  })
})

describe('isDuplicateKeyError', () => {
  it('does not classify an unrelated failure that merely contains the word', () => {
    expect(isDuplicateKeyError(new TypeError('UNIQUE quote construction failed'))).toBe(false)
  })

  it('classifies the typed error the drivers raise', () => {
    expect(isDuplicateKeyError(new DuplicateKeyError('UNIQUE constraint failed: swap.payment_hash'))).toBe(true)
  })

  it('falls back to the runtime wording for an error no driver of ours wrapped', () => {
    expect(isDuplicateKeyError(new Error('UNIQUE constraint failed: receive_swap.payment_hash'))).toBe(true)
  })

  it('classifies nothing that is not an error', () => {
    expect(isDuplicateKeyError('UNIQUE constraint failed')).toBe(false)
    expect(isDuplicateKeyError(undefined)).toBe(false)
  })
})
