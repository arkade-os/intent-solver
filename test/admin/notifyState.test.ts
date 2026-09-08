import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'

let now = 1_000_000
let store: AdminStore

beforeEach(async () => {
  now = 1_000_000
  store = await AdminStore.open(':memory:', () => now)
})
afterEach(async () => {
  await store.close()
})

describe('the last announced balance', () => {
  /**
   * The restart case this exists for: in memory, the first event after every
   * deploy would compare against nothing and read as a meaningless "+0%".
   */
  it('is null before anything has been announced', async () => {
    expect(await store.getLastAnnouncedBalance()).toBeNull()
  })

  it('round-trips a reading', async () => {
    await store.setLastAnnouncedBalance(250_000)
    expect(await store.getLastAnnouncedBalance()).toBe(250_000)
  })

  it('overwrites rather than accumulating rows', async () => {
    await store.setLastAnnouncedBalance(1)
    await store.setLastAnnouncedBalance(2)
    await store.setLastAnnouncedBalance(3)
    expect(await store.getLastAnnouncedBalance()).toBe(3)
  })

  // Zero is a real balance and must not read back as "never announced" — that
  // is the difference between "n/a" and a genuine -100%.
  it('distinguishes a stored ZERO from nothing stored', async () => {
    await store.setLastAnnouncedBalance(0)
    expect(await store.getLastAnnouncedBalance()).toBe(0)
  })

  it('survives a reopen of the same database', async () => {
    const driver = (await import('@arkade-os/solver-corridors/db/driver.js')).betterSqliteDriver(':memory:')
    const first = await AdminStore.open(driver, () => now)
    await first.setLastAnnouncedBalance(777)
    // Same driver, a second store object: the value came off disk, not memory.
    const second = await AdminStore.open(driver, () => now)
    expect(await second.getLastAnnouncedBalance()).toBe(777)
    await second.close()
  })
})
