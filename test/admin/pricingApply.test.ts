/**
 * The ordered save through the assembled admin app. `test/core/saveOrder.test.ts`
 * pins the classifier; this pins what a classifier alone cannot promise.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { assetMarketKey, assetMarketPolicy } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { priceFrom } from '@arkade-os/solver-core/core/priceFeed.js'
import { CORRIDORS, FREE } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { editableKeys } from '@arkade-os/solver-app/admin/settings.js'
import { fieldForOverride } from '@arkade-os/solver-app/admin/routes/pricingApply.js'

const USDT = 'aa'.repeat(34)
const KEY = assetMarketKey(null, USDT)

const body = (over: Record<string, unknown> = {}) => ({
  base: 'BTC',
  quote: USDT,
  symbol: 'USDA',
  baseDecimals: 8,
  quoteDecimals: 6,
  feedUrl: 'https://feed.test/price',
  pricePath: '/price',
  toleranceBps: 10,
  feeBps: 25,
  sellBaseFeeFlat: '330',
  buyBaseFeeFlat: '1000000',
  ...over,
})

const build = async (over: { assetCarrierPricing?: boolean } = {}) => {
  const adminStore = await AdminStore.open(':memory:', () => 1_000_000)
  const config = {
    assetCarrierPricing: over.assetCarrierPricing ?? false,
    maxExposedSats: 1_000_000,
    lockupTimeoutSeconds: 3_600,
    corridorLimits: Object.fromEntries(CORRIDORS.map((c) => [c, { minSats: 1_000, maxSats: 100_000 }])),
    corridorFees: Object.fromEntries(CORRIDORS.map((c) => [c, FREE])),
    corridorEnabled: Object.fromEntries(CORRIDORS.map((c) => [c, true])),
    offerMarkets: [],
    assetRfqTokens: [],
  }
  const policies: unknown[] = []
  const services = {
    config,
    policy: { ...config, offerMarkets: [], assetRfqTokens: [] },
    bootPolicy: config,
    bootOverrides: {},
    adminStore,
    arkade: { dustSats: 330n },
    assetMarkets: [],
    liveOfferMarkets: [] as { a: string | null; b: string | null }[],
    assetRfqMarkets: [] as { base: string | null; quote: string | null }[],
    // Validates every row as `rebuild()` does, so a bad write fails here not at boot.
    replaceMarkets: async () => {
      services.assetMarkets = assetMarketPolicy(await adminStore.listMarkets()).pricing as never
    },
    replacePolicy: async (next: unknown) => void policies.push(next),
  }
  const fetchPrice = vi.fn(async () => priceFrom('100000'))
  const app = buildAdminApp({ services: services as never, startedAt: 1, mode: 'relay', fetchPrice })
  return { app, adminStore, policies, services }
}

const put = (app: ReturnType<typeof buildAdminApp>, payload: unknown) =>
  app.fetch(
    new Request('http://admin/api/markets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )

const apply = (app: ReturnType<typeof buildAdminApp>, payload: unknown) =>
  app.fetch(
    new Request('http://admin/api/pricing/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )

type Answer = { revision: string; applied: string[]; unapplied: { key: string; reason: string }[] }
const answered = async (res: Response) => (await res.json()) as Answer

/** Fail the SECOND putMarket, which is the widening pass. */
const failWideningPass = (adminStore: AdminStore) => {
  const real = adminStore.putMarket.bind(adminStore)
  let calls = 0
  vi.spyOn(adminStore, 'putMarket').mockImplementation(async (m) => {
    if ((calls += 1) === 2) throw new Error('disk full')
    return real(m)
  })
}

describe('a save that dies midway lands conservative', () => {
  it('applies restrictions and no relaxations', async () => {
    const { app, adminStore } = await build()
    await put(app, body({ sellBase: { min: '10', max: '100' } }))
    failWideningPass(adminStore)

    const res = await apply(app, { markets: [body({ sellBase: { min: '20', max: '400' } })] })
    const row = (await adminStore.listMarkets())[0]!
    expect(row.sellBase).toEqual({ min: 20n, max: 100n })
    const seen = await answered(res)
    expect(seen.unapplied).toHaveLength(1)
    expect(seen.applied).toEqual([])
    await adminStore.close()
  })

  it('refuses a body whose legs are the other way round from the stored row', async () => {
    const { app, adminStore } = await build()
    await put(app, body({ sellBase: { min: '1000', max: '100000' }, buyBase: { min: '7', max: '9' } }))

    // Same market by key, but `sellBase` is base-denominated: narrowing one orientation
    // against the other compares sats to atoms.
    const res = await apply(app, {
      markets: [body({ base: USDT, quote: 'BTC', baseDecimals: 6, quoteDecimals: 8 })],
    })

    const seen = await answered(res)
    expect(seen.applied).toEqual([])
    expect(seen.unapplied).toEqual([{ key: KEY, reason: expect.stringContaining('legs') }])
    const row = (await adminStore.listMarkets())[0]!
    expect(row.base).toBeNull()
    expect(row.sellBase).toEqual({ min: 1000n, max: 100000n })
    expect(row.buyBase).toEqual({ min: 7n, max: 9n })
    await adminStore.close()
  })

  /** Fail the SECOND replaceMarkets: the reload that activates pass 2, not the gate before it. */
  const failFinalReload = (services: { replaceMarkets: () => Promise<void> }) => {
    const real = services.replaceMarkets
    let calls = 0
    services.replaceMarkets = async () => {
      if ((calls += 1) < 2) return real()
      services.replaceMarkets = real
      throw new Error('rebuild refused')
    }
  }

  it('answers structurally when the reload that activates pass 2 throws', async () => {
    const { app, adminStore, services } = await build()
    await put(app, body({ sellBase: { min: '10', max: '100' } }))
    failFinalReload(services)

    const res = await apply(app, {
      markets: [body({ sellBase: { min: '10', max: '400' } })],
      overrides: { ASSET_CARRIER_PRICING: 'true' },
    })

    expect(res.status).toBe(200)
    const seen = await answered(res)
    // The widened row reached disk, but nothing is serving it, so it is not `applied`.
    expect((await adminStore.listMarkets())[0]!.sellBase).toEqual({ min: 10n, max: 400n })
    expect(seen.unapplied).toEqual([{ key: KEY, reason: 'rebuild refused' }])
    expect(seen.applied).toEqual(['ASSET_CARRIER_PRICING'])
    await adminStore.close()
  })

  it('does not lower a per-direction fee when the widening pass dies', async () => {
    // 900 -> 0 is a RELAXATION; `buyBaseFeeFlat` 1000 -> 5000 is the control.
    const { app, adminStore } = await build()
    await put(app, body({ sellBaseFeeBps: 900, buyBaseFeeFlat: '1000' }))
    failWideningPass(adminStore)

    await apply(app, { markets: [body({ sellBaseFeeBps: 0, buyBaseFeeFlat: '5000', feeBps: 25 })] })
    const row = (await adminStore.listMarkets())[0]!
    expect(row.sellBaseFeeBps).toBe(900)
    expect(row.buyBaseFeeFlat).toBe(5000n)
    await adminStore.close()
  })

  it('defers clearing an explicit spread back to a lower inherited fee', async () => {
    // `null` is INHERIT: 900 -> null against feeBps 25 lowers what the client pays.
    const { app, adminStore } = await build()
    await put(app, body({ feeBps: 25, sellBaseFeeBps: 900 }))
    failWideningPass(adminStore)

    await apply(app, { markets: [body({ feeBps: 25, sellBaseFeeBps: null })] })
    expect((await adminStore.listMarkets())[0]!.sellBaseFeeBps).toBe(900)
    await adminStore.close()
  })

  it('defers priced -> inherit on a deployment whose default is off', async () => {
    const { app, adminStore } = await build({ assetCarrierPricing: false })
    await put(app, body({ carrierMode: 'priced' }))
    failWideningPass(adminStore)

    await apply(app, { markets: [body({ carrierMode: 'inherit' })] })
    expect((await adminStore.listMarkets())[0]!.carrierMode).toBe('priced')
    await adminStore.close()
  })

  it('applies that same edit in pass 1 where the default IS priced, because it is then a no-op', async () => {
    const { app, adminStore } = await build({ assetCarrierPricing: true })
    await put(app, body({ carrierMode: 'priced' }))
    failWideningPass(adminStore)

    await apply(app, { markets: [body({ carrierMode: 'inherit' })] })
    expect((await adminStore.listMarkets())[0]!.carrierMode).toBe('inherit')
    await adminStore.close()
  })

  it('defers a re-opened direction and applies the closed one in the same save', async () => {
    const { app, adminStore } = await build()
    await put(app, body({ servesRfq: true, rfqSellBase: true, rfqBuyBase: true }))
    failWideningPass(adminStore)

    await apply(app, { markets: [body({ servesRfq: true, rfqSellBase: false, rfqBuyBase: true, enabled: true })] })
    const row = (await adminStore.listMarkets())[0]!
    expect(row.rfqSellBase).toBe(false)
    expect(row.rfqBuyBase).toBe(true)
    await adminStore.close()
  })
})

describe('the whole save succeeds when nothing fails', () => {
  it('writes the target the operator asked for', async () => {
    const { app, adminStore } = await build()
    await put(app, body({ sellBase: { min: '10', max: '100' } }))

    const seen = await answered(await apply(app, { markets: [body({ sellBase: { min: '20', max: '400' } })] }))
    expect(seen.applied).toEqual([KEY])
    expect(seen.unapplied).toEqual([])
    expect((await adminStore.listMarkets())[0]!.sellBase).toEqual({ min: 20n, max: 400n })
    await adminStore.close()
  })

  it('creates a market that had no stored row in the widening pass only', async () => {
    // Proven by aborting between the passes: a pass-1 write would already be on disk.
    const { app, adminStore, services } = await build()
    const real = services.replaceMarkets
    services.replaceMarkets = async () => {
      services.replaceMarkets = real
      throw new Error('rebuild refused')
    }
    const first = await answered(await apply(app, { markets: [body()] }))
    expect(await adminStore.listMarkets()).toEqual([])
    expect(first.unapplied).toHaveLength(1)

    const second = await answered(await apply(app, { markets: [body()] }))
    expect(second.applied).toEqual([KEY])
    expect(await adminStore.listMarkets()).toHaveLength(1)
    await adminStore.close()
  })
})

describe('the audit trail of one save', () => {
  it('stamps every row from one save with the same revision', async () => {
    const { app, adminStore } = await build()
    const seen = await answered(await apply(app, { markets: [body()], overrides: { ASSET_CARRIER_PRICING: 'true' } }))
    const rows = await adminStore.listActions()
    expect(rows.length).toBeGreaterThan(1)
    const revisions = new Set(rows.map((row) => row.revision))
    expect(revisions.size).toBe(1)
    expect([...revisions][0]).toBe(seen.revision)
    expect([...revisions][0]).not.toBeNull()
    await adminStore.close()
  })

  it('gives two saves two different revisions, or a partial save is not legible', async () => {
    const { app, adminStore } = await build()
    const one = await answered(await apply(app, { markets: [body()] }))
    const two = await answered(await apply(app, { markets: [body({ feeBps: 30 })] }))
    expect(one.revision).not.toBe(two.revision)
    await adminStore.close()
  })

  it('leaves the ordinary PUT route stamping no revision, so the two are distinguishable', async () => {
    const { app, adminStore } = await build()
    await put(app, body())
    expect((await adminStore.listActions())[0]!.revision).toBeNull()
    await adminStore.close()
  })
})

describe('nothing hides in the neutral default', () => {
  it('classifies every key editableKeys() itself yields, never a list copied beside it', () => {
    const keys = editableKeys()
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter((key) => fieldForOverride(key) === null)).toEqual([])
  })
})

describe('the funding window is ordered, not left to the unlisted default', () => {
  // The config's window is 3600, so 1800 shortens it and 5400 lengthens it.
  const abortBetweenPasses = (services: { replaceMarkets: () => Promise<void> }) => {
    const real = services.replaceMarkets
    services.replaceMarkets = async () => {
      services.replaceMarkets = real
      throw new Error('rebuild refused')
    }
  }

  it('applies a SHORTENED funding window in pass 1', async () => {
    const { app, adminStore, services } = await build()
    abortBetweenPasses(services)
    await apply(app, { overrides: { LOCKUP_TIMEOUT_SECONDS: '1800' } })
    expect((await adminStore.getOverrides()).LOCKUP_TIMEOUT_SECONDS).toBe('1800')
    await adminStore.close()
  })

  it('defers a LENGTHENED funding window to pass 2', async () => {
    const { app, adminStore, services } = await build()
    abortBetweenPasses(services)
    await apply(app, { overrides: { LOCKUP_TIMEOUT_SECONDS: '5400' } })
    expect(await adminStore.getOverrides()).toEqual({})
    await adminStore.close()
  })

  it('applies both directions when nothing fails', async () => {
    const { app, adminStore } = await build()
    expect((await answered(await apply(app, { overrides: { LOCKUP_TIMEOUT_SECONDS: '5400' } }))).applied).toEqual([
      'LOCKUP_TIMEOUT_SECONDS',
    ])
    expect((await adminStore.getOverrides()).LOCKUP_TIMEOUT_SECONDS).toBe('5400')
    await adminStore.close()
  })
})

describe('overrides travel in the same two passes', () => {
  it('turns carrier pricing ON in pass 1 and OFF in pass 2', async () => {
    const on = await build({ assetCarrierPricing: false })
    const onSeen = await answered(await apply(on.app, { overrides: { ASSET_CARRIER_PRICING: 'true' } }))
    expect(onSeen.applied).toEqual(['ASSET_CARRIER_PRICING'])
    // A LIVE key, so it reaches the running process rather than waiting for a restart.
    expect(on.policies).toHaveLength(1)
    await on.adminStore.close()

    const off = await build({ assetCarrierPricing: true })
    const offSeen = await answered(await apply(off.app, { overrides: { ASSET_CARRIER_PRICING: 'false' } }))
    expect(offSeen.applied).toEqual(['ASSET_CARRIER_PRICING'])
    await off.adminStore.close()
  })

  it('answers structurally when the pass-1 policy reload throws, and does not reach pass 2', async () => {
    const { app, adminStore, services } = await build()
    services.replacePolicy = async () => {
      throw new Error('policy reload refused')
    }

    const res = await apply(app, {
      markets: [body()],
      overrides: { ASSET_CARRIER_PRICING: 'true', LOCKUP_TIMEOUT_SECONDS: '1800' },
    })

    expect(res.status).toBe(200)
    const seen = await answered(res)
    expect(seen.unapplied).toEqual([{ key: 'ASSET_CARRIER_PRICING', reason: 'policy reload refused' }])
    expect(seen.applied).toEqual(['LOCKUP_TIMEOUT_SECONDS'])
    // A market with no stored row is created in the widening pass, so an empty table is pass 2 never running.
    expect(await adminStore.listMarkets()).toEqual([])
    await adminStore.close()
  })

  it('calls a live key that reached disk but not the process unapplied, in pass 2 as in pass 1', async () => {
    const { app, adminStore, services } = await build({ assetCarrierPricing: true })
    services.replacePolicy = async () => {
      throw new Error('policy reload refused')
    }

    const res = await apply(app, { overrides: { ASSET_CARRIER_PRICING: 'false' } })

    expect(res.status).toBe(200)
    const seen = await answered(res)
    expect(seen.applied).toEqual([])
    expect(seen.unapplied).toEqual([{ key: 'ASSET_CARRIER_PRICING', reason: 'policy reload refused' }])
    expect((await adminStore.getOverrides()).ASSET_CARRIER_PRICING).toBe('false')
    await adminStore.close()
  })

  it('reports a refused override as unapplied rather than answering 500', async () => {
    const { app, adminStore } = await build()
    const res = await apply(app, { overrides: { ASSET_CARRIER_PRICING: 'yes', NOT_A_KNOB: '1' } })
    expect(res.status).toBe(200)
    const seen = await answered(res)
    expect(seen.applied).toEqual([])
    expect(seen.unapplied.map((item) => item.key).sort()).toEqual(['ASSET_CARRIER_PRICING', 'NOT_A_KNOB'])
    expect(await adminStore.getOverrides()).toEqual({})
    await adminStore.close()
  })

  it('reports a market the validator refuses, and stores nothing for it', async () => {
    const { app, adminStore } = await build()
    const seen = await answered(await apply(app, { markets: [body({ toleranceBps: 10_000 })] }))
    expect(seen.applied).toEqual([])
    expect(seen.unapplied[0]!.reason).toMatch(/switched off/)
    expect(await adminStore.listMarkets()).toEqual([])
    await adminStore.close()
  })

  it('reports a market whose feed does not answer, like the PUT route does', async () => {
    const { adminStore, services } = await build()
    const app = buildAdminApp({
      services: services as never,
      startedAt: 1,
      mode: 'relay',
      fetchPrice: async () => {
        throw new Error('HTTP 503 Service Unavailable')
      },
    })
    const seen = await answered(await apply(app, { markets: [body()] }))
    expect(seen.unapplied[0]!.reason).toMatch(/503/)
    expect(await adminStore.listMarkets()).toEqual([])
    await adminStore.close()
  })
})

describe('pass 1 never writes a row no validator would admit', () => {
  it('defers a raised floor that crosses the current ceiling, rather than storing min > max', async () => {
    // Both halves legal, intersection empty: written as-is it breaks every later rebuild.
    const { app, adminStore } = await build()
    await put(app, body({ sellBase: { min: '10', max: '20' } }))
    failWideningPass(adminStore)

    const seen = await answered(await apply(app, { markets: [body({ sellBase: { min: '50', max: '400' } })] }))
    expect((await adminStore.listMarkets())[0]!.sellBase).toEqual({ min: 10n, max: 20n })
    expect(seen.unapplied).toHaveLength(1)
    await adminStore.close()
  })

  it('defers a direction swap that would close both at once under serves_rfq', async () => {
    const { app, adminStore } = await build()
    await put(app, body({ servesRfq: true, rfqSellBase: true, rfqBuyBase: false }))
    failWideningPass(adminStore)

    await apply(app, { markets: [body({ servesRfq: true, rfqSellBase: false, rfqBuyBase: true })] })
    const row = (await adminStore.listMarkets())[0]!
    expect({ sell: row.rfqSellBase, buy: row.rfqBuyBase }).toEqual({ sell: true, buy: false })
    await adminStore.close()
  })
})
