/**
 * Where the stored serving flags and the environment disagree, and whether an
 * operator is ever told. A repair that happens without surfacing leaves a
 * deployment quoting under synthesised symbols with nothing on the page
 * distinguishing it from a healthy one.
 */
import { describe, it, expect } from 'vitest'
import { marketServingDivergence } from '@arkade-os/solver-app/ops/marketDivergence.js'
import {
  assetMarketKey,
  DEFAULT_SERVING,
  type AssetMarketConfig,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { AdminStore, type AssetMarketRow, type ServingSeed } from '@arkade-os/solver-app/admin/db.js'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { createServicesBody } from '../support/createServicesBody.js'

const USDA = '1a'.repeat(34)

const rowFixture = (): AssetMarketRow => ({
  ...(DEFAULT_SERVING satisfies Partial<AssetMarketConfig>),
  marketKey: assetMarketKey(null, USDA),
  base: null,
  quote: USDA,
  baseDecimals: 8,
  quoteDecimals: 6,
  feedUrl: 'https://feed.test/p',
  pricePath: '/p',
  toleranceBps: 10,
  feeBps: 25,
  sellBaseFeeFlat: 0n,
  buyBaseFeeFlat: 0n,
  sellBase: null,
  buyBase: null,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
})

describe('marketServingDivergence', () => {
  const row = (over: Partial<AssetMarketRow> = {}): AssetMarketRow => ({
    ...rowFixture(),
    symbol: 'USDA',
    servesOffer: false,
    servesRfq: true,
    rfqSellBase: true,
    rfqBuyBase: true,
    ...over,
  })
  const env: ServingSeed = {
    offerMarkets: [],
    tokens: [{ symbol: 'USDA', assetId: USDA, enabled: { sell_base: true, buy_base: true } }],
  }

  it('says nothing when the rows match the environment', () => {
    expect(marketServingDivergence([row()], env)).toEqual([])
  })

  it('names a direction the row closed and the environment leaves open', () => {
    const [line] = marketServingDivergence([row({ rfqBuyBase: false })], env)
    expect(line).toMatch(/USDA/)
    expect(line).toMatch(/buy_base/)
    expect(line).toMatch(/ASSET_USDA_SELL/)
  })

  it('names a market the environment declares for offers and the row does not', () => {
    const [line] = marketServingDivergence([row()], { ...env, offerMarkets: [{ a: null, b: USDA }] })
    expect(line).toMatch(/OFFER_MARKETS/)
  })

  it('names an env symbol no row carries', () => {
    expect(marketServingDivergence([], env)[0]).toMatch(/ASSET_MARKETS names USDA/)
  })

  it('names a market that is enabled and quoting on neither path, and says what to do', () => {
    const [line] = marketServingDivergence([row({ servesOffer: false, servesRfq: false })], env)
    expect(line).toMatch(/USDA/)
    expect(line).toMatch(/quoting nothing/)
    expect(line).toMatch(/disable/)
  })

  it('stays quiet about a market the operator already disabled, which is not a surprise', () => {
    const off = row({ servesOffer: false, servesRfq: false, enabled: false })
    expect(marketServingDivergence([off], env)).toEqual([])
  })
})

describe('what the console itself creates, through the route an operator uses', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    base: null,
    quote: USDA,
    symbol: 'USDA',
    baseDecimals: 8,
    quoteDecimals: 6,
    feedUrl: 'https://feed.test/p',
    pricePath: '/data/amount',
    toleranceBps: 10,
    feeBps: 25,
    sellBaseFeeFlat: '0',
    buyBaseFeeFlat: '0',
    sellBase: { min: '1', max: '1000' },
    buyBase: { min: '1', max: '1000' },
    ...over,
  })

  const stored = async (over: Record<string, unknown> = {}): Promise<AssetMarketRow> => {
    const driver = betterSqliteDriver(':memory:')
    const store = await AdminStore.open(driver, () => 1_000, { offerMarkets: [], tokens: [] })
    const app = buildAdminApp({
      services: { adminStore: store, config: {}, policy: {}, replaceMarkets: async () => {} } as never,
      startedAt: 1,
      mode: 'relay',
      fetchPrice: async () => ({ mantissa: 100_000n, scale: 0 }),
    })
    const response = await app.fetch(
      new Request('http://admin/api/markets', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body(over)),
      }),
    )
    expect(response.status).toBe(200)
    return (await store.listMarkets())[0]!
  }

  // Inverted, not deleted. It used to pin the opposite — that this route stored a row
  // quoting nothing — which is what the `servesRfq: false` bridge made true.
  it('says nothing about a market created through PUT /api/markets: it serves RFQ', async () => {
    const row = await stored()
    expect(row).toMatchObject({ enabled: true, servesRfq: true })
    expect(marketServingDivergence([row], { offerMarkets: [], tokens: [] })).toEqual([])
  })

  it('still fires when the operator switches both paths off through that same route', async () => {
    const row = await stored({ servesRfq: false })
    expect(row).toMatchObject({ enabled: true, servesOffer: false, servesRfq: false })
    const [line] = marketServingDivergence([row], { offerMarkets: [], tokens: [] })
    expect(line).toContain(row.symbol)
    expect(line).toMatch(/quoting nothing/)
  })
})

describe('createServices tells the operator at boot', () => {
  const body = () => createServicesBody()

  it('logs every repair the store made, which is the only word a repaired row gets in a terminal', () => {
    expect(body()).toContain('for (const line of adminStore.repairedServing)')
  })

  it('logs every disagreement between the rows and the environment', () => {
    expect(body()).toContain('marketServingDivergence(marketRows, {')
  })
})
