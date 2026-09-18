/**
 * The preview, through the assembled app. The load-bearing assertion is the
 * last one: a sample must equal what a real quote returns for the same inputs.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { priceFrom } from '@arkade-os/solver-core/core/priceFeed.js'
import { resolveAssetQuote } from '@arkade-os/solver-core/core/assetRfq.js'

const USDX = 'dd'.repeat(34)
const FEED = 'https://feed.test/price'

const marketBody = (over: Record<string, unknown> = {}) => ({
  base: 'BTC',
  quote: USDX,
  baseDecimals: 8,
  quoteDecimals: 6,
  feedUrl: FEED,
  pricePath: '/price',
  toleranceBps: 10,
  feeBps: 50,
  sellBaseFeeFlat: '0',
  buyBaseFeeFlat: '0',
  sellBase: { min: '1', max: '100000000' },
  buyBase: { min: '1000', max: '100000000' },
  ...over,
})

// applyOverrides/resolveDraftPolicy both iterate every corridor, so a config
// holding one reads undefined.minSats on the others.
const CORRIDOR_KEYS = [
  'arkade:BTC->lightning:BTC',
  'lightning:BTC->arkade:BTC',
  'arkade:BTC->onchain:BTC',
  'onchain:BTC->arkade:BTC',
] as const
const everyCorridor = <T>(value: () => T) => Object.fromEntries(CORRIDOR_KEYS.map((key) => [key, value()]))

const build = async (over: Record<string, unknown> = {}) => {
  const adminStore = await AdminStore.open(':memory:', () => 1_000_000)
  const fetchPrice = vi.fn(async () => priceFrom('100000'))
  const services = {
    config: {
      corridorFees: everyCorridor(() => ({ bps: 0, flatSats: 0 })),
      corridorLimits: everyCorridor(() => ({ minSats: 1_000, maxSats: 100_000 })),
      corridorEnabled: everyCorridor(() => true),
      maxExposedSats: 1_000_000,
      lockupTimeoutSeconds: 3_600,
    },
    policy: { offerMarkets: [], assetRfqTokens: [], assetCarrierPricing: true, offerChargesDeliveredCarrier: false },
    arkade: { dustSats: 330n },
    adminStore,
    assetMarkets: [] as unknown[],
    liveOfferMarkets: [],
    assetRfqMarkets: [],
    replaceMarkets: async () => {},
    ...over,
  }
  const app = buildAdminApp({ services: services as never, startedAt: 1, mode: 'relay', fetchPrice })
  return { app, adminStore, services, fetchPrice }
}

const preview = async (app: ReturnType<typeof buildAdminApp>, payload: unknown) => {
  const response = await app.fetch(
    new Request('http://admin/api/pricing/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const save = (app: ReturnType<typeof buildAdminApp>, body: unknown) =>
  app.fetch(
    new Request('http://admin/api/markets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

describe('POST /api/pricing/preview — asset markets', () => {
  it('prices a ladder against the saved feed, without fetching again', async () => {
    const { app, adminStore, fetchPrice } = await build()
    await save(app, marketBody())
    fetchPrice.mockClear()
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody(),
      direction: 'sell_base',
      side: 'from',
    })
    expect(body.invalid).toEqual([])
    expect(body.feed).toMatchObject({ state: 'resolved' })
    expect((body.samples as unknown[]).length).toBeGreaterThan(2)
    // The save's probe primed the cache; the preview must add no request.
    expect(fetchPrice).not.toHaveBeenCalled()
    await adminStore.close()
  })

  it('equals a real quote at the same inputs', async () => {
    const { app, adminStore } = await build()
    await save(app, marketBody())
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody(),
      direction: 'sell_base',
      side: 'from',
    })
    const samples = body.samples as unknown as { ok: boolean; fromAmount: string; toAmount: string }[]
    const priced = samples.find((sample) => sample.ok)!
    const quote = resolveAssetQuote({
      pair: { from: null, to: USDX },
      amount: BigInt(priced.fromAmount),
      amountSide: 'from',
      market: {
        base: null,
        quote: USDX,
        baseDecimals: 8,
        quoteDecimals: 6,
        feeBps: 50,
        minPayout: 1n,
        maxPayout: 100_000_000n,
      },
      feed: priceFrom('100000'),
      carrierSats: 330n,
      dustSats: 330n,
    })
    expect(quote).toMatchObject({ ok: true, toAmount: BigInt(priced.toAmount) })
    await adminStore.close()
  })

  it('seeds the ladder in the payout leg’s units, not the deposit’s', async () => {
    // minPayout is on the TO leg; an exact-in `amount` is the FROM leg, so a
    // ladder seeded straight off the bound renders asset atoms as sats.
    const { app, adminStore } = await build()
    await save(app, marketBody())
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody(),
      direction: 'sell_base',
      side: 'from',
    })
    const samples = body.samples as unknown as { ok: boolean; fromAmount?: string }[]
    const lowest = samples.filter((sample) => sample.ok).map((sample) => BigInt(sample.fromAmount!))
    // Just above the 330-sat carrier floor, not an order of magnitude above it —
    // `toBeGreaterThan(330n)` alone passes even off a raw-bound seed that skips
    // straight to the next decade (1000n), so it is bounded on both sides.
    expect(lowest[0]).toBeGreaterThan(330n)
    expect(lowest[0]).toBeLessThan(500n)
    await adminStore.close()
  })

  it('renders feed-unresolved when the draft points somewhere else', async () => {
    const { app, adminStore } = await build()
    await save(app, marketBody())
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody({ feedUrl: 'https://other.test/price' }),
      direction: 'sell_base',
      side: 'from',
    })
    expect(body.feed).toMatchObject({ state: 'unresolved' })
    expect(body.samples).toEqual([])
    await adminStore.close()
  })

  it('names the field rather than pricing a market it refused', async () => {
    const { app, adminStore } = await build()
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody({ feeBps: 10_000 }),
      direction: 'sell_base',
      side: 'from',
    })
    expect(body.invalid).toMatchObject([{ key: 'feeBps' }])
    expect(body.samples).toEqual([])
    await adminStore.close()
  })

  it('does not refuse a grandfathered loopback feed, which it never fetches', async () => {
    // Task 2 default-refuses this URL at the write, because the write fetches
    // it. This route only ever reads a cached feed already on disk.
    const { app, adminStore } = await build()
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody({ feedUrl: 'http://127.0.0.1:8080/price' }),
      direction: 'sell_base',
      side: 'from',
    })
    expect(body.invalid).toEqual([])
    expect(body.feed).toMatchObject({ state: 'unresolved' })
    await adminStore.close()
  })

  it('renders no break-even while the carrier is priced', async () => {
    const { app, adminStore } = await build()
    await save(app, marketBody())
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody(),
      direction: 'sell_base',
      side: 'from',
    })
    expect(body.breakEven).toEqual({ kind: 'none' })
    await adminStore.close()
  })

  it('renders "never" at a zero spread with the carrier unpriced', async () => {
    const { app, adminStore } = await build({
      policy: { offerMarkets: [], assetRfqTokens: [], assetCarrierPricing: false, offerChargesDeliveredCarrier: false },
    })
    await save(app, marketBody({ feeBps: 0 }))
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody({ feeBps: 0 }),
      direction: 'sell_base',
      side: 'from',
    })
    expect(body.breakEven).toEqual({ kind: 'never' })
    await adminStore.close()
  })

  it('names the size below which an unpriced carrier costs more than it earns', async () => {
    const { app, adminStore } = await build({
      policy: { offerMarkets: [], assetRfqTokens: [], assetCarrierPricing: false, offerChargesDeliveredCarrier: false },
    })
    await save(app, marketBody())
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody(),
      direction: 'sell_base',
      side: 'from',
    })
    expect(body.breakEven).toEqual({ kind: 'at', amountSats: '66000' })
    await adminStore.close()
  })

  it('offers no maker ceiling on a deployment that serves no offers', async () => {
    const { app, adminStore } = await build()
    await save(app, marketBody())
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody(),
      direction: 'sell_base',
      side: 'from',
    })
    expect(body.offerCeiling).toBeNull()
    await adminStore.close()
  })

  it('names the most a maker may ask, where the offer path is served', async () => {
    const { app, adminStore } = await build({
      policy: {
        offerMarkets: [{ a: null, b: USDX }],
        assetRfqTokens: [],
        assetCarrierPricing: true,
        offerChargesDeliveredCarrier: false,
      },
    })
    await save(app, marketBody())
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody(),
      direction: 'sell_base',
      side: 'from',
    })
    const ceiling = body.offerCeiling as unknown as { deposit: string; wantAmount: string }
    expect(BigInt(ceiling.wantAmount)).toBeGreaterThan(0n)
    await adminStore.close()
  })

  it('has no break-even on the direction where the client fronts the carrier', async () => {
    const { app, adminStore } = await build({
      policy: { offerMarkets: [], assetRfqTokens: [], assetCarrierPricing: false, offerChargesDeliveredCarrier: false },
    })
    await save(app, marketBody())
    const { body } = await preview(app, { target: 'market', market: marketBody(), direction: 'buy_base', side: 'from' })
    expect(body.breakEven).toEqual({ kind: 'none' })
    await adminStore.close()
  })
})

describe('POST /api/pricing/preview — BTC corridors', () => {
  it('prices a ladder against a drafted override', async () => {
    const { app, adminStore } = await build()
    const { body } = await preview(app, {
      target: 'corridor',
      corridor: 'arkade:BTC->lightning:BTC',
      overrides: { LN_SEND_FEE_BPS: '25', LN_SEND_FEE_FLAT_SATS: '150' },
      side: 'from',
    })
    expect(body.invalid).toEqual([])
    const samples = body.samples as unknown as { ok: boolean; reason?: string; giveSats?: number }[]
    // The mockup renders both out-of-range probes as refusals, so an operator recognises the shape of one.
    expect(samples[0]).toMatchObject({ ok: false, reason: 'below_min' })
    expect(samples.at(-1)).toMatchObject({ ok: false, reason: 'above_max' })
    expect(samples.filter((sample) => sample.ok).length).toBeGreaterThan(1)
    await adminStore.close()
  })

  it('renders NO break-even, because Fee carries no cost basis', async () => {
    const { app, adminStore } = await build()
    const { body } = await preview(app, {
      target: 'corridor',
      corridor: 'arkade:BTC->lightning:BTC',
      overrides: {},
      side: 'from',
    })
    expect(body.breakEven).toEqual({ kind: 'none' })
    await adminStore.close()
  })

  it('refuses a crossed range on both keys rather than pricing the environment’s', async () => {
    const { app, adminStore } = await build()
    const { body } = await preview(app, {
      target: 'corridor',
      corridor: 'arkade:BTC->lightning:BTC',
      overrides: { LN_SEND_MIN_SATS: '90000', LN_SEND_MAX_SATS: '5000' },
      side: 'from',
    })
    expect((body.invalid as unknown as { key: string }[]).map((item) => item.key)).toEqual([
      'LN_SEND_MIN_SATS',
      'LN_SEND_MAX_SATS',
    ])
    expect(body.samples).toEqual([])
    await adminStore.close()
  })

  it('writes nothing', async () => {
    const { app, adminStore } = await build()
    await preview(app, { target: 'market', market: marketBody(), direction: 'sell_base', side: 'from' })
    expect(await adminStore.listMarkets()).toEqual([])
    expect(await adminStore.listActions()).toEqual([])
    await adminStore.close()
  })
})
