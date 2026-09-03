/**
 * The market CRUD surface, through the assembled admin app.
 *
 * Two things get the most attention, and both are about what must NOT be
 * storable:
 *
 * - a spread at or past 10000 bps, which is the price gate switched off. The
 *   runtime refuses it on every offer; this route has to refuse it while the
 *   operator is still looking at the form, or the console shows a healthy market
 *   that quietly fills nothing.
 * - a feed that does not answer with a price at the given pointer. Well-formed
 *   is not the same as readable, and only the second claim is worth anything.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { assetMarketKey } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { priceFrom } from '@arkade-os/solver-core/core/priceFeed.js'

const USDT = 'aa'.repeat(34)
const KEY = assetMarketKey(null, USDT)

const body = (over: Record<string, unknown> = {}) => ({
  base: 'BTC',
  quote: USDT,
  baseDecimals: 8,
  quoteDecimals: 6,
  feedUrl: 'https://feed.test/price',
  pricePath: '/price',
  toleranceBps: 10,
  feeBps: 25,
  ...over,
})

const build = async (opts: { active?: { base: string | null; quote: string | null }[]; feedFails?: boolean } = {}) => {
  const adminStore = await AdminStore.open(':memory:', () => 1_000_000)
  const fetchPrice = vi.fn(async () => {
    if (opts.feedFails) throw new Error('HTTP 503 Service Unavailable')
    return priceFrom('100000')
  })
  const services = { config: {}, adminStore, assetMarkets: opts.active ?? [] } as never
  const app = buildAdminApp({ services, startedAt: 1, mode: 'relay', fetchPrice })
  return { app, adminStore, fetchPrice }
}

const put = (app: ReturnType<typeof buildAdminApp>, payload: unknown) =>
  app.fetch(
    new Request('http://admin/api/markets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )

const list = async (app: ReturnType<typeof buildAdminApp>) =>
  (await (await app.fetch(new Request('http://admin/api/markets'))).json()) as {
    markets: Record<string, unknown>[]
    active: string[]
    restartNotice: string
  }

describe('GET /api/markets', () => {
  it('answers an empty set on a deployment that has configured none', async () => {
    const { app, adminStore } = await build()
    const seen = await list(app)
    expect(seen.markets).toEqual([])
    expect(seen.active).toEqual([])
    await adminStore.close()
  })

  it('says a stored market is not in force until the solver restarts', async () => {
    const { app, adminStore } = await build()
    await put(app, body())
    const seen = await list(app)
    expect(seen.markets).toHaveLength(1)
    // Stored but NOT active: this process was built before the row existed.
    expect(seen.active).toEqual([])
    expect(seen.restartNotice).toMatch(/restarts/)
    await adminStore.close()
  })

  it('reports the markets THIS process is trading, keyed the same way', async () => {
    const { app, adminStore } = await build({ active: [{ base: null, quote: USDT }] })
    expect((await list(app)).active).toEqual([KEY])
    await adminStore.close()
  })

  it('renders bounds as decimal strings, never as JSON numbers', async () => {
    // A bigint does not survive JSON.stringify — it throws — and a number would
    // lose an atomic-unit ceiling past 2^53 silently.
    const { app, adminStore } = await build()
    await put(app, body({ buyBase: { min: '0', max: '123456789012345678901234567890' } }))
    const [market] = (await list(app)).markets
    expect(market!.buyBase).toEqual({ min: '0', max: '123456789012345678901234567890' })
    await adminStore.close()
  })
})

describe('PUT /api/markets', () => {
  it('stores a market and says it needs a restart', async () => {
    const { app, adminStore } = await build()
    const response = await put(app, body())
    expect(response.status).toBe(200)
    const answered = (await response.json()) as { market: { marketKey: string }; restartRequired: boolean }
    expect(answered.market.marketKey).toBe(KEY)
    expect(answered.restartRequired).toBe(true)
    expect(await adminStore.getMarket(KEY)).not.toBeNull()
    await adminStore.close()
  })

  it('normalises the BTC leg to null, so one pair cannot be stored under two spellings', async () => {
    const { app, adminStore } = await build()
    await put(app, body({ base: 'BTC' }))
    await put(app, body({ base: 'btc' }))
    await put(app, body({ base: '' }))
    await put(app, body({ base: null }))
    expect(await adminStore.listMarkets()).toHaveLength(1)
    await adminStore.close()
  })

  it('edits in place when the same pair is submitted again', async () => {
    const { app, adminStore } = await build()
    await put(app, body({ feeBps: 25 }))
    await put(app, body({ feeBps: 50 }))
    const rows = await adminStore.listMarkets()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.feeBps).toBe(50)
    await adminStore.close()
  })

  it('defaults a market to enabled, because configuring one is the opt-in', async () => {
    const { app, adminStore } = await build()
    await put(app, body())
    expect((await adminStore.getMarket(KEY))!.enabled).toBe(true)
    await adminStore.close()
  })

  it('records the write in the audit log, because a spread is a money decision', async () => {
    const { app, adminStore } = await build()
    await put(app, body())
    const [entry] = await adminStore.listActions()
    expect(entry).toMatchObject({ action: 'market-put', target: KEY, outcome: 'ok' })
    await adminStore.close()
  })

  it('rejects a body that is not JSON', async () => {
    const { app, adminStore } = await build()
    const response = await app.fetch(
      new Request('http://admin/api/markets', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    )
    expect(response.status).toBe(400)
    await adminStore.close()
  })
})

describe('PUT refuses what the runtime would refuse', () => {
  const refusal = async (payload: unknown) => {
    const { app, adminStore } = await build()
    const response = await put(app, payload)
    const answered = (await response.json()) as { error: string; message: string }
    const stored = await adminStore.listMarkets()
    await adminStore.close()
    return { status: response.status, ...answered, stored }
  }

  for (const key of ['toleranceBps', 'feeBps'] as const) {
    it(`refuses ${key} at exactly 10000 — the price gate switched off — and stores nothing`, async () => {
      const seen = await refusal(body({ [key]: 10_000 }))
      expect(seen.status).toBe(400)
      expect(seen.message).toMatch(/switched off/)
      // The half that matters: a refused market must not be on disk looking
      // configured while the runtime declines every offer against it.
      expect(seen.stored).toEqual([])
    })

    it(`refuses a negative ${key}`, async () => {
      expect((await refusal(body({ [key]: -1 }))).status).toBe(400)
    })

    it(`admits ${key} at 9999, one below the ceiling`, async () => {
      expect((await refusal(body({ [key]: 9_999 }))).status).toBe(200)
    })
  }

  it('refuses an asset id of the wrong length', async () => {
    const seen = await refusal(body({ quote: 'aa'.repeat(32) }))
    expect(seen.status).toBe(400)
    expect(seen.stored).toEqual([])
  })

  it('refuses a market whose legs are the same thing', async () => {
    expect((await refusal(body({ base: USDT, quote: USDT }))).status).toBe(400)
  })

  it('refuses a non-integer where an integer is required', async () => {
    expect((await refusal(body({ baseDecimals: '8' }))).status).toBe(400)
    expect((await refusal(body({ toleranceBps: 1.5 }))).status).toBe(400)
  })

  it('refuses a half-stated bound, which reads as a bound and is not one', async () => {
    expect((await refusal(body({ sellBase: { min: '1' } }))).status).toBe(400)
  })

  it('refuses a bound sent as a JSON number rather than a decimal string', async () => {
    expect((await refusal(body({ sellBase: { min: 1, max: 2 } }))).status).toBe(400)
  })

  it('refuses a feed URL that is not http or https', async () => {
    expect((await refusal(body({ feedUrl: 'file:///etc/passwd' }))).status).toBe(400)
  })

  it('refuses a price path that is not a JSON pointer', async () => {
    expect((await refusal(body({ pricePath: 'price' }))).status).toBe(400)
  })
})

describe('the feed probe', () => {
  it('reads the feed before storing, using the same reader the offer path uses', async () => {
    const { app, adminStore, fetchPrice } = await build()
    await put(app, body())
    expect(fetchPrice).toHaveBeenCalledWith('https://feed.test/price', '/price')
    await adminStore.close()
  })

  it('refuses a market whose feed does not answer, and stores nothing', async () => {
    const { app, adminStore } = await build({ feedFails: true })
    const response = await put(app, body())
    expect(response.status).toBe(400)
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'feed_unreadable' })
    // Otherwise the console would list a pair this solver advertises and never
    // fills, discovered days later by its absence.
    expect(await adminStore.listMarkets()).toEqual([])
    await adminStore.close()
  })

  it('does not spend a request on a market the structural rules already refuse', async () => {
    const { app, adminStore, fetchPrice } = await build()
    await put(app, body({ toleranceBps: 10_000 }))
    expect(fetchPrice).not.toHaveBeenCalled()
    await adminStore.close()
  })
})

describe('DELETE /api/markets/:key', () => {
  it('removes a market and says a restart is needed', async () => {
    const { app, adminStore } = await build()
    await put(app, body())
    const response = await app.fetch(
      new Request(`http://admin/api/markets/${encodeURIComponent(KEY)}`, { method: 'DELETE' }),
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as { restartRequired: boolean }).toMatchObject({ restartRequired: true })
    expect(await adminStore.listMarkets()).toEqual([])
    await adminStore.close()
  })

  it('answers 404 for a key nothing is filed under, rather than a silent success', async () => {
    const { app, adminStore } = await build()
    const response = await app.fetch(new Request('http://admin/api/markets/nope', { method: 'DELETE' }))
    expect(response.status).toBe(404)
    await adminStore.close()
  })

  it('records the delete in the audit log', async () => {
    const { app, adminStore } = await build()
    await put(app, body())
    await app.fetch(new Request(`http://admin/api/markets/${encodeURIComponent(KEY)}`, { method: 'DELETE' }))
    expect((await adminStore.listActions())[0]).toMatchObject({ action: 'market-delete', target: KEY })
    await adminStore.close()
  })
})
