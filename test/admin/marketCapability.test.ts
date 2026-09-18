// Whether anything FILLS a market is decided by two env vars the console never
// rendered. One was configured, listed `trading`, offered against — and the
// solver detected nothing, because the answer was in `OFFER_MARKETS`.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { marketCapability, type ServingRuntime } from '@arkade-os/solver-app/admin/marketCapability.js'
import { describeSettings } from '@arkade-os/solver-app/admin/settings.js'
import { assetMarketKey, type AssetMarketConfig } from '@arkade-os/solver-core/core/assetMarketConfig.js'

const USDT = 'aa'.repeat(34)
const OTHER = 'bb'.repeat(34)
const KEY = assetMarketKey(null, USDT)

const btcUsdt = { base: null, quote: USDT }
const token = (assetId: string) => ({ symbol: 'USDT', assetId, enabled: { sell_base: true, buy_base: true } })
const serving = (over: Partial<ServingRuntime> = {}): ServingRuntime => ({
  assetOffers: null,
  liveOfferMarkets: [],
  assetRfqMarkets: [],
  ...over,
})
const pair = (over: Partial<AssetMarketConfig> = {}) => ({
  base: null,
  quote: USDT,
  enabled: true,
  servesOffer: false,
  servesRfq: false,
  rfqSellBase: true,
  rfqBuyBase: true,
  ...over,
})

describe('marketCapability — what fills the pair', () => {
  it('reports NOTHING when neither path fills the pair', () => {
    expect(marketCapability(pair(), serving()).serving).toEqual([])
  })

  it('reports the offer path when the live offer list names the pair', () => {
    expect(marketCapability(pair(), serving({ liveOfferMarkets: [{ a: null, b: USDT }] })).serving).toEqual(['offer'])
  })

  it('matches the live offer list with the legs the other way round', () => {
    expect(marketCapability(pair(), serving({ liveOfferMarkets: [{ a: USDT, b: null }] })).serving).toEqual(['offer'])
  })

  it('reports the RFQ path when this process is serving the pair', () => {
    expect(marketCapability(pair(), serving({ assetRfqMarkets: [btcUsdt] })).serving).toEqual(['rfq'])
  })

  it('reports both when both paths fill it', () => {
    const rt = serving({ liveOfferMarkets: [{ a: null, b: USDT }], assetRfqMarkets: [btcUsdt] })
    expect(marketCapability(pair(), rt).serving).toEqual(['offer', 'rfq'])
  })

  it('does not match a DIFFERENT asset', () => {
    const rt = serving({ liveOfferMarkets: [{ a: null, b: OTHER }], assetRfqMarkets: [{ base: null, quote: OTHER }] })
    expect(marketCapability(pair(), rt).serving).toEqual([])
  })

  it('never matches on the BTC leg alone, which every market shares', () => {
    expect(marketCapability(pair({ quote: OTHER }), serving({ assetRfqMarkets: [btcUsdt] })).serving).toEqual([])
  })

  it('keeps what fills a DISABLED row, which is the second axis beside the flags', () => {
    expect(marketCapability(pair({ enabled: false }), serving({ assetRfqMarkets: [btcUsdt] })).serving).toEqual(['rfq'])
  })
})

describe('marketCapability — gaps between the row and the process', () => {
  it('names an offer declaration on a process that never built the path', () => {
    const { gaps } = marketCapability(pair({ servesOffer: true }), serving())
    expect(gaps.map((g) => g.kind)).toEqual(['offer_path_not_built'])
    expect(gaps[0]!.detail).toMatch(/restart/i)
  })

  it('says nothing about an offer declaration once the path exists', () => {
    const rt = serving({ assetOffers: {}, liveOfferMarkets: [{ a: null, b: USDT }] })
    const { serving: paths, gaps } = marketCapability(pair({ servesOffer: true }), rt)
    expect(paths).toEqual(['offer'])
    expect(gaps).toEqual([])
  })

  it('names an RFQ declaration the serve list dropped, and why', () => {
    const bothLegs = pair({ servesRfq: true, base: USDT, quote: OTHER })
    expect(marketCapability(bothLegs, serving()).gaps[0]!.kind).toBe('rfq_pair_unsupported')
    const closed = pair({ servesRfq: true, rfqSellBase: false, rfqBuyBase: false })
    expect(marketCapability(closed, serving()).gaps[0]!.kind).toBe('rfq_both_directions_closed')
  })

  it('is quiet about an RFQ row whose shape the covenant supports, so a gap means something', () => {
    expect(marketCapability(pair({ servesRfq: true }), serving()).gaps).toEqual([])
  })

  it('is quiet about a DISABLED row, which is serving nothing on purpose', () => {
    expect(marketCapability(pair({ enabled: false, servesOffer: true }), serving()).gaps).toEqual([])
    const closed = pair({ enabled: false, servesRfq: true, rfqSellBase: false, rfqBuyBase: false })
    expect(marketCapability(closed, serving()).gaps).toEqual([])
  })
})

const market = (over: Record<string, unknown> = {}) => ({
  marketKey: KEY,
  base: null,
  quote: USDT,
  baseDecimals: 8,
  quoteDecimals: 6,
  feedUrl: 'https://feed.test/price',
  pricePath: '/price',
  toleranceBps: 50,
  feeBps: 10,
  sellBaseFeeFlat: 330n,
  buyBaseFeeFlat: 1_000_000n,
  sellBase: null,
  buyBase: null,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const marketsApp = (policy: Record<string, unknown>, rows: unknown[] = [market()]) =>
  buildAdminApp({
    services: {
      policy: { offerMarkets: [], assetRfqTokens: [], ...policy },
      assetMarkets: [],
      liveOfferMarkets: policy.liveOfferMarkets ?? [],
      assetRfqMarkets: policy.assetRfqMarkets ?? [],
      adminStore: { listMarkets: vi.fn().mockResolvedValue(rows) },
    } as never,
    startedAt: 1,
    mode: 'relay',
    fetchPrice: vi.fn(),
  })

const listMarkets = async (policy: Record<string, unknown>, rows?: unknown[]) => {
  const response = await marketsApp(policy, rows).fetch(new Request('http://admin/api/markets'))
  expect(response.status).toBe(200)
  return (await response.json()) as { markets: { marketKey: string; enabled: boolean; serving: string[] }[] }
}

describe('GET /api/markets — what fills a market', () => {
  it('reports an enabled market that no path fills', async () => {
    const body = await listMarkets({})
    expect(body.markets[0]).toMatchObject({ enabled: true, serving: [] })
  })

  it('keeps what fills a market independent of the market’s own enabled state', async () => {
    const body = await listMarkets({ liveOfferMarkets: [{ a: null, b: USDT }] }, [market({ enabled: false })])
    expect(body.markets[0]).toMatchObject({ enabled: false, serving: ['offer'] })
  })

  it('does not report offer for an OFFER_MARKETS pair this process is not pricing', async () => {
    const body = await listMarkets({ offerMarkets: [{ a: null, b: USDT }] })
    expect(body.markets[0]?.serving).toEqual([])
  })

  it('reports both paths when both fill the pair', async () => {
    const body = await listMarkets({ liveOfferMarkets: [{ a: null, b: USDT }], assetRfqMarkets: [btcUsdt] })
    expect(body.markets[0]?.serving).toEqual(['offer', 'rfq'])
  })
})

const settingsConfig = (over: Record<string, unknown> = {}) =>
  ({
    network: 'regtest',
    lnBackend: 'fake',
    lnReceiveAcceptUnilateralGap: false,
    swapDbPath: '.data/swaps.sqlite',
    sweepConcurrency: 8,
    relayUrl: null,
    relayProtocol: 'nostr',
    openRfqMaxBidsPerMinute: 30,
    emulatorUrl: 'http://emulator.test',
    arkade: { arkServerUrl: 'http://ark.test', databasePath: '.data/ark.sqlite' },
    maxExposedSats: 300_000,
    lockupTimeoutSeconds: 600,
    sendHintScidDenylist: new Set<string>(),
    offerMarkets: [],
    assetRfqTokens: [],
    corridorLimits: {
      'arkade:BTC->lightning:BTC': { minSats: 1, maxSats: 2 },
      'lightning:BTC->arkade:BTC': { minSats: 1, maxSats: 2 },
      'arkade:BTC->onchain:BTC': { minSats: 1, maxSats: 2 },
      'onchain:BTC->arkade:BTC': { minSats: 1, maxSats: 2 },
    },
    corridorFees: {
      'arkade:BTC->lightning:BTC': { bps: 0, flatSats: 0 },
      'lightning:BTC->arkade:BTC': { bps: 0, flatSats: 0 },
      'arkade:BTC->onchain:BTC': { bps: 0, flatSats: 0 },
      'onchain:BTC->arkade:BTC': { bps: 0, flatSats: 0 },
    },
    corridorEnabled: {
      'arkade:BTC->lightning:BTC': true,
      'lightning:BTC->arkade:BTC': true,
      'arkade:BTC->onchain:BTC': true,
      'onchain:BTC->arkade:BTC': true,
    },
    ...over,
  }) as never

const knob = (over: Record<string, unknown>, key: string) =>
  describeSettings(settingsConfig(over), {}).find((row) => row.key === key)

describe('the settings page shows what decides whether a market is filled', () => {
  it('surfaces OFFER_MARKETS as this process loaded it', () => {
    expect(knob({ offerMarkets: [{ a: null, b: USDT }] }, 'OFFER_MARKETS')).toMatchObject({
      value: KEY,
      editable: false,
      source: 'env',
    })
  })

  it('surfaces ASSET_MARKETS the way the environment spells it', () => {
    expect(knob({ assetRfqTokens: [token(USDT)] }, 'ASSET_MARKETS')).toMatchObject({
      value: `USDT:${USDT}`,
      editable: false,
    })
  })

  it('says (empty) rather than omitting the row — unset is the dangerous state', () => {
    expect(knob({}, 'OFFER_MARKETS')).toMatchObject({ value: '(empty)' })
    expect(knob({}, 'ASSET_MARKETS')).toMatchObject({ value: '(empty)' })
  })

  it('does not make them editable, because no console write can reach them', () => {
    for (const key of ['OFFER_MARKETS', 'ASSET_MARKETS']) {
      expect(knob({}, key)?.editable, key).toBe(false)
    }
  })
})

const swapStore = () => ({
  findRecoverable: vi.fn().mockResolvedValue([]),
  findByStates: vi.fn().mockResolvedValue([]),
  countByStates: vi.fn().mockResolvedValue(0),
  committedSats: vi.fn().mockResolvedValue(0),
})

const overview = async (policy: Record<string, unknown>, rows: unknown[] = [market()]) => {
  const app = buildAdminApp({
    services: {
      config: settingsConfig(),
      policy: { ...(settingsConfig() as Record<string, unknown>), offerMarkets: [], assetRfqTokens: [], ...policy },
      bootPolicy: { ...(settingsConfig() as Record<string, unknown>), offerMarkets: [], assetRfqTokens: [], ...policy },
      bootOverrides: {},
      assetMarkets: [],
      liveOfferMarkets: policy.liveOfferMarkets ?? [],
      assetRfqMarkets: policy.assetRfqMarkets ?? [],
      tickErrors: { failing: [] },
      providerPubkey: 'aa'.repeat(32),
      store: swapStore(),
      receiveStore: swapStore(),
      onchainStore: swapStore(),
      onchainReceiveStore: swapStore(),
      adminStore: {
        getOverrides: vi.fn().mockResolvedValue({}),
        listMarkets: vi.fn().mockResolvedValue(rows),
        repairedServing: [],
      },
      ln: { getBalance: vi.fn().mockResolvedValue({ availableSats: 1, incomingSats: 0 }) },
      arkade: { wallet: { getBalance: vi.fn().mockResolvedValue({ total: 1 }) } },
    } as never,
    startedAt: 1,
    mode: 'relay',
  })
  const response = await app.fetch(new Request('http://admin/api/overview'))
  expect(response.status).toBe(200)
  return (await response.json()) as {
    markets: {
      key: string
      enabled: boolean
      active: boolean
      serving: string[]
      sellBaseFeeFlat: string
      buyBaseFeeFlat: string
      sellBase: { min: string; max: string } | null
      buyBase: { min: string; max: string } | null
    }[]
  }
}

describe('GET /api/overview — markets', () => {
  it('carries the configured markets, which the page showed nowhere', async () => {
    const body = await overview({})
    expect(body.markets).toHaveLength(1)
    expect(body.markets[0]).toMatchObject({ key: KEY, enabled: true })
  })

  it('reports a market that nothing fills — the state the page could not show', async () => {
    expect((await overview({})).markets[0]?.serving).toEqual([])
  })

  it('reports the paths that do fill it', async () => {
    const body = await overview({ liveOfferMarkets: [{ a: null, b: USDT }], assetRfqMarkets: [btcUsdt] })
    expect(body.markets[0]?.serving).toEqual(['offer', 'rfq'])
  })

  it('keeps the market’s own state a separate field from what fills it', async () => {
    const body = await overview({ liveOfferMarkets: [{ a: null, b: USDT }] }, [market({ enabled: false })])
    expect(body.markets[0]).toMatchObject({ enabled: false, serving: ['offer'] })
  })

  it('is empty rather than absent when no market is configured', async () => {
    expect((await overview({}, [])).markets).toEqual([])
  })

  it('sends bounds as decimal STRINGS, which is what survives JSON', async () => {
    // Bigints: `c.json` throws on one and a number loses precision past 2^53.
    const bounded = market({ sellBase: { min: 1n, max: 2n ** 70n }, buyBase: null })
    const body = await overview({}, [bounded])
    expect(body.markets[0]?.sellBase).toEqual({ min: '1', max: String(2n ** 70n) })
    expect(body.markets[0]?.buyBase).toBeNull()
  })

  it('sends directional flat fees as decimal strings', async () => {
    expect((await overview({})).markets[0]).toMatchObject({
      sellBaseFeeFlat: '330',
      buyBaseFeeFlat: '1000000',
    })
  })
})

describe('the console renders served-by', () => {
  const appSource = readFileSync(
    fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
    'utf8',
  )

  const view = (): string =>
    appSource.slice(appSource.indexOf('const marketsView'), appSource.indexOf('asset markets — END'))
  const cell = (): string =>
    appSource.slice(appSource.indexOf('const servedByCell'), appSource.indexOf('const marketsView'))

  it('gives it a column of its own rather than overloading state', () => {
    expect(view()).toContain("h('th', 'served by')")
    expect(view()).toContain('servedByCell(market.servedBy ?? [])')
    expect(view()).toContain("h('span.phase.phase-exposed', 'not quoting')")
  })

  it('puts the markets on the overview, in its own grid', () => {
    expect(appSource).toContain('marketsPanel(o)')
    const panel = appSource.slice(appSource.indexOf('const marketsPanel'), appSource.indexOf('const overviewView'))
    expect(panel).toContain("h('div.panels'")
    expect(panel).toContain('markets.map(marketCard)')
  })

  it('renders a market nothing fills as a failure on the overview card too', () => {
    const card = appSource.slice(appSource.indexOf('const marketCard'), appSource.indexOf('const marketsPanel'))
    expect(card).toContain("'span.phase.phase-failed'")
    expect(card).toContain('market.servedBy.length === 0')
  })

  it('keeps `served by` off the corridor cards’ `serving` label', () => {
    const card = appSource.slice(appSource.indexOf('const marketCard'), appSource.indexOf('const marketsPanel'))
    expect(card).toContain("h('dt', 'served by')")
    expect(card).toContain("h('dt', 'state')")
    expect(card).not.toContain("h('dt', 'serving')")
  })

  it('prints bounds as base units with decimals as a label, never scaled', () => {
    const bounds = appSource.slice(appSource.indexOf('const marketBounds'), appSource.indexOf('const marketState'))
    expect(bounds).toContain('bounds.min')
    expect(bounds).toContain('dp)')
    expect(bounds).not.toMatch(/10\s*\*\*|Math\.pow/)
  })

  it('marks "nothing" distinctly, on the failure chip', () => {
    expect(cell()).toContain("'span.phase.phase-failed'")
    expect(cell()).toContain("'nothing'")
    expect(cell()).toContain('OFFER_MARKETS')
  })
})
