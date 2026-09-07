// `pendingRestartKeys` diffs the override MAP and a market is a row, so one added
// in the console got silence. `names a market added since boot` is the test that
// has to fail without `marketDrift`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { marketDrift, settingsDrift } from '@arkade-os/solver-app/admin/drift.js'
import { pendingRestartKeys } from '@arkade-os/solver-app/admin/settings.js'
import { ACTIONS } from '@arkade-os/solver-app/admin/routes/actions.js'
import { assetMarketKey } from '@arkade-os/solver-core/core/assetMarketConfig.js'

const USDT = 'aa'.repeat(34)
const KEY = assetMarketKey(null, USDT)

const baseConfig = {
  network: 'regtest',
  lnBackend: 'fake',
  emulatorUrl: 'http://emulator.test',
  arkade: { arkServerUrl: 'http://ark.test' },
  maxExposedSats: 300_000,
  lockupTimeoutSeconds: 600,
  limits: { minSats: 1_000, maxSats: 100_000 },
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
  adminRestartEnabled: true,
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

/** Boot snapshots and store default to agreeing, so a pending change is opt-in. */
const services = (over: Record<string, unknown> = {}) =>
  ({
    config: config(),
    policy: config(),
    bootOverrides: {},
    assetMarkets: [],
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
  return (await response.json()) as { pendingRestart: { key: string; loaded: string; stored: string }[] }
}

describe('marketDrift — the case the override diff cannot see', () => {
  it('is empty when the stored rows are the ones this process loaded', () => {
    expect(marketDrift([market()] as never, [market()] as never)).toEqual([])
  })

  it('names a market added since boot', () => {
    expect(marketDrift([], [market()] as never)).toEqual([
      { key: `market ${KEY}`, loaded: 'not trading', stored: 'trading' },
    ])
  })

  it('names a re-priced market rather than reading it as untouched', () => {
    expect(marketDrift([market()] as never, [market({ feeBps: 40 })] as never)).toEqual([
      { key: `market ${KEY}`, loaded: 'as booted', stored: 'edited' },
    ])
  })

  it('names a market this process trades and the store no longer has', () => {
    expect(marketDrift([market()] as never, [])).toEqual([
      { key: `market ${KEY}`, loaded: 'trading', stored: 'not trading' },
    ])
  })

  it('treats a paused market as leaving, because the next process will not trade it either', () => {
    expect(marketDrift([market()] as never, [market({ enabled: false })] as never)).toEqual([
      { key: `market ${KEY}`, loaded: 'trading', stored: 'not trading' },
    ])
  })

  it('compares the bounds, whose atomic units are bigints', () => {
    const bounded = market({ sellBase: { min: 1n, max: 2n } })
    expect(marketDrift([bounded] as never, [bounded] as never)).toEqual([])
    expect(marketDrift([bounded] as never, [market({ sellBase: { min: 1n, max: 3n } })] as never)).toHaveLength(1)
  })

  it('survives a stored row that has gone bad, because the overview must still render', () => {
    expect(() => marketDrift([], [market({ toleranceBps: -1 })] as never)).not.toThrow()
  })
})

describe('settingsDrift — the values behind the keys', () => {
  it('says what a knob moves from and to', () => {
    const stored = config({
      corridorFees: { ...baseConfig.corridorFees, 'arkade:BTC->lightning:BTC': { bps: 25, flatSats: 0 } },
    })
    expect(settingsDrift(config(), stored, ['LN_SEND_FEE_BPS'])).toEqual([
      { key: 'LN_SEND_FEE_BPS', loaded: '0', stored: '25' },
    ])
  })

  it('reads a corridor toggle as the words the settings page shows', () => {
    const stored = config({ corridorEnabled: { ...baseConfig.corridorEnabled, 'arkade:BTC->onchain:BTC': false } })
    expect(settingsDrift(config(), stored, ['ONCHAIN_SEND_ENABLED'])).toEqual([
      { key: 'ONCHAIN_SEND_ENABLED', loaded: 'true', stored: 'false' },
    ])
  })

  it('drops a key whose effective value did not move', () => {
    // `pendingRestartKeys` reports one equal to the env's own value; `25 -> 25`.
    expect(settingsDrift(config(), config(), pendingRestartKeys({}, { LN_SEND_FEE_BPS: '0' }))).toEqual([])
  })
})

describe('GET /api/overview — pendingRestart', () => {
  it('is empty when the store holds what this process booted with', async () => {
    expect((await overview()).pendingRestart).toEqual([])
  })

  it('names a market added since boot — the scenario the shipped alert stayed silent for', async () => {
    const body = await overview({
      adminStore: {
        getOverrides: vi.fn().mockResolvedValue({}),
        listMarkets: vi.fn().mockResolvedValue([market()]),
      },
    })
    expect(body.pendingRestart).toEqual([{ key: `market ${KEY}`, loaded: 'not trading', stored: 'trading' }])
  })

  it('carries an override with both of its values, not the bare key', async () => {
    const body = await overview({
      adminStore: {
        getOverrides: vi.fn().mockResolvedValue({ LN_SEND_FEE_BPS: '25' }),
        listMarkets: vi.fn().mockResolvedValue([]),
      },
    })
    expect(body.pendingRestart).toEqual([{ key: 'LN_SEND_FEE_BPS', loaded: '0', stored: '25' }])
  })

  it('reports a knob and a market together, from one banner', async () => {
    const body = await overview({
      adminStore: {
        getOverrides: vi.fn().mockResolvedValue({ MAX_EXPOSED_SATS: '900000' }),
        listMarkets: vi.fn().mockResolvedValue([market()]),
      },
    })
    expect(body.pendingRestart).toHaveLength(2)
    expect(body.pendingRestart.map((item) => item.key)).toEqual(['MAX_EXPOSED_SATS', `market ${KEY}`])
  })

  it('stays quiet when the override is the one this process already loaded', async () => {
    const body = await overview({
      bootOverrides: { LN_SEND_FEE_BPS: '25' },
      policy: config({
        corridorFees: { ...baseConfig.corridorFees, 'arkade:BTC->lightning:BTC': { bps: 25, flatSats: 0 } },
      }),
      adminStore: {
        getOverrides: vi.fn().mockResolvedValue({ LN_SEND_FEE_BPS: '25' }),
        listMarkets: vi.fn().mockResolvedValue([]),
      },
    })
    expect(body.pendingRestart).toEqual([])
  })
})

const corridorReader = (committedSats = 0, live: unknown[] = []) => ({
  committedSats: vi.fn().mockResolvedValue(committedSats),
  findRecoverable: vi.fn().mockResolvedValue(live),
})

const readerSet = (corridors: unknown[]) => ({
  get: () => undefined,
  size: corridors.length,
  [Symbol.iterator]: () => corridors[Symbol.iterator](),
})

const actionServices = (over: Record<string, unknown> = {}) => ({
  adminStore: {
    recordAction: vi.fn().mockResolvedValue(undefined),
    listActions: vi.fn().mockResolvedValue([]),
    getOverrides: vi.fn().mockResolvedValue({}),
  },
  config: { adminRestartEnabled: true },
  readers: readerSet([corridorReader(50_151, [{ id: 'a' }, { id: 'b' }])]),
  ...over,
})

const restart = (body: unknown, svc: ReturnType<typeof actionServices> = actionServices()) =>
  buildAdminApp({ services: svc as never, startedAt: 1, mode: 'relay' }).fetch(
    new Request('http://admin/api/actions/restart-solver', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

describe('POST /api/actions/restart-solver — what it interrupts', () => {
  // These drive `run`, which reaches `requestRestart`'s real defaults and
  // SIGTERMs the vitest worker 250ms later — the run dies as
  // ERR_IPC_CHANNEL_CLOSED with no failing test to point at.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    vi.spyOn(process, 'kill').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('still refuses without the typed confirmation', async () => {
    const svc = actionServices()
    expect((await restart({}, svc)).status).toBe(400)
    expect(svc.adminStore.recordAction).not.toHaveBeenCalled()
  })

  it('records the exposure the restart was taken with', async () => {
    const svc = actionServices()
    expect((await restart({ confirm: 'RESTART' }, svc)).status).toBe(200)
    const { detail } = svc.adminStore.recordAction.mock.calls[0]![0] as { detail: string }
    // "who restarted a solver holding 50,151 sats" has to be answerable later.
    expect(JSON.parse(detail)).toMatchObject({ inFlight: { committedSats: 50_151, liveCount: 2 } })
  })

  it('counts every corridor the registry serves, not the four BTC pairs', async () => {
    const evm = corridorReader(7, [{ id: 'c' }])
    const svc = actionServices({ readers: readerSet([corridorReader(3, []), evm]) })
    await restart({ confirm: 'RESTART' }, svc)
    expect(evm.committedSats).toHaveBeenCalled()
    const { detail } = svc.adminStore.recordAction.mock.calls[0]![0] as { detail: string }
    expect(JSON.parse(detail)).toMatchObject({ inFlight: { committedSats: 10, liveCount: 1 } })
  })

  it('still restarts when a store cannot be read, reporting that instead of the numbers', async () => {
    const svc = actionServices({
      readers: readerSet([
        {
          committedSats: vi.fn().mockRejectedValue(new Error('database is locked')),
          findRecoverable: vi.fn().mockResolvedValue([]),
        },
      ]),
    })
    expect((await restart({ confirm: 'RESTART' }, svc)).status).toBe(200)
    const { detail } = svc.adminStore.recordAction.mock.calls[0]![0] as { detail: string }
    expect(JSON.parse(detail)).toMatchObject({ inFlight: { unreadable: 'database is locked' } })
  })

  it('is still refused, and audited, on a deployment with no supervisor declared', async () => {
    const svc = actionServices({ config: { adminRestartEnabled: false } })
    expect((await restart({ confirm: 'RESTART' }, svc)).status).toBe(500)
    expect(svc.adminStore.recordAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'restart-solver', outcome: 'error' }),
    )
  })

  it('leaves the action armed', () => {
    expect(ACTIONS['restart-solver']?.tier).toBe('armed')
  })
})

/** Serving them on `/api/overview` is not the fix: an operator reads the console. */
describe('the console renders it', () => {
  const appSource = readFileSync(
    fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
    'utf8',
  )

  const banner = (): string => {
    const start = appSource.indexOf('const restartBanner')
    if (start === -1) throw new Error('restartBanner is gone')
    return appSource.slice(start, appSource.indexOf('const render =', start))
  }

  it('renders each item as a from-and-to rather than a bare key', () => {
    expect(banner()).toContain('pendingItem(item)')
    const item = appSource.slice(appSource.indexOf('const pendingItem'), appSource.indexOf('// On EVERY panel'))
    expect(item).toContain('item.loaded')
    expect(item).toContain('item.stored')
    // `join(', ')` on objects would render "[object Object]" everywhere.
    expect(banner()).not.toContain("pending.join(', ')")
  })

  it('still renders above every panel, not only the overview', () => {
    expect(appSource).toContain('const pendingBanner = restartBanner()')
    expect(appSource).toContain('root.appendChild(pendingBanner)')
  })

  it('puts what is in flight in front of the operator before they confirm', () => {
    expect(banner()).toContain("armDialog('restart-solver', {}, inFlightLine(o))")
    const line = appSource.slice(appSource.indexOf('const inFlightLine'), appSource.indexOf('const pendingItem'))
    expect(line).toContain('o.exposure.committedSats')
    expect(line).toContain('o.exposure.exposedCount')
    expect(line).toContain('stuckCount')
  })
})
