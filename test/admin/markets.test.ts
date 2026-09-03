/**
 * The market table: what survives a round trip, and what the primary key makes
 * impossible.
 *
 * The duplicate-pair case is the one that matters. `AssetOfferService` resolves
 * a market with `pricing.find()`, so two rows for one pair would decide which
 * feed and which spread applies by row order — silently, and differently after
 * any reordering. The key is derived from the legs precisely so the database
 * refuses to hold that shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdminStore, type AssetMarketRow } from '@arkade-os/solver-app/admin/db.js'
import { assetMarketKey, type AssetMarketConfig } from '@arkade-os/solver-core/core/assetMarketConfig.js'

const USDT = 'aa'.repeat(34)
const OTHER = 'bb'.repeat(34)

let now = 1_000_000
const clock = () => now
let store: AdminStore

const market = (over: Partial<AssetMarketConfig> = {}): AssetMarketConfig => ({
  base: null,
  quote: USDT,
  baseDecimals: 8,
  quoteDecimals: 6,
  feedUrl: 'https://feed.test/price',
  pricePath: '/price',
  toleranceBps: 10,
  feeBps: 25,
  sellBase: null,
  buyBase: null,
  enabled: true,
  ...over,
})

beforeEach(async () => {
  now = 1_000_000
  store = await AdminStore.open(':memory:', clock)
})

afterEach(async () => {
  await store.close()
})

describe('markets', () => {
  it('starts empty, which is the untouched deployment', async () => {
    expect(await store.listMarkets()).toEqual([])
  })

  it('round-trips every field', async () => {
    const written = await store.putMarket(market({ sellBase: { min: 1n, max: 2n } }))
    const [read] = await store.listMarkets()
    expect(read).toEqual(written)
    expect(read).toMatchObject({
      base: null,
      quote: USDT,
      baseDecimals: 8,
      quoteDecimals: 6,
      feedUrl: 'https://feed.test/price',
      pricePath: '/price',
      toleranceBps: 10,
      feeBps: 25,
      sellBase: { min: 1n, max: 2n },
      buyBase: null,
      enabled: true,
    })
  })

  it('files a market under the key its own legs derive', async () => {
    const row = await store.putMarket(market())
    expect(row.marketKey).toBe(assetMarketKey(null, USDT))
    expect(await store.getMarket(row.marketKey)).not.toBeNull()
  })

  it('keeps the BTC leg as null, never the string "null"', async () => {
    // `String(null)` would file the sats leg under a four-letter id that
    // `offerDirectionOn` matches against nothing and refuses against nothing.
    const [row] = await store.listMarkets().then(async () => {
      await store.putMarket(market())
      return store.listMarkets()
    })
    expect(row!.base).toBeNull()
  })

  it('carries a bound past 2^53 without mangling it', async () => {
    // The reason the columns are TEXT: SQLite's INTEGER is a signed 64-bit and
    // a JSON number has already lost precision by the time it gets here.
    const huge = 123_456_789_012_345_678_901_234_567_890n
    const row = await store.putMarket(market({ buyBase: { min: 0n, max: huge } }))
    expect(row.buyBase).toEqual({ min: 0n, max: huge })
  })

  it('overwrites rather than duplicating when the same pair is written again', async () => {
    await store.putMarket(market({ feeBps: 25 }))
    await store.putMarket(market({ feeBps: 50 }))
    const rows = await store.listMarkets()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.feeBps).toBe(50)
  })

  it('treats a pair with its legs swapped as the SAME market, not a second one', async () => {
    await store.putMarket(market({ base: null, quote: USDT }))
    await store.putMarket(market({ base: USDT, quote: null }))
    // One row, because two would let `pricing.find()` pick a feed by row order.
    expect(await store.listMarkets()).toHaveLength(1)
  })

  it('lets a swapped write change which leg is base, since the feed quotes quote-per-base', async () => {
    await store.putMarket(market({ base: null, quote: USDT }))
    await store.putMarket(market({ base: USDT, quote: null }))
    const [row] = await store.listMarkets()
    expect(row!.base).toBe(USDT)
    expect(row!.quote).toBeNull()
  })

  it('keeps created_at through an edit and moves updated_at', async () => {
    // "How long have we been trading this pair" is the question the audit asks
    // of this table; an edit is not an addition.
    const first = await store.putMarket(market())
    now += 500
    const edited = await store.putMarket(market({ feeBps: 99 }))
    expect(edited.createdAt).toBe(first.createdAt)
    expect(edited.updatedAt).toBe(first.updatedAt + 500)
  })

  it('holds several distinct markets at once, ordered stably', async () => {
    await store.putMarket(market({ base: USDT, quote: OTHER }))
    await store.putMarket(market())
    const keys = (await store.listMarkets()).map((row: AssetMarketRow) => row.marketKey)
    expect(keys).toHaveLength(2)
    expect(keys).toEqual([...keys].sort())
  })

  it('deletes by key and says whether anything went', async () => {
    const row = await store.putMarket(market())
    expect(await store.deleteMarket(row.marketKey)).toBe(true)
    expect(await store.listMarkets()).toEqual([])
    expect(await store.deleteMarket(row.marketKey)).toBe(false)
  })

  it('answers null for a key nothing is filed under', async () => {
    expect(await store.getMarket('arkade:btc/arkade:nope')).toBeNull()
  })

  it('leaves the overrides and the audit log alone', async () => {
    // Same database, different tables: a market write must not disturb the two
    // things that were already in this file.
    await store.setOverride('LN_SEND_FEE_BPS', '25')
    await store.putMarket(market())
    expect(await store.getOverrides()).toEqual({ LN_SEND_FEE_BPS: '25' })
    expect(await store.listActions()).toEqual([])
  })
})
