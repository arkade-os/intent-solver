import { describe, it, expect } from 'vitest'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { OnchainReceiveSwapStore } from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'
import { AdminStore } from '../../src/admin/db.js'

/**
 * The consolidated layout hands ONE driver to all five stores. `resolveDbLayout`
 * only decides that this should happen; these tests are what say it works.
 *
 * Opened in the same order `createServices` opens them, and awaited one at a
 * time, because that ordering is load-bearing: `SwapStore.open()` runs a table
 * rebuild inside `driver.transaction()`, and two stores mid-transaction on one
 * handle would nest a `BEGIN` that SQLite rejects.
 */
const openAll = async (driver: ReturnType<typeof betterSqliteDriver>) => {
  const store = await SwapStore.open(driver)
  const onchainStore = await OnchainSendSwapStore.open(driver)
  const receiveStore = await ReceiveSwapStore.open(driver)
  const onchainReceiveStore = await OnchainReceiveSwapStore.open(driver)
  const adminStore = await AdminStore.open(driver)
  return { store, onchainStore, receiveStore, onchainReceiveStore, adminStore }
}

describe('five stores on one connection', () => {
  it('opens every store against a single driver without their schemas colliding', async () => {
    const driver = betterSqliteDriver(':memory:')
    const stores = await openAll(driver)

    // Each store can reach its own table. A collision would have thrown during
    // open(); this proves the tables are separately addressable afterwards.
    expect(await stores.store.committedSats()).toBe(0)
    expect(await stores.onchainStore.committedSats()).toBe(0)
    expect(await stores.receiveStore.committedSats()).toBe(0)
    expect(await stores.onchainReceiveStore.committedSats()).toBe(0)
    expect(await stores.adminStore.getOverrides()).toBeDefined()

    await driver.close()
  })

  it('puts every corridorable table in the one database', async () => {
    const driver = betterSqliteDriver(':memory:')
    await openAll(driver)

    const tables = await driver.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    const names = new Set(tables.map((t) => t.name))

    for (const table of [
      'send_swap',
      'send_onchain_swap',
      'receive_swap',
      'receive_onchain_swap',
      'admin_override',
      'admin_action',
    ]) {
      expect(names.has(table), `${table} missing from the shared database`).toBe(true)
    }

    await driver.close()
  })

  it('keeps each corridor’s rows to its own table', async () => {
    const driver = betterSqliteDriver(':memory:')
    const stores = await openAll(driver)

    // A row in one corridor must not show up in another's committed total —
    // the tables share a file, not a namespace. Written through the driver
    // rather than `insertQuote` so the test states only what it is about: a row
    // exists in this table, and nothing about how a real quote is shaped.
    const columns = await driver.all<{ name: string; notnull: number; dflt_value: unknown }>(
      `PRAGMA table_info(send_onchain_swap)`,
    )
    const required = columns.filter((column) => column.notnull && column.dflt_value === null).map((c) => c.name)
    const value = (name: string) => (name === 'amount_sats' ? 4242 : name === 'state' ? `'quoted'` : `'1'`)
    await driver.run(
      `INSERT INTO send_onchain_swap (id, ${required.join(', ')})
       VALUES ('x', ${required.map(value).join(', ')})`,
    )

    expect(await stores.onchainStore.committedSats()).toBe(4242)
    expect(await stores.store.committedSats()).toBe(0)
    expect(await stores.receiveStore.committedSats()).toBe(0)
    expect(await stores.onchainReceiveStore.committedSats()).toBe(0)

    await driver.close()
  })

  it('survives every store closing the connection it shares', async () => {
    const driver = betterSqliteDriver(':memory:')
    const stores = await openAll(driver)

    // `Services.close()` closes all five in sequence. The first really closes
    // the handle; the rest must not throw, or shutdown would log four spurious
    // failures and skip whatever came after them in the step list.
    await stores.store.close()
    await expect(stores.onchainStore.close()).resolves.toBeUndefined()
    await expect(stores.receiveStore.close()).resolves.toBeUndefined()
    await expect(stores.onchainReceiveStore.close()).resolves.toBeUndefined()
    await expect(stores.adminStore.close()).resolves.toBeUndefined()
  })
})
