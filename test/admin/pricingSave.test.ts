/**
 * The console's write path. `pricingApply.test.ts` proves the route works; this proves something reaches it (#195).
 * The first half drives the shipped `pricingSave.js` against a real assembled admin app; the second reads `app.js`,
 * as `marketsView.test.ts` does and for its reason — the call sites are in a module with no exports.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { staticRoot } from '@arkade-os/solver-app/admin/static.js'
import { assetMarketKey, assetMarketPolicy } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { priceFrom } from '@arkade-os/solver-core/core/priceFeed.js'
import { CORRIDORS, FREE } from '@arkade-os/solver-core/core/corridorPolicy.js'
// Relative, as `charts.test.ts` is: the package alias rewrites `.js` to `.ts`.
import { applyPricing, APPLY_PATH, type ApplyError } from '../../packages/solver-app/src/admin/static/pricingSave.js'

const USDT = 'aa'.repeat(34)
const KEY = assetMarketKey(null, USDT)

const marketBody = (over: Record<string, unknown> = {}) => ({
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
  carrierMode: 'inherit',
  ...over,
})

const build = async () => {
  const adminStore = await AdminStore.open(':memory:', () => 1_000_000)
  const config = {
    assetCarrierPricing: false,
    maxExposedSats: 1_000_000,
    lockupTimeoutSeconds: 3_600,
    corridorLimits: Object.fromEntries(CORRIDORS.map((c) => [c, { minSats: 1_000, maxSats: 100_000 }])),
    corridorFees: Object.fromEntries(CORRIDORS.map((c) => [c, FREE])),
    corridorEnabled: Object.fromEntries(CORRIDORS.map((c) => [c, true])),
    offerMarkets: [],
    assetRfqTokens: [],
  }
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
    replaceMarkets: async () => {
      services.assetMarkets = assetMarketPolicy(await adminStore.listMarkets()).pricing as never
    },
    replacePolicy: async () => {},
  }
  const fetchPrice = vi.fn(async () => priceFrom('100000'))
  const app = buildAdminApp({ services: services as never, startedAt: 1, mode: 'relay', fetchPrice })
  return { app, adminStore }
}

/** `app.js`'s own `api()`: parse, and throw on a non-2xx. The behaviour under test is what
 *  `applyPricing` does with the 200 that a refusal arrives as, which this therefore must not throw on. */
const apiFor =
  (app: ReturnType<typeof buildAdminApp>) => async (path: string, options?: { method?: string; body?: string }) => {
    const response = await app.fetch(
      new Request(`http://admin${path}`, {
        method: options?.method,
        headers: options?.body ? { 'content-type': 'application/json' } : undefined,
        body: options?.body,
      }),
    )
    const parsed = (await response.json()) as { message?: string; error?: string }
    if (!response.ok) throw new Error(parsed.message || parsed.error || String(response.status))
    return parsed
  }

describe('the console reaches the ordered save', () => {
  it('posts a market to /api/pricing/apply and stores it', async () => {
    const { app, adminStore } = await build()
    const answer = await applyPricing(apiFor(app), { markets: [marketBody()], overrides: {} })

    expect(APPLY_PATH).toBe('/api/pricing/apply')
    expect(answer.applied).toEqual([KEY])
    expect((await adminStore.listMarkets())[0]?.marketKey).toBe(KEY)
    await adminStore.close()
  })

  it('carries the market and the deployment default in ONE save, under one revision', async () => {
    const { app, adminStore } = await build()
    const api = apiFor(app)
    await applyPricing(api, { markets: [marketBody()], overrides: {} })

    // The payload `saveMarket` now builds when the form's carrier default moved.
    const answer = await applyPricing(api, {
      markets: [marketBody({ feeBps: 30 })],
      overrides: { ASSET_CARRIER_PRICING: 'true' },
    })

    const rows = (await adminStore.listActions()).filter((row) => row.revision === answer.revision)
    // Two puts for the one market: the narrowing interim, then the target.
    expect(rows.map((row) => row.action).sort()).toEqual(['market-put', 'market-put', 'setting-set'])
    expect(answer.applied.sort()).toEqual([KEY, 'ASSET_CARRIER_PRICING'].sort())
    await adminStore.close()
  })

  it('applies a settings edit, and a clear, through the same route', async () => {
    const { app, adminStore } = await build()
    const api = apiFor(app)
    expect((await applyPricing(api, { overrides: { MAX_EXPOSED_SATS: '5000' } })).applied).toEqual(['MAX_EXPOSED_SATS'])
    expect(await adminStore.getOverrides()).toEqual({ MAX_EXPOSED_SATS: '5000' })

    await applyPricing(api, { overrides: { MAX_EXPOSED_SATS: null } })
    expect(await adminStore.getOverrides()).toEqual({})
    await adminStore.close()
  })
})

describe('a refusal the route reports with 200 still reaches the operator', () => {
  it('throws, naming every refused key', async () => {
    const { app, adminStore } = await build()
    await expect(
      applyPricing(apiFor(app), { overrides: { ASSET_CARRIER_PRICING: 'yes', MAX_EXPOSED_SATS: '-1' } }),
    ).rejects.toThrow(/ASSET_CARRIER_PRICING.*MAX_EXPOSED_SATS/s)
    await adminStore.close()
  })

  it('names the half that DID land, so the operator does not retry it', async () => {
    const { app, adminStore } = await build()
    // MAX_EXPOSED_SATS is narrowing here and lands; the market has no symbol and is refused.
    const error = await applyPricing(apiFor(app), {
      markets: [marketBody({ symbol: '' })],
      overrides: { MAX_EXPOSED_SATS: '5000' },
    }).then<null | ApplyError, ApplyError>(
      () => null,
      (caught: ApplyError) => caught,
    )

    expect(error?.message).toContain('applied: MAX_EXPOSED_SATS')
    expect(error?.unapplied.map((entry) => entry.key)).toEqual([KEY])
    expect(await adminStore.getOverrides()).toEqual({ MAX_EXPOSED_SATS: '5000' })
    await adminStore.close()
  })

  it('does not throw when nothing was refused', async () => {
    const { app, adminStore } = await build()
    await expect(applyPricing(apiFor(app), { overrides: {} })).resolves.toMatchObject({ unapplied: [] })
    await adminStore.close()
  })
})

const APP = readFileSync(join(staticRoot(), 'app.js'), 'utf8')

const saveMarketBody = (): string => {
  const start = APP.indexOf('const saveMarket')
  if (start === -1) throw new Error('saveMarket is gone from app.js — this test is measuring nothing')
  const body = APP.slice(start)
  return body.slice(0, body.indexOf('\n}'))
}

describe('the ordered save is the console’s ONLY pricing write', () => {
  it('saves a market through applyPricing, with the deployment default in the same request', () => {
    expect(saveMarketBody()).toContain(
      'applyPricing(api, { markets: [marketBody(marketDraft)], overrides: carrierDefaultOverride() })',
    )
    expect(APP).toContain('const openMarketForm = (draft) =>')
    expect(APP).toContain('openMarketForm(blankMarket())')
    expect(APP).toContain('openMarketForm(draftFrom(market))')
  })

  it('leaves no unordered write behind — the endpoints stay for API clients, the console does not use them', () => {
    // `PUT`/`PATCH` still answer, so the console not calling them is the whole
    // difference between an enforced ordering and an advisory one.
    expect(APP).not.toContain("'/api/markets', { method: 'PUT'")
    expect(APP).not.toContain("'/api/settings', { method: 'PATCH'")
    expect(APP).not.toContain("method: 'PATCH'")
  })

  it('edits and clears a knob through applyPricing too', () => {
    const start = APP.indexOf('const patchSetting')
    expect(start).toBeGreaterThan(-1)
    expect(APP.slice(start, APP.indexOf('\n}', start))).toContain('applyPricing(api, { overrides: { [key]: value } })')
  })

  it('still deletes a market with DELETE, which the ordered save has no spelling for', () => {
    expect(APP).toContain("{ method: 'DELETE' }")
  })
})
