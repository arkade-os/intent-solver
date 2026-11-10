import { existsSync } from 'node:fs'
import { betterSqliteDriver, type SqlDriver } from './driver.js'
import { suffixed } from './layout.js'

// #292 removed the onchain-receive corridor with no boot guard, so an upgrade
// past it silently strands any row still mid-swap in the dead table below.
const TABLE = 'receive_onchain_swap'

const LIVE_STATES = [
  'quoted',
  'awaiting_confirmations',
  'funding_arkade',
  'awaiting_claim',
  'claimed',
  'refunding_arkade',
] as const

const liveRowsIn = async (driver: SqlDriver): Promise<number> => {
  // PRAGMA answers empty for a missing table rather than throwing.
  if ((await driver.all(`PRAGMA table_info(${TABLE})`)).length === 0) return 0
  const placeholders = LIVE_STATES.map(() => '?').join(',')
  const row = await driver.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE state IN (${placeholders})`, [
    ...LIVE_STATES,
  ])
  return row?.n ?? 0
}

export interface UndrainedOnchainReceive {
  readonly count: number
  readonly files: readonly string[]
}

// Both files that could hold the table: the open swap file (consolidated) and
// the suffixed `-onchain-receive` file a split deployment no longer opens.
export const findUndrainedOnchainReceive = async (
  swapDbPath: string,
  swapFile: SqlDriver,
  exists: (path: string) => boolean = existsSync,
): Promise<UndrainedOnchainReceive> => {
  const files: string[] = []
  let count = 0
  const inSwap = await liveRowsIn(swapFile)
  if (inSwap > 0) {
    count += inSwap
    files.push(swapDbPath)
  }
  const splitPath = suffixed(swapDbPath, 'onchain-receive')
  if (splitPath !== swapDbPath && exists(splitPath)) {
    const driver = betterSqliteDriver(splitPath)
    try {
      const inSplit = await liveRowsIn(driver)
      if (inSplit > 0) {
        count += inSplit
        files.push(splitPath)
      }
    } finally {
      await driver.close()
    }
  }
  return { count, files }
}

export const undrainedOnchainReceiveMessage = (found: UndrainedOnchainReceive): string =>
  `${found.count} onchain-receive swap(s) are still mid-flight in ${found.files.join(', ')} — a corridor ` +
  `this build no longer drives (removed in #292). Drain them on a build that still serves the corridor, or set ` +
  `ALLOW_UNDRAINED_ONCHAIN_RECEIVE=true to boot anyway and leave them undriven.`
