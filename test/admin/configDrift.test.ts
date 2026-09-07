/**
 * The staleness alert: stored configuration versus what the process loaded.
 *
 * Settings and markets are startup-only by settled decision, and until now the
 * only thing saying so was prose on two tabs. An operator could edit a market,
 * see it listed as trading, and be filling against something else — the failure
 * this alert exists to make visible, so the tests that matter most are the two
 * opposite ones: it appears when the two snapshots differ, and it is ABSENT when
 * they agree. A banner that is always up is a banner nobody reads.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { marketDrift, settingsDrift } from '@arkade-os/solver-app/admin/drift.js'
import { assetMarketKey } from '@arkade-os/solver-core/core/assetMarketConfig.js'

const USDT = 'aa'.repeat(34)
const KEY = assetMarketKey(null, USDT)

const baseConfig = {
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
  limits: { minSats: 1_000, maxSats: 100_000 },
  maxExposedSats: 300_000,
  lockupTimeoutSeconds: 600,
  sendHintScidDenylist: new Set<string>(),
  corridorLimits: {
    'arkade:BTC->lightning:BTC': { minSats: 1_000, maxSats: 100_000 },
    'lightning:BTC->arkade:BTC': { minSats: 1_000, maxSats: 100_000 },
    'arkade:BTC->onchain:BTC': { minSats: 1_000, maxSats: 100_000 },
    'onchain:BTC->arkade:BTC': { minSats: 1_000, maxSats: 100_000 },
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
}

const config = (over: Record<string, unknown> = {}) => ({ ...structuredClone(baseConfig), ...over }) as never

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
  ...over,
})

const store = () => ({
  findRecoverable: vi.fn().mockResolvedValue([]),
  findByStates: vi.fn().mockResolvedValue([]),
  countByStates: vi.fn().mockResolvedValue(0),
  committedSats: vi.fn().mockResolvedValue(0),
})

/**
 * `policy` is the BOOT snapshot and `getOverrides()` is what the store holds
 * now, which is exactly the pair the alert diffs. Defaulting them to the same
 * values is what makes the quiet case the default.
 */
const services = (over: Record<string, unknown> = {}) =>
  ({
    config: config(),
    policy: config(),
    assetMarkets: [],
    restart: { refusal: null },
    tickErrors: { failing: [] },
    providerPubkey: 'aa'.repeat(32),
    store: store(),
    receiveStore: store(),
    onchainStore: store(),
    onchainReceiveStore: store(),
    adminStore: {
      getOverrides: vi.fn().mockResolvedValue({}),
      listMarkets: vi.fn().mockResolvedValue([]),
    },
    ln: { getBalance: vi.fn().mockResolvedValue({ availableSats: 1, incomingSats: 0 }) },
    arkade: { wallet: { getBalance: vi.fn().mockResolvedValue({ total: 1 }) } },
    ...over,
  }) as never

const overview = async (over: Record<string, unknown> = {}) => {
  const app = buildAdminApp({ services: services(over), startedAt: 1, mode: 'relay' })
  const response = await app.fetch(new Request('http://admin/api/overview'))
  expect(response.status).toBe(200)
  return (await response.json()) as {
    restart: {
      pending: boolean
      settings: { key: string; loaded: string; stored: string }[]
      markets: { key: string; change: string }[]
      notice: string
      refusal: string | null
    }
  }
}

describe('settingsDrift', () => {
  it('is empty when the store holds what the process loaded', () => {
    expect(settingsDrift(config(), config())).toEqual([])
  })

  it('names the knob, what is running, and what is stored', () => {
    const stored = config({
      corridorFees: { ...baseConfig.corridorFees, 'arkade:BTC->lightning:BTC': { bps: 25, flatSats: 0 } },
    })
    expect(settingsDrift(config(), stored)).toEqual([{ key: 'LN_SEND_FEE_BPS', loaded: '0', stored: '25' }])
  })

  it('reports a knob that has no corridor of its own', () => {
    expect(settingsDrift(config(), config({ maxExposedSats: 900_000 }))).toEqual([
      { key: 'MAX_EXPOSED_SATS', loaded: '300000', stored: '900000' },
    ])
  })

  it('reports a corridor switched off since boot', () => {
    const stored = config({ corridorEnabled: { ...baseConfig.corridorEnabled, 'arkade:BTC->onchain:BTC': false } })
    expect(settingsDrift(config(), stored)).toEqual([{ key: 'ONCHAIN_SEND_ENABLED', loaded: 'true', stored: 'false' }])
  })

  it('ignores the read-only rows, which cannot move without a restart having happened', () => {
    // `ARK_SERVER_URL` and its neighbours come from the environment on both
    // sides. Reporting one would mean claiming a restart is pending for a value
    // no console write can reach.
    const drift = settingsDrift(config(), config({ emulatorUrl: 'http://elsewhere.test' }))
    expect(drift).toEqual([])
  })
})

describe('marketDrift', () => {
  it('is empty when the stored rows are the ones this process loaded', () => {
    expect(marketDrift([market()] as never, [market()] as never)).toEqual([])
  })

  it('reports a market added since boot — the case the markets tab warns about in prose', () => {
    expect(marketDrift([], [market()] as never)).toEqual([{ key: KEY, change: 'added' }])
  })

  it('reports a re-priced market as changed, not as untouched', () => {
    expect(marketDrift([market()] as never, [market({ feeBps: 40 })] as never)).toEqual([
      { key: KEY, change: 'changed' },
    ])
  })

  it('reports a market this process is trading and the store no longer has', () => {
    expect(marketDrift([market()] as never, [])).toEqual([{ key: KEY, change: 'removed' }])
  })

  it('treats a paused market as removed, because the next process will not trade it either', () => {
    expect(marketDrift([market()] as never, [market({ enabled: false })] as never)).toEqual([
      { key: KEY, change: 'removed' },
    ])
  })

  it('survives a stored row that has gone bad, because the overview must still render', () => {
    // `assetMarketPolicy` throws on one of these; this must not, or the first
    // page an operator loads goes dark exactly when something is wrong.
    expect(() => marketDrift([], [market({ toleranceBps: -1 })] as never)).not.toThrow()
  })

  it('compares the bounds too, whose atomic units are bigints', () => {
    const bounded = market({ sellBase: { min: 1n, max: 2n } })
    expect(marketDrift([bounded] as never, [bounded] as never)).toEqual([])
    expect(marketDrift([bounded] as never, [market({ sellBase: { min: 1n, max: 3n } })] as never)).toEqual([
      { key: KEY, change: 'changed' },
    ])
  })
})

describe('GET /api/overview — the restart alert', () => {
  it('is absent when stored configuration matches what the process loaded', async () => {
    const body = await overview()
    expect(body.restart.pending).toBe(false)
    expect(body.restart.settings).toEqual([])
    expect(body.restart.markets).toEqual([])
  })

  it('appears, naming the knob, when an override was stored after boot', async () => {
    const body = await overview({
      adminStore: {
        getOverrides: vi.fn().mockResolvedValue({ LN_SEND_FEE_BPS: '25' }),
        listMarkets: vi.fn().mockResolvedValue([]),
      },
    })
    expect(body.restart.pending).toBe(true)
    expect(body.restart.settings).toEqual([{ key: 'LN_SEND_FEE_BPS', loaded: '0', stored: '25' }])
  })

  it('stays quiet when the override is the one this process already loaded', async () => {
    // The gap that made a generic "you have overrides" badge useless: every
    // stored override was reported as pending, including the ones the running
    // process was built from, so the badge was permanently on.
    const loaded = config({
      corridorFees: { ...baseConfig.corridorFees, 'arkade:BTC->lightning:BTC': { bps: 25, flatSats: 0 } },
    })
    const body = await overview({
      policy: loaded,
      adminStore: {
        getOverrides: vi.fn().mockResolvedValue({ LN_SEND_FEE_BPS: '25' }),
        listMarkets: vi.fn().mockResolvedValue([]),
      },
    })
    expect(body.restart.pending).toBe(false)
    expect(body.restart.settings).toEqual([])
  })

  it('appears, naming the pair, when a market was added after boot', async () => {
    const body = await overview({
      adminStore: {
        getOverrides: vi.fn().mockResolvedValue({}),
        listMarkets: vi.fn().mockResolvedValue([market()]),
      },
    })
    expect(body.restart.pending).toBe(true)
    expect(body.restart.markets).toEqual([{ key: KEY, change: 'added' }])
  })

  it('says why the change is not live rather than leaving the reader to infer it', async () => {
    const body = await overview()
    expect(body.restart.notice).toMatch(/nothing re-reads them/i)
  })

  it('carries the reason a restart cannot be taken from here, when there is one', async () => {
    const body = await overview({ restart: { refusal: 'no supervisor was declared' } })
    expect(body.restart.refusal).toBe('no supervisor was declared')
  })
})

/**
 * The overview must SHOW the drift, not merely serve it.
 *
 * `/api/overview` carrying `restart` is not the fix on its own: an operator reads
 * the console, not the JSON. Shipping the field and stopping there would leave a
 * staleness alert nobody can see — the exact failure it exists to prevent, and
 * the one `armedActions.test.ts` records for the stuck-row panel.
 *
 * `app.js` is a browser module with no exports and no DOM here, so this reads the
 * source the way that file does, and for the same reason.
 */
describe('the console renders the alert', () => {
  const appSource = readFileSync(
    fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
    'utf8',
  )

  const panel = (): string => {
    const start = appSource.indexOf('const restartPanel')
    if (start === -1) throw new Error('restartPanel is gone')
    return appSource.slice(start, appSource.indexOf('const overviewView', start))
  }

  it('puts the panel on the overview', () => {
    expect(appSource).toContain('restartPanel(o)')
  })

  it('names the items rather than showing a generic banner', () => {
    // The whole reason the API sends lists instead of a boolean: "restart
    // needed" with nothing said about WHAT is a notice an operator dismisses.
    expect(panel()).toContain('r.settings.map')
    expect(panel()).toContain('r.markets.map')
    expect(panel()).toContain('knob.loaded')
    expect(panel()).toContain('knob.stored')
  })

  it('shows the alert only when something actually drifted', () => {
    // A position that always carries a warning is one the eye learns to skip,
    // and this is the position that has to be noticed.
    expect(panel()).toMatch(/r\.pending\s*\?/)
  })
})
