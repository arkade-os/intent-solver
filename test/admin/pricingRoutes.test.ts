/**
 * The preview, through the assembled app. The load-bearing assertion is the
 * last one: a sample must equal what a real quote returns for the same inputs.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { marketFrom } from '@arkade-os/solver-app/admin/routes/markets.js'
import { priceFrom } from '@arkade-os/solver-core/core/priceFeed.js'
import { resolveAssetQuote } from '@arkade-os/solver-core/core/assetRfq.js'
import { carrierBreakEven } from '@arkade-os/solver-core/core/pricingPreview.js'

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

  it('names pricePath for a pointer missing its leading slash', async () => {
    const { app, adminStore } = await build()
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody({ pricePath: 'price' }),
      direction: 'sell_base',
      side: 'from',
    })
    expect(body.invalid).toMatchObject([{ key: 'pricePath' }])
    await adminStore.close()
  })

  it('names pricePath for an unescaped tilde too', async () => {
    // This message has a colon glued straight onto the field name, unlike every other refusal here.
    const { app, adminStore } = await build()
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody({ pricePath: '/foo~x' }),
      direction: 'sell_base',
      side: 'from',
    })
    expect(body.invalid).toMatchObject([{ key: 'pricePath' }])
    await adminStore.close()
  })

  it('refuses a brand-new loopback draft the same way the write would', async () => {
    const { app, adminStore } = await build()
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody({ feedUrl: 'http://127.0.0.1:8080/price' }),
      direction: 'sell_base',
      side: 'from',
    })
    expect(body.invalid).toMatchObject([{ key: 'feedUrl' }])
    expect(body.samples).toEqual([])
    await adminStore.close()
  })

  it('does not refuse a grandfathered loopback feed already on disk', async () => {
    // Simulates a row admitted under the old rule: written directly, bypassing
    // the write route's own probe-and-refuse (which would reject this URL).
    const { app, adminStore } = await build()
    const loopback = marketBody({ feedUrl: 'http://127.0.0.1:8080/price' })
    await adminStore.putMarket(marketFrom(loopback))
    const { body } = await preview(app, { target: 'market', market: loopback, direction: 'sell_base', side: 'from' })
    expect(body.invalid).toEqual([])
    expect(body.feed).toMatchObject({ state: 'resolved' })
    await adminStore.close()
  })

  it('says a closed direction is closed, not silently broken', async () => {
    const { app, adminStore } = await build()
    await save(app, marketBody())
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody({ sellBase: null }),
      direction: 'sell_base',
      side: 'from',
    })
    expect(body.samples).toEqual([])
    expect(body.samplesReason).toMatch(/closed/)
    await adminStore.close()
  })

  it('prices the ladder in the payout leg when the customer names what they get', async () => {
    const { app, adminStore } = await build()
    await save(app, marketBody())
    const { body } = await preview(app, { target: 'market', market: marketBody(), direction: 'sell_base', side: 'to' })
    expect(body.invalid).toEqual([])
    const samples = body.samples as unknown as { ok: boolean; amount: string; toAmount?: string }[]
    const priced = samples.find((sample) => sample.ok)!
    expect(priced.toAmount).toBe(priced.amount)
    await adminStore.close()
  })

  it('feeds the direction-specific spread into break-even, not the market default', async () => {
    const { app, adminStore } = await build({
      policy: { offerMarkets: [], assetRfqTokens: [], assetCarrierPricing: false, offerChargesDeliveredCarrier: false },
    })
    await save(app, marketBody({ sellBaseFeeBps: 100 }))
    const { body } = await preview(app, {
      target: 'market',
      market: marketBody({ sellBaseFeeBps: 100 }),
      direction: 'sell_base',
      side: 'from',
    })
    const expected = carrierBreakEven({ carrierSats: 330n, flatSats: 0n, feeBps: 100 })
    expect(body.breakEven).toEqual(
      expected.kind === 'at' ? { kind: 'at', amountSats: expected.amountSats.toString() } : expected,
    )
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

  it('refuses overrides that are not an object of values', async () => {
    // A bare string's own character-indices are each a one-character string,
    // so without this guard 'bogus' would read as five valid entries.
    const { app, adminStore } = await build()
    const { body } = await preview(app, {
      target: 'corridor',
      corridor: 'arkade:BTC->lightning:BTC',
      overrides: 'bogus',
      side: 'from',
    })
    expect(body.invalid).toMatchObject([{ key: 'overrides' }])
    expect(body.samples).toEqual([])
    await adminStore.close()
  })

  it('refuses a non-string override value instead of silently coercing it', async () => {
    // `PATCH /api/settings` refuses a non-string value outright; this route
    // must not accept through a cast what that route would 400 on.
    const { app, adminStore } = await build()
    const { body } = await preview(app, {
      target: 'corridor',
      corridor: 'arkade:BTC->lightning:BTC',
      overrides: { LN_SEND_FEE_BPS: 25 },
      side: 'from',
    })
    expect(body.invalid).toMatchObject([{ key: 'LN_SEND_FEE_BPS' }])
    expect(body.samples).toEqual([])
    await adminStore.close()
  })

  it('prices a corridor ladder in the payout leg when the customer names what they get', async () => {
    // A zero fee makes give and payout identical regardless of which side the
    // amount names, so this needs a real spread to tell the two apart.
    const { app, adminStore } = await build()
    const { body } = await preview(app, {
      target: 'corridor',
      corridor: 'arkade:BTC->lightning:BTC',
      overrides: { LN_SEND_FEE_BPS: '500', LN_SEND_FEE_FLAT_SATS: '100' },
      side: 'to',
    })
    expect(body.invalid).toEqual([])
    const samples = body.samples as unknown as { ok: boolean; amountSats: number; payoutSats?: number }[]
    const priced = samples.find((sample) => sample.ok)!
    // `giveSatsFor` rounds up to the smallest give that clears the target, so
    // the payout it produces may exceed what was asked for, never fall short.
    expect(priced.payoutSats).toBeGreaterThanOrEqual(priced.amountSats)
    await adminStore.close()
  })

  it('never renders a negative amount when a flat fee exceeds the corridor minimum', async () => {
    const { app, adminStore } = await build()
    const { body } = await preview(app, {
      target: 'corridor',
      corridor: 'arkade:BTC->lightning:BTC',
      overrides: { LN_SEND_FEE_FLAT_SATS: '5000' },
      side: 'to',
    })
    expect(body.invalid).toEqual([])
    const samples = body.samples as unknown as { amountSats: number }[]
    expect(samples.length).toBeGreaterThan(2)
    expect(samples.every((sample) => sample.amountSats >= 0)).toBe(true)
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
