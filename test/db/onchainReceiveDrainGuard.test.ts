import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { betterSqliteDriver, type SqlDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { suffixed } from '@arkade-os/solver-corridors/db/layout.js'
import { findUndrainedOnchainReceive } from '@arkade-os/solver-corridors/db/onchainReceiveDrainGuard.js'

const seed = async (driver: SqlDriver, states: string[]): Promise<void> => {
  await driver.exec('CREATE TABLE receive_onchain_swap (id TEXT PRIMARY KEY, state TEXT NOT NULL)')
  for (const [i, state] of states.entries()) {
    await driver.run('INSERT INTO receive_onchain_swap (id, state) VALUES (?, ?)', [`row-${i}`, state])
  }
}

let dir: string
let swapDbPath: string
let swapFile: SqlDriver

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'drain-guard-'))
  swapDbPath = join(dir, 'swaps.sqlite')
  swapFile = betterSqliteDriver(':memory:')
})

afterEach(async () => {
  await swapFile.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('findUndrainedOnchainReceive', () => {
  it('counts zero when the table was never created', async () => {
    expect(await findUndrainedOnchainReceive(swapDbPath, swapFile)).toEqual({ count: 0, files: [] })
  })

  it('counts only the live rows in the consolidated swap file', async () => {
    await seed(swapFile, ['funding_arkade', 'awaiting_claim', 'settled', 'refunded', 'refused', 'stuck'])
    expect(await findUndrainedOnchainReceive(swapDbPath, swapFile)).toEqual({ count: 2, files: [swapDbPath] })
  })

  it('counts zero when every row is terminal', async () => {
    await seed(swapFile, ['settled', 'refunded', 'refused', 'stuck'])
    expect(await findUndrainedOnchainReceive(swapDbPath, swapFile)).toEqual({ count: 0, files: [] })
  })

  it('finds live rows in the suffixed split file the daemon no longer opens', async () => {
    const splitPath = suffixed(swapDbPath, 'onchain-receive')
    const split = betterSqliteDriver(splitPath)
    await seed(split, ['quoted', 'refunding_arkade', 'settled'])
    await split.close()

    expect(await findUndrainedOnchainReceive(swapDbPath, swapFile)).toEqual({ count: 2, files: [splitPath] })
  })
})
