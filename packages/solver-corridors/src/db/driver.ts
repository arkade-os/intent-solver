/**
 * The SQL drivers moved to `@arkade-os/solver-db` — a leaf package every corridor store
 * (BTC and EVM alike) can reach without importing another corridor. This shim
 * keeps the specifier existing consumers already use.
 */

export { betterSqliteDriver, d1Driver } from '@arkade-os/solver-db/driver.js'
export type { D1BoundStatementLike, D1Like } from '@arkade-os/solver-db/driver.js'
export type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'
