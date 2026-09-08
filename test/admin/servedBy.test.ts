// Whether anything FILLS a market is decided by two env vars the console never
// rendered. One was configured, listed `trading`, offered against — and the
// solver detected nothing, because the answer was in `OFFER_MARKETS`.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { servedBy } from '@arkade-os/solver-app/admin/servedBy.js'
import { describeSettings } from '@arkade-os/solver-app/admin/settings.js'
import { assetMarketKey } from '@arkade-os/solver-core/core/assetMarketConfig.js'

const USDT = 'aa'.repeat(34)
const OTHER = 'bb'.repeat(34)
const KEY = assetMarketKey(null, USDT)

const btcUsdt = { base: null, quote: USDT }
const token = (assetId: string) => ({ symbol: 'USDT', assetId, enabled: { sell_base: true, buy_base: true } })

const boot = (over: Record<string, unknown> = {}) => ({ offerMarkets: [], assetRfqTokens: [], ...over }) as never

describe('servedBy', () => {
  it('reports NOTHING when neither variable names the pair', () => {
    expect(servedBy(btcUsdt, boot())).toEqual([])
  })

  it('reports the offer path when OFFER_MARKETS names the pair', () => {
    expect(servedBy(btcUsdt, boot({ offerMarkets: [{ a: null, b: USDT }] }))).toEqual(['offer'])
  })

  it('matches OFFER_MARKETS with the legs the other way round', () => {
    expect(servedBy(btcUsdt, boot({ offerMarkets: [{ a: USDT, b: null }] }))).toEqual(['offer'])
  })

  it('reports the RFQ path when ASSET_MARKETS names one of the legs', () => {
    expect(servedBy(btcUsdt, boot({ assetRfqTokens: [token(USDT)] }))).toEqual(['rfq'])
  })

  it('reports both when both name it', () => {
    const served = servedBy(btcUsdt, boot({ offerMarkets: [{ a: null, b: USDT }], assetRfqTokens: [token(USDT)] }))
    expect(served).toEqual(['offer', 'rfq'])
  })

  it('does not match a DIFFERENT asset', () => {
    const served = servedBy(btcUsdt, boot({ offerMarkets: [{ a: null, b: OTHER }], assetRfqTokens: [token(OTHER)] }))
    expect(served).toEqual([])
  })

  it('never matches on the BTC leg alone, which every market shares', () => {
    expect(servedBy({ base: null, quote: OTHER }, boot({ assetRfqTokens: [token(USDT)] }))).toEqual([])
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
      adminStore: { listMarkets: vi.fn().mockResolvedValue(rows) },
    } as never,
    startedAt: 1,
    mode: 'relay',
    fetchPrice: vi.fn(),
  })

const listMarkets = async (policy: Record<string, unknown>, rows?: unknown[]) => {
  const response = await marketsApp(policy, rows).fetch(new Request('http://admin/api/markets'))
  expect(response.status).toBe(200)
  return (await response.json()) as { markets: { marketKey: string; enabled: boolean; servedBy: string[] }[] }
}

describe('GET /api/markets — served by', () => {
  it('reports an enabled market that no path fills', async () => {
    const body = await listMarkets({})
    expect(body.markets[0]).toMatchObject({ enabled: true, servedBy: [] })
  })

  it('keeps served-by independent of the market’s own enabled state', async () => {
    const body = await listMarkets({ offerMarkets: [{ a: null, b: USDT }] }, [market({ enabled: false })])
    expect(body.markets[0]).toMatchObject({ enabled: false, servedBy: ['offer'] })
  })

  it('reports both paths when both variables name the pair', async () => {
    const body = await listMarkets({ offerMarkets: [{ a: null, b: USDT }], assetRfqTokens: [token(USDT)] })
    expect(body.markets[0]?.servedBy).toEqual(['offer', 'rfq'])
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
      bootOverrides: {},
      assetMarkets: [],
      tickErrors: { failing: [] },
      providerPubkey: 'aa'.repeat(32),
      store: swapStore(),
      receiveStore: swapStore(),
      onchainStore: swapStore(),
      onchainReceiveStore: swapStore(),
      adminStore: {
        getOverrides: vi.fn().mockResolvedValue({}),
        listMarkets: vi.fn().mockResolvedValue(rows),
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
      servedBy: string[]
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
    expect((await overview({})).markets[0]?.servedBy).toEqual([])
  })

  it('reports the paths that do fill it', async () => {
    const body = await overview({ offerMarkets: [{ a: null, b: USDT }], assetRfqTokens: [token(USDT)] })
    expect(body.markets[0]?.servedBy).toEqual(['offer', 'rfq'])
  })

  it('keeps the market’s own state a separate field from served-by', async () => {
    const body = await overview({ offerMarkets: [{ a: null, b: USDT }] }, [market({ enabled: false })])
    expect(body.markets[0]).toMatchObject({ enabled: false, servedBy: ['offer'] })
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
    expect(view()).toContain("h('span.phase.phase-exposed', 'pending restart')")
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
