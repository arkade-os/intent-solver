import { describe, it, expect, vi } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import {
  assetMarketKey,
  DEFAULT_SERVING,
  rfqSymbolFor,
  type AssetMarketConfig,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'

const USDA = 'aa'.repeat(34)
const USDB = 'bb'.repeat(34)
const KEY_A = assetMarketKey(null, USDA)
const KEY_B = assetMarketKey(null, USDB)
const FEE_PATH = 'corridors["arkade:BTC->lightning:BTC"].feeBps'

const allCorridors = <T>(value: T) => ({
  'arkade:BTC->lightning:BTC': value,
  'lightning:BTC->arkade:BTC': value,
  'arkade:BTC->onchain:BTC': value,
  'onchain:BTC->arkade:BTC': value,
})

// The config names USDA and lets the client sell it for BTC but not buy it.
const config = {
  corridorEnabled: allCorridors(true),
  corridorFees: allCorridors({ bps: 0, flatSats: 0 }),
  corridorLimits: allCorridors({ minSats: 1_000, maxSats: 100_000 }),
  maxExposedSats: 300_000,
  lockupTimeoutSeconds: 600,
  assetCarrierPricing: false,
  offerMarkets: [],
  assetRfqTokens: [
    {
      symbol: 'USDA',
      assetId: USDA,
      enabled: { clientGivesAsset: true, clientGetsAsset: false },
      approvalThresholdUnits: null,
    },
  ],
  configPaths: new Map([['LN_SEND_FEE_BPS', FEE_PATH]]),
}

const market = (quote: string, symbol: string): AssetMarketConfig => ({
  ...DEFAULT_SERVING,
  symbol,
  base: null,
  quote,
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

const setup = async () => {
  const store = await AdminStore.open(betterSqliteDriver(':memory:'), () => 1_000)
  // USDA: both directions open, where the config closes the client buying it.
  await store.putMarket(market(USDA, 'USDA'))
  // USDB: exactly what the config implies for an asset it does not name.
  await store.putMarket(market(USDB, rfqSymbolFor(USDB)))
  await store.setOverride('LN_SEND_FEE_BPS', '25')
  await store.setOverride('REBALANCE_POLICY', '{"enabled":true}')
  const replacePolicy = vi.fn(async () => {})
  const replaceMarkets = vi.fn(async () => {})
  const services = { config, adminStore: store, replacePolicy, replaceMarkets }
  const app = buildAdminApp({ services: services as never, startedAt: 1, mode: 'relay' })
  const post = async (body: unknown) => {
    const response = await app.fetch(
      new Request('http://admin/api/config/revert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    return { status: response.status, body: (await response.json()) as Record<string, any> }
  }
  return { store, post, replacePolicy, replaceMarkets }
}

const rowOf = async (store: AdminStore, key: string) =>
  (await store.listMarkets()).find((row) => row.marketKey === key)!

describe('POST /api/config/revert — the preview', () => {
  it('lists every change, and writes nothing', async () => {
    const { store, post } = await setup()
    const { status, body } = await post({ scope: 'all', dryRun: true })
    expect(status).toBe(200)
    expect(body.changes).toEqual([
      // BTC is this row's base, so the client buying USDA is the client GIVING the base: sell_base.
      { target: 'USDA', marketKey: KEY_A, field: 'rfqSellBase', current: 'true', config: 'false', applies: 'now' },
      { target: FEE_PATH, field: 'value', current: '25', config: '0', applies: 'restart' },
    ])
    expect(body.basis).toMatch(/^[0-9a-f]{64}$/)
    expect((await rowOf(store, KEY_A)).rfqSellBase).toBe(true)
    expect(await store.getOverrides()).toMatchObject({ LN_SEND_FEE_BPS: '25' })
  })

  it('never touches an override the config has no value for', async () => {
    const { post } = await setup()
    const { body } = await post({ scope: 'all', dryRun: true })
    expect(JSON.stringify(body.changes)).not.toContain('REBALANCE_POLICY')
  })

  it('names a row without a symbol by the symbol the config gives it', async () => {
    const { store, post } = await setup()
    await store.putMarket({ ...market(USDB, rfqSymbolFor(USDB)), symbol: null, servesRfq: false })
    const { body } = await post({ scope: 'market', marketKey: KEY_B, dryRun: true })
    expect(body.changes.map((change: { target: string }) => change.target)).toContain(rfqSymbolFor(USDB))
    expect(JSON.stringify(body.changes)).not.toContain(`"target":"${KEY_B}"`)
  })

  it('offers a market alone only where reverting it alone would change it', async () => {
    const { store, post } = await setup()
    // USDB holds the symbol the config gives USDA, so USDA alone can only give up its own.
    await store.putMarket(market(USDA, 'ELSEWHERE'))
    await store.putMarket(market(USDB, 'USDA'))
    const alone = (await post({ scope: 'market', marketKey: KEY_A, dryRun: true })).body
    await post({ scope: 'market', marketKey: KEY_A, dryRun: false, basis: alone.basis })
    const { body } = await post({ scope: 'all', dryRun: true })
    expect(body.changes.some((change: { marketKey?: string }) => change.marketKey === KEY_A)).toBe(true)
    expect(body.revertibleAlone).toEqual([KEY_B])
  })

  it('answers 404 for a market that does not exist', async () => {
    const { post } = await setup()
    expect((await post({ scope: 'market', marketKey: 'nope', dryRun: true })).status).toBe(404)
  })

  it('refuses a body that does not say whether it is a preview', async () => {
    const { post } = await setup()
    expect((await post({ scope: 'all' })).status).toBe(400)
    expect((await post({ scope: 'everything', dryRun: true })).status).toBe(400)
  })
})

describe('POST /api/config/revert — applying', () => {
  it('applies exactly what the preview showed, and reloads what changed', async () => {
    const { store, post, replaceMarkets, replacePolicy } = await setup()
    const preview = (await post({ scope: 'all', dryRun: true })).body
    const { status, body } = await post({ scope: 'all', dryRun: false, basis: preview.basis })
    expect(status).toBe(200)
    expect(body.applied).toEqual(preview.changes)
    expect((await rowOf(store, KEY_A)).rfqSellBase).toBe(false)
    expect(await store.getOverrides()).toEqual({ REBALANCE_POLICY: '{"enabled":true}' })
    expect(replaceMarkets).toHaveBeenCalledTimes(1)
    // LN_SEND_FEE_BPS takes a restart, so the running policy is not rewritten under the solver.
    expect(replacePolicy).not.toHaveBeenCalled()
  })

  it('has nothing left to change afterwards', async () => {
    const { post } = await setup()
    const preview = (await post({ scope: 'all', dryRun: true })).body
    await post({ scope: 'all', dryRun: false, basis: preview.basis })
    expect((await post({ scope: 'all', dryRun: true })).body.changes).toEqual([])
  })

  it('writes one audit row per apply', async () => {
    const { store, post } = await setup()
    const preview = (await post({ scope: 'all', dryRun: true })).body
    await post({ scope: 'all', dryRun: false, basis: preview.basis })
    expect((await store.listActions()).filter((row) => row.action === 'config-revert')).toHaveLength(1)
  })

  it('refuses an apply whose preview is stale, and writes nothing', async () => {
    const { store, post } = await setup()
    const preview = (await post({ scope: 'all', dryRun: true })).body
    await store.setOverride('LN_SEND_FEE_BPS', '30')
    const { status, body } = await post({ scope: 'all', dryRun: false, basis: preview.basis })
    expect(status).toBe(409)
    expect(body.message).toBe('config or console state changed since the preview; review again')
    expect((await rowOf(store, KEY_A)).rfqSellBase).toBe(true)
    expect(await store.getOverrides()).toMatchObject({ LN_SEND_FEE_BPS: '30' })
  })

  it('refuses an apply with no preview behind it', async () => {
    const { post } = await setup()
    expect((await post({ scope: 'all', dryRun: false })).status).toBe(409)
  })

  it('refuses a one-market apply when that row moved since the preview', async () => {
    const { store, post } = await setup()
    const preview = (await post({ scope: 'market', marketKey: KEY_A, dryRun: true })).body
    await store.putMarket({ ...market(USDA, 'USDA'), rfqBuyBase: false })
    expect((await post({ scope: 'market', marketKey: KEY_A, dryRun: false, basis: preview.basis })).status).toBe(409)
    expect(await rowOf(store, KEY_A)).toMatchObject({ rfqSellBase: true, rfqBuyBase: false })
  })

  it('reverts one market and leaves the overrides and every other row alone', async () => {
    const { store, post } = await setup()
    await store.putMarket({
      ...market(USDB, rfqSymbolFor(USDB)),
      servesRfq: false,
      rfqSellBase: false,
      rfqBuyBase: false,
    })
    const preview = (await post({ scope: 'market', marketKey: KEY_A, dryRun: true })).body
    expect(preview.changes.map((change: { target: string }) => change.target)).toEqual(['USDA'])
    await post({ scope: 'market', marketKey: KEY_A, dryRun: false, basis: preview.basis })
    expect((await rowOf(store, KEY_A)).rfqSellBase).toBe(false)
    expect((await rowOf(store, KEY_B)).servesRfq).toBe(false)
    expect(await store.getOverrides()).toMatchObject({ LN_SEND_FEE_BPS: '25' })
  })

  it('moves a symbol from one row to another without tripping the one-symbol-per-row index', async () => {
    const { store, post } = await setup()
    // USDB holds 'USDA' today; the config gives it back to USDA, whose row is updated first.
    await store.putMarket(market(USDA, 'ELSEWHERE'))
    await store.putMarket(market(USDB, 'USDA'))
    const preview = (await post({ scope: 'all', dryRun: true })).body
    const { status, body } = await post({ scope: 'all', dryRun: false, basis: preview.basis })
    expect(status).toBe(200)
    expect(body.applied).toEqual(preview.changes)
    expect((await rowOf(store, KEY_A)).symbol).toBe('USDA')
    expect((await rowOf(store, KEY_B)).symbol).toBe(rfqSymbolFor(USDB))
  })
})
