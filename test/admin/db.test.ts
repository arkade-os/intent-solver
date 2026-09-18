import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdminStore, adminDbPath, MARKET_SERVING_SEED } from '@arkade-os/solver-app/admin/db.js'
import { betterSqliteDriver, type SqlDriver } from '@arkade-os/solver-corridors/db/driver.js'
import {
  assetMarketKey,
  assetMarketPolicy,
  rfqSymbolFor,
  DEFAULT_SERVING,
  type AssetMarketConfig,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { assetRfqMarketsFrom } from '@arkade-os/solver-app/ops/assetRfqMarkets.js'

const USDA = 'aa'.repeat(34)

const marketFixture = (): AssetMarketConfig => ({
  ...DEFAULT_SERVING,
  base: null,
  quote: USDA,
  baseDecimals: 8,
  quoteDecimals: 6,
  feedUrl: 'https://feed.test/p',
  pricePath: '/p',
  toleranceBps: 10,
  feeBps: 25,
  sellBase: null,
  buyBase: null,
  enabled: true,
})

const preUpgradeDriver = async (): Promise<SqlDriver> => {
  const driver = betterSqliteDriver(':memory:')
  await driver.exec(
    `CREATE TABLE admin_market (market_key TEXT PRIMARY KEY, base TEXT, quote TEXT,
       base_decimals INTEGER NOT NULL, quote_decimals INTEGER NOT NULL, feed_url TEXT NOT NULL,
       price_path TEXT NOT NULL, tolerance_bps INTEGER NOT NULL, fee_bps INTEGER NOT NULL,
       sell_base_min TEXT, sell_base_max TEXT, buy_base_min TEXT, buy_base_max TEXT,
       enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  )
  await driver.run(
    `INSERT INTO admin_market VALUES (?, NULL, ?, 8, 6, 'https://feed.test/p', '/p', 10, 25,
       '1000', '1000000', '2000', '2000000', 1, 1, 1)`,
    [assetMarketKey(null, USDA), USDA],
  )
  return driver
}

let now = 1_000_000
const clock = () => now
let store: AdminStore

beforeEach(async () => {
  now = 1_000_000
  store = await AdminStore.open(':memory:', clock)
})

afterEach(async () => {
  await store.close()
})

describe('adminDbPath', () => {
  it('follows the same suffixing rule as onchainDbPath and receiveDbPath', () => {
    expect(adminDbPath('.data/swaps.sqlite')).toBe('.data/swaps-admin.sqlite')
  })

  it('handles a path with no .sqlite extension, like its siblings', () => {
    expect(adminDbPath('/data/swaps')).toBe('/data/swaps-admin')
  })

  it('never collides with a swap database', () => {
    const swap = '/data/swaps.sqlite'
    expect(adminDbPath(swap)).not.toBe(swap)
    expect(adminDbPath(swap)).not.toBe('/data/swaps-onchain.sqlite')
    expect(adminDbPath(swap)).not.toBe('/data/swaps-receive.sqlite')
  })
})

describe('overrides', () => {
  it('round-trips a value', async () => {
    await store.setOverride('LN_SEND_FEE_BPS', '25')
    expect(await store.getOverrides()).toEqual({ LN_SEND_FEE_BPS: '25' })
  })

  it('starts empty', async () => {
    expect(await store.getOverrides()).toEqual({})
  })

  it('clears an override when set to null, rather than storing the string "null"', async () => {
    await store.setOverride('LN_SEND_FEE_BPS', '25')
    await store.setOverride('LN_SEND_FEE_BPS', null)
    expect(await store.getOverrides()).toEqual({})
  })

  it('overwrites rather than duplicating — the key is the identity', async () => {
    await store.setOverride('LN_SEND_FEE_BPS', '25')
    await store.setOverride('LN_SEND_FEE_BPS', '50')
    expect(await store.getOverrides()).toEqual({ LN_SEND_FEE_BPS: '50' })
  })

  it('keeps unrelated keys independent', async () => {
    await store.setOverride('LN_SEND_FEE_BPS', '25')
    await store.setOverride('ONCHAIN_SEND_MAX_SATS', '50000')
    await store.setOverride('LN_SEND_FEE_BPS', null)
    expect(await store.getOverrides()).toEqual({ ONCHAIN_SEND_MAX_SATS: '50000' })
  })
})

describe('the action audit log', () => {
  it('records an action and reads it back newest-first', async () => {
    await store.recordAction({ action: 'refund-now', target: 'swap-1', params: '{}', outcome: 'ok', detail: 'txid-a' })
    now += 5
    await store.recordAction({ action: 'pool-mint', target: null, params: '{}', outcome: 'error', detail: 'boom' })
    const rows = await store.listActions()
    expect(rows.map((r) => r.action)).toEqual(['pool-mint', 'refund-now'])
    expect(rows[0]).toMatchObject({ outcome: 'error', detail: 'boom', at: 1_000_005, target: null })
  })

  it('records a FAILED action too — that is the one an operator needs the record of', async () => {
    await store.recordAction({
      action: 'onchain-refund-now',
      target: 'swap-9',
      params: '{"id":"swap-9"}',
      outcome: 'error',
      detail: 'emulator refused to co-sign',
    })
    const [row] = await store.listActions()
    expect(row).toMatchObject({ outcome: 'error', detail: 'emulator refused to co-sign' })
  })

  it('orders deterministically when two actions share a timestamp', async () => {
    await store.recordAction({ action: 'first', target: null, params: '{}', outcome: 'ok', detail: null })
    await store.recordAction({ action: 'second', target: null, params: '{}', outcome: 'ok', detail: null })
    expect((await store.listActions()).map((r) => r.action)).toEqual(['second', 'first'])
  })

  it('honours a limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.recordAction({ action: `a${i}`, target: null, params: '{}', outcome: 'ok', detail: null })
      now += 1
    }
    expect(await store.listActions(2)).toHaveLength(2)
  })
})

describe('admin_market gains the serving columns', () => {
  it('adds them to a table that shipped without them', async () => {
    const driver = betterSqliteDriver(':memory:')
    await driver.exec(
      `CREATE TABLE admin_market (market_key TEXT PRIMARY KEY, base TEXT, quote TEXT,
         base_decimals INTEGER NOT NULL, quote_decimals INTEGER NOT NULL, feed_url TEXT NOT NULL,
         price_path TEXT NOT NULL, tolerance_bps INTEGER NOT NULL, fee_bps INTEGER NOT NULL,
         sell_base_min TEXT, sell_base_max TEXT, buy_base_min TEXT, buy_base_max TEXT,
         enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    )
    await driver.run(
      `INSERT INTO admin_market VALUES (?, NULL, ?, 8, 6, 'https://feed.test/p', '/p', 10, 25,
         NULL, NULL, NULL, NULL, 1, 1, 1)`,
      [assetMarketKey(null, USDA), USDA],
    )
    const store = await AdminStore.open(driver, () => 1_000)
    const columns = new Set((await driver.all<{ name: string }>('PRAGMA table_info(admin_market)')).map((c) => c.name))
    for (const name of ['symbol', 'serves_offer', 'serves_rfq', 'rfq_sell_base', 'rfq_buy_base', 'carrier_mode']) {
      expect(columns.has(name), name).toBe(true)
    }
    // The pre-existing row survives with its own values, not a rewritten set.
    expect((await store.listMarkets())[0]).toMatchObject({ feeBps: 25, toleranceBps: 10, enabled: true })
  })

  it('records an audit revision when one is supplied, and null when it is not', async () => {
    const store = await AdminStore.open(':memory:', () => 1_000)
    await store.recordAction({ action: 'a', target: null, params: '{}', outcome: 'ok', detail: null })
    await store.recordAction({
      action: 'b',
      target: null,
      params: '{}',
      outcome: 'ok',
      detail: null,
      revision: 'rev-1',
    })
    expect((await store.listActions()).map((row) => row.revision)).toEqual(['rev-1', null])
  })
})

describe('the one-shot serving seed', () => {
  const seed = {
    offerMarkets: [{ a: null, b: USDA }],
    tokens: [{ symbol: 'USDA', assetId: USDA, enabled: { sell_base: true, buy_base: false } }],
  }

  const withRow = async () => {
    const driver = betterSqliteDriver(':memory:')
    const store = await AdminStore.open(driver, () => 1_000)
    await store.putMarket({ ...marketFixture(), ...DEFAULT_SERVING, symbol: 'TMP' })
    await driver.run('UPDATE admin_market SET symbol = NULL, serves_offer = 0, serves_rfq = 1, rfq_buy_base = 1')
    await driver.run('DELETE FROM admin_migration')
    return { driver, store }
  }

  it('writes the env into the rows, and the marker with them', async () => {
    const { driver } = await withRow()
    await AdminStore.open(driver, () => 2_000, seed)
    const row = (await driver.all<Record<string, unknown>>('SELECT * FROM admin_market'))[0]!
    expect(row).toMatchObject({ symbol: 'USDA', serves_offer: 1, serves_rfq: 1, rfq_sell_base: 1, rfq_buy_base: 0 })
    expect(await driver.all('SELECT name FROM admin_migration')).toEqual([{ name: MARKET_SERVING_SEED }])
  })

  it('never runs twice, whatever the environment says the second time', async () => {
    const { driver } = await withRow()
    await AdminStore.open(driver, () => 2_000, seed)
    await driver.run('UPDATE admin_market SET serves_rfq = 0')
    await AdminStore.open(driver, () => 3_000, { offerMarkets: [], tokens: [] })
    expect((await driver.all<{ serves_rfq: number }>('SELECT serves_rfq FROM admin_market'))[0]!.serves_rfq).toBe(0)
  })

  it('marks a store with no rows at all', async () => {
    // Zero rows beside a non-empty OFFER_MARKETS is SUPPORTED, so deriving
    // "already seeded" from the data would re-seed this deployment for ever.
    const driver = betterSqliteDriver(':memory:')
    await AdminStore.open(driver, () => 1_000, seed)
    expect(await driver.all('SELECT name FROM admin_migration')).toEqual([{ name: MARKET_SERVING_SEED }])
  })

  it('does not seed or mark when no seed is supplied', async () => {
    const driver = betterSqliteDriver(':memory:')
    await AdminStore.open(driver, () => 1_000)
    expect(await driver.all('SELECT name FROM admin_migration')).toEqual([])
  })

  it('boots a real pre-upgrade file, and serves over RFQ exactly what it served before', async () => {
    const driver = await preUpgradeDriver()
    const store = await AdminStore.open(driver, () => 2_000, { offerMarkets: [], tokens: [] })
    const rows = await store.listMarkets()
    expect(() => assetMarketPolicy(rows)).not.toThrow()
    expect(rows[0]).toMatchObject({ symbol: rfqSymbolFor(USDA), servesRfq: true, rfqSellBase: true, rfqBuyBase: true })
    expect(assetRfqMarketsFrom([], assetMarketPolicy(rows).pricing)).toMatchObject([
      {
        symbol: rfqSymbolFor(USDA),
        base: null,
        quote: USDA,
        feeBps: 25,
        feedUrl: 'https://feed.test/p',
        sellBase: { min: 1_000n, max: 1_000_000n },
        buyBase: { min: 2_000n, max: 2_000_000n },
      },
    ])
  })
})
