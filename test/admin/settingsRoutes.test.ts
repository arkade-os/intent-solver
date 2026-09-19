import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { AssetRfqSwapService } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import { assetRfqMarketsFrom } from '@arkade-os/solver-app/ops/assetRfqMarkets.js'
import {
  assetMarketPolicy,
  DEFAULT_SERVING,
  type AssetMarketConfig,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { createServicesBody } from '../support/createServicesBody.js'

const baseConfig = {
  network: 'regtest',
  lnBackend: 'fake',
  swapDbPath: '.data/swaps.sqlite',
  sweepConcurrency: 8,
  relayUrl: null,
  relayProtocol: 'nostr',
  openRfqMaxBidsPerMinute: 30,
  emulatorUrl: 'http://emulator.test',
  arkade: { arkServerUrl: 'http://ark.test', databasePath: '.data/ark.sqlite' },
  limits: { minSats: 1_000, maxSats: 100_000 },
  maxExposedSats: 300_000,
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
    'arkade:BTC->onchain:BTC': false,
    'onchain:BTC->arkade:BTC': true,
  },
  // Rendered in the read-only block, which iterates it.
  sendHintScidDenylist: new Set<string>(),
  // The two variables deciding whether a configured market is filled by
  // anything; the read-only block renders both. @see admin/marketCapability.ts
  offerMarkets: [],
  assetRfqTokens: [],
  assetCarrierPricing: false,
  offerChargesDeliveredCarrier: false,
}

const build = (overrides: Record<string, string> = {}, over: Record<string, unknown> = {}) => {
  const stored: Record<string, string> = { ...overrides }
  const setOverrideWithAudit = vi.fn(async (key: string, value: string | null) => {
    if (value === null) delete stored[key]
    else stored[key] = value
  })
  const services = {
    config: structuredClone(baseConfig),
    policy: structuredClone(baseConfig),
    bootPolicy: structuredClone(baseConfig),
    bootOverrides: {},
    replacePolicy: vi.fn(),
    adminStore: { getOverrides: vi.fn(async () => ({ ...stored })), setOverrideWithAudit },
    ...over,
  } as never
  return { app: buildAdminApp({ services, startedAt: 1, mode: 'relay' }), setOverrideWithAudit }
}

const patch = (app: ReturnType<typeof buildAdminApp>, body: unknown) =>
  app.fetch(
    new Request('http://admin/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const buildReal = async () => {
  const driver = betterSqliteDriver(':memory:')
  const adminStore = await AdminStore.open(driver, () => 1_000_000)
  const services = {
    config: structuredClone(baseConfig),
    policy: structuredClone(baseConfig),
    bootPolicy: structuredClone(baseConfig),
    bootOverrides: {},
    replacePolicy: vi.fn(),
    adminStore,
  } as never
  return { app: buildAdminApp({ services, startedAt: 1, mode: 'relay' }), adminStore, driver, services }
}

const rejectAuditInserts = (driver: ReturnType<typeof betterSqliteDriver>) =>
  driver.exec(`
    CREATE TRIGGER reject_admin_action
    BEFORE INSERT ON admin_action
    BEGIN
      SELECT RAISE(FAIL, 'audit insert failed');
    END;
  `)

describe('GET /api/settings', () => {
  it('lists knobs with their source', async () => {
    const { app } = build({ LN_SEND_FEE_BPS: '25' })
    const body = (await (await app.fetch(new Request('http://admin/api/settings'))).json()) as {
      knobs: { key: string; source: string; value: unknown }[]
      pendingRestart: string[]
    }
    expect(body.knobs.find((k) => k.key === 'LN_SEND_FEE_BPS')).toMatchObject({ value: 25, source: 'override' })
    expect(body.pendingRestart).toContain('LN_SEND_FEE_BPS')
  })

  it('exposes no secrets', async () => {
    const { app } = build()
    const text = await (await app.fetch(new Request('http://admin/api/settings'))).text()
    expect(text).not.toContain('MNEMONIC')
  })

  it('does not tell the operator that stored means pending', async () => {
    const { app } = build()
    const body = (await (await app.fetch(new Request('http://admin/api/settings'))).json()) as {
      restartNotice: string
    }
    expect(body.restartNotice).not.toMatch(/^Stored\. It takes effect when the solver restarts/)
    expect(body.restartNotice).toMatch(/badged pending/i)
  })
})

describe('GET /api/settings — what is actually pending', () => {
  const read = async (overrides: Record<string, string>, over: Record<string, unknown> = {}) => {
    const { app } = build(overrides, over)
    return (await (await app.fetch(new Request('http://admin/api/settings'))).json()) as {
      knobs: { key: string; pending?: boolean; restartRequired?: boolean }[]
      pendingRestart: string[]
    }
  }

  it('omits an override this process already booted with', async () => {
    const policy = structuredClone(baseConfig)
    policy.corridorFees['arkade:BTC->lightning:BTC'] = { bps: 25, flatSats: 0 }
    const body = await read(
      { LN_SEND_FEE_BPS: '25' },
      { policy, bootPolicy: policy, bootOverrides: { LN_SEND_FEE_BPS: '25' } },
    )

    expect(body.pendingRestart).toEqual([])
    expect(body.knobs.find((k) => k.key === 'LN_SEND_FEE_BPS')?.pending).toBeUndefined()
  })

  it('reports an override stored since boot, and still calls the knob restart-required', async () => {
    const body = await read({ LN_SEND_FEE_BPS: '25' })

    expect(body.pendingRestart).toEqual(['LN_SEND_FEE_BPS'])
    const knob = body.knobs.find((k) => k.key === 'LN_SEND_FEE_BPS')
    expect(knob?.pending).toBe(true)
    // Unchanged: no seam reaches a corridor fee, whatever LIVE_KEYS now holds.
    expect(knob?.restartRequired).toBe(true)
  })
})

describe('PATCH /api/settings', () => {
  it('persists a narrowing override', async () => {
    const { app, setOverrideWithAudit } = build()
    const response = await patch(app, { key: 'LN_SEND_MAX_SATS', value: '50000' })
    expect(response.status).toBe(200)
    expect(setOverrideWithAudit).toHaveBeenCalledWith('LN_SEND_MAX_SATS', '50000', {
      action: 'setting-set',
      target: 'LN_SEND_MAX_SATS',
      params: '{"value":"50000"}',
      outcome: 'ok',
      detail: null,
    })
  })

  it('reports a restart is needed for a value that differs from what booted', async () => {
    const { app } = build()
    const body = await (await patch(app, { key: 'LN_SEND_MAX_SATS', value: '50000' })).json()
    expect(body).toMatchObject({ restartRequired: true })
    // The notice may only promise a restart applies the override because
    // createServices actually resolves them at startup — see
    // test/cli/overridesApplied.test.ts, which pins that wiring. This claim
    // was false once; the pairing is what stops it being false again.
    const notice = (body as { restartNotice: string }).restartNotice
    expect(notice).toMatch(/read once at startup/i)
  })

  it('reports no restart needed for a value that already matches what booted', async () => {
    const policy = structuredClone(baseConfig)
    policy.corridorLimits['arkade:BTC->lightning:BTC'] = { minSats: 1_000, maxSats: 50_000 }
    const { app } = build(
      { LN_SEND_MAX_SATS: '50000' },
      { policy, bootPolicy: policy, bootOverrides: { LN_SEND_MAX_SATS: '50000' } },
    )
    const body = await (await patch(app, { key: 'LN_SEND_MAX_SATS', value: '50000' })).json()
    expect(body).toMatchObject({ restartRequired: false })
  })

  it('persists a WIDENING value, which the narrowing guard used to refuse', async () => {
    const { app, setOverrideWithAudit } = build()
    const response = await patch(app, { key: 'LN_SEND_MAX_SATS', value: '200000' })
    expect(response.status).toBe(200)
    expect(setOverrideWithAudit).toHaveBeenCalledWith(
      'LN_SEND_MAX_SATS',
      '200000',
      expect.objectContaining({ action: 'setting-set' }),
    )
  })

  it('refuses a malformed value and PERSISTS NOTHING', async () => {
    // Validate-before-persist still holds for the rules that remain; only the
    // narrowing rule went away.
    const { app, setOverrideWithAudit } = build()
    const response = await patch(app, { key: 'LN_SEND_MAX_SATS', value: '1e5x' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'rejected' })
    expect(setOverrideWithAudit).not.toHaveBeenCalled()
  })

  it('refuses a non-editable key', async () => {
    const { app, setOverrideWithAudit } = build()
    expect((await patch(app, { key: 'ARK_MNEMONIC', value: 'hunter2' })).status).toBe(400)
    expect(setOverrideWithAudit).not.toHaveBeenCalled()
  })

  it('refuses to enable a corridor the environment disabled', async () => {
    const { app, setOverrideWithAudit } = build()
    const response = await patch(app, { key: 'ONCHAIN_SEND_ENABLED', value: 'true' })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toMatch(/disabled in the environment/i)
    expect(setOverrideWithAudit).not.toHaveBeenCalled()
  })

  it('clears an override when given null', async () => {
    const { app, setOverrideWithAudit } = build({ LN_SEND_FEE_BPS: '25' })
    expect((await patch(app, { key: 'LN_SEND_FEE_BPS', value: null })).status).toBe(200)
    expect(setOverrideWithAudit).toHaveBeenCalledWith('LN_SEND_FEE_BPS', null, {
      action: 'setting-clear',
      target: 'LN_SEND_FEE_BPS',
      params: '{}',
      outcome: 'ok',
      detail: null,
    })
  })

  it('rolls back a set when its audit insert fails', async () => {
    const { app, adminStore, driver } = await buildReal()
    try {
      await adminStore.setOverride('LN_SEND_MAX_SATS', '25000')
      await rejectAuditInserts(driver)

      expect((await patch(app, { key: 'LN_SEND_MAX_SATS', value: '50000' })).status).toBe(500)
      expect(await adminStore.getOverrides()).toEqual({ LN_SEND_MAX_SATS: '25000' })
      expect(await adminStore.listActions()).toEqual([])
    } finally {
      await adminStore.close()
    }
  })

  it('rolls back a clear when its audit insert fails', async () => {
    const { app, adminStore, driver } = await buildReal()
    try {
      await adminStore.setOverride('LN_SEND_FEE_BPS', '25')
      await rejectAuditInserts(driver)

      expect((await patch(app, { key: 'LN_SEND_FEE_BPS', value: null })).status).toBe(500)
      expect(await adminStore.getOverrides()).toEqual({ LN_SEND_FEE_BPS: '25' })
      expect(await adminStore.listActions()).toEqual([])
    } finally {
      await adminStore.close()
    }
  })

  it('distinguishes stored from applied when a live key reaches disk but not the process', async () => {
    const { app, adminStore, services } = await buildReal()
    try {
      const svc = services as unknown as { replacePolicy: () => Promise<void> }
      svc.replacePolicy = async () => {
        throw new Error('rebuild refused')
      }

      const response = await patch(app, { key: 'ASSET_CARRIER_PRICING', value: 'true' })

      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({
        error: 'reload_failed',
        key: 'ASSET_CARRIER_PRICING',
        stored: true,
        applied: false,
        message: 'rebuild refused',
      })
      // `stored: true` has to be the truth, not a guess about what the write did.
      expect(await adminStore.getOverrides()).toEqual({ ASSET_CARRIER_PRICING: 'true' })
    } finally {
      await adminStore.close()
    }
  })

  it('rejects a malformed body rather than 500ing', async () => {
    const { app } = build()
    expect((await patch(app, { value: '1' })).status).toBe(400)
    expect((await patch(app, { key: 'LN_SEND_FEE_BPS', value: 25 })).status).toBe(400)
  })
})

const USDA = '1a'.repeat(34)

const marketFixture = (): AssetMarketConfig => ({
  ...DEFAULT_SERVING,
  symbol: 'USDA',
  carrierMode: 'inherit',
  base: null,
  quote: USDA,
  baseDecimals: 8,
  quoteDecimals: 6,
  feedUrl: 'https://feed.test/price',
  pricePath: '/price',
  toleranceBps: 10,
  feeBps: 25,
  sellBaseFeeFlat: 0n,
  buyBaseFeeFlat: 0n,
  sellBase: { min: 1n, max: 10n ** 24n },
  buyBase: { min: 1n, max: 10n ** 24n },
  enabled: true,
})

const quoteRequest = (n: number) => ({
  rfqId: n.toString(16).padStart(64, '0'),
  pair: `arkade:BTC->arkade:${USDA}`,
  amount: 100_000_000n,
  amountSide: 'from' as const,
  makerPkScript: `5120${'c'.repeat(64)}`,
  makerPublicKey: n.toString(16).padStart(64, '0'),
})

/** A real service, and a `replacePolicy` hand-wired from the shipped functions. Arm 2 stops it drifting. */
const liveHarness = async () => {
  const { adminStore } = await buildReal()
  const swapStore = await AssetRfqSwapStore.open(':memory:')
  const service = new AssetRfqSwapService({
    store: swapStore,
    markets: [],
    solverPubkey: 'e'.repeat(64),
    quoteValiditySeconds: 30,
    dustSats: 330n,
    fetchPrice: async () => ({ mantissa: 100_000n, scale: 0 }),
    deriveOffer: (terms) => ({
      pkScript: `5120${terms.makerPublicKey}`,
      address: `ark1q${terms.makerPublicKey.slice(0, 8)}`,
    }),
    depositAt: async () => null,
    balance: async () => new Map([[USDA, 10n ** 24n]]),
    settle: async () => 'fa'.repeat(32),
  })
  const services = {
    config: structuredClone(baseConfig),
    policy: structuredClone(baseConfig),
    bootPolicy: structuredClone(baseConfig),
    bootOverrides: {},
    adminStore,
    replacePolicy: async (next: { assetCarrierPricing: boolean }) => {
      services.policy = next as never
      await service.replaceMarkets(
        assetRfqMarketsFrom(assetMarketPolicy(await adminStore.listMarkets()).pricing, {
          dustSats: 330n,
          pricedByDefault: next.assetCarrierPricing,
        }),
      )
    },
    replaceMarkets: async () => {
      await service.replaceMarkets(
        assetRfqMarketsFrom(assetMarketPolicy(await adminStore.listMarkets()).pricing, {
          dustSats: 330n,
          pricedByDefault: services.policy.assetCarrierPricing,
        }),
      )
    },
  }
  return {
    app: buildAdminApp({ services: services as never, startedAt: 1, mode: 'relay' }),
    service,
    adminStore,
    swapStore,
    services,
  }
}

describe('a live knob reaches the next quote without a restart', () => {
  it('changes what the next quote costs, with no restart', async () => {
    const { app, service, adminStore, swapStore, services } = await liveHarness()
    await adminStore.putMarket(marketFixture())
    await services.replaceMarkets()

    const before = await service.quote(quoteRequest(1))
    expect(before.accepted && before.carrierSats).toBe(0n)

    const res = await patch(app, { key: 'ASSET_CARRIER_PRICING', value: 'true' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { restartRequired: boolean }).restartRequired).toBe(false)

    const after = await service.quote(quoteRequest(2))
    expect(after.accepted && after.carrierSats).toBe(330n)
    expect(after.accepted && before.accepted && BigInt(after.swap.toAmount) < BigInt(before.swap.toAmount)).toBe(true)
    await swapStore.close()
  })

  it('builds replacePolicy from the same rebuild the market swap uses', () => {
    const body = createServicesBody()
    expect(body).toContain('replacePolicy: (next: Config): Promise<void> =>')
    expect(body).toContain('services.policy = next')
    expect(body).toContain('await rebuild(next)')
    expect(body.match(/const rebuild = async/g)).toHaveLength(1)
    expect(body).toContain('replaceMarkets: (): Promise<void> => replaceQueue(() => rebuild(services.policy))')
    // ASSIGNED once: a `services.bootPolicy =` makes this two, a deleted one zero.
    expect(body.match(/bootPolicy\s*[:=]/g)).toHaveLength(1)
  })

  it('assigns policy only after the rebuild it has to survive', () => {
    const body = createServicesBody()
    const start = body.indexOf('replacePolicy: (next: Config)')
    const arrow = body.slice(start, body.indexOf('}),', start))
    expect(arrow).toContain('services.policy = next')
    // Assigned first, a throwing rebuild leaves `policy` naming a config no runtime list was built from.
    expect(arrow.indexOf('await rebuild(next)')).toBeLessThan(arrow.indexOf('services.policy = next'))
  })
})

describe('the settings table renders the pending state', () => {
  const appSource = readFileSync(
    fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
    'utf8',
  )
  const view = (): string =>
    appSource.slice(appSource.indexOf('const settingsView'), appSource.indexOf('/* ==== asset markets'))

  it('badges a knob that is waiting, not merely one that is overridden', () => {
    expect(view()).toContain('knob.pending')
  })

  it('stops spending the risk colour on every override', () => {
    // Amber is reserved for risk (styles.css:4). Being overridden is not one;
    // a stored change the process has not loaded is.
    const source = view()
    const amberAt = source.indexOf('phase-exposed')
    expect(amberAt).toBeGreaterThan(-1)
    expect(source.slice(amberAt - 120, amberAt)).toContain('pending')
  })
})
