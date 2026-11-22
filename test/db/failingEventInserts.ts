import { betterSqliteDriver, type SqlDriver } from '@arkade-os/solver-corridors/db/driver.js'

/** An in-memory database on which every insert into an event table fails. */
export const failingEventInserts = (): SqlDriver => {
  const driver = betterSqliteDriver(':memory:')
  return {
    ...driver,
    run: async (sql, params) => {
      if (/INSERT INTO \w+_event\b/.test(sql)) throw new Error('event insert failed')
      return driver.run(sql, params)
    },
  }
}

export const rowCount = async (driver: SqlDriver, table: string): Promise<number> =>
  Number((await driver.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n)
