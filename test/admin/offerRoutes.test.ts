/**
 * The offers screen's data, through the assembled admin app. The two halves are
 * unlike: a FILL is a persisted row, a REFUSAL is not a row at all.
 */
import { describe, it, expect } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { createOfferRefusalTail } from '@arkade-os/solver-app/admin/offerRefusals.js'
import { OfferFillStore, OFFER_FILL_STATES } from '@arkade-os/solver-corridors/db/offerFills.js'

const USDT = 'aa'.repeat(34)

const record = (over: Record<string, unknown> = {}) => ({
  id: 'fill-1',
  offerTxid: 'ab'.repeat(32),
  offerVout: 0,
  offerPkScript: 'cc'.repeat(20),
  wantAssetId: null,
  wantAmount: 5_000n,
  offerAssetId: USDT,
  offerAmount: 1_000_000n,
  ...over,
})

const build = async (opts: { serving?: boolean } = {}) => {
  const serving = opts.serving ?? true
  const offerStore = serving ? await OfferFillStore.open(':memory:', () => 1_000_000) : null
  const offerRefusals = createOfferRefusalTail()
  const services = { offerStore, offerRefusals } as never
  return { app: buildAdminApp({ services, startedAt: 1, mode: 'relay' }), offerStore, offerRefusals }
}

const get = async (app: ReturnType<typeof buildAdminApp>, path = '/api/offers') => {
  const response = await app.fetch(new Request(`http://admin${path}`))
  return {
    status: response.status,
    body: (await response.json()) as {
      serving: boolean
      offers: Record<string, unknown>[]
      nextCursor: string | null
      refusals: { entries: Record<string, unknown>[]; ephemeral: true; capacity: number }
    },
  }
}

describe('GET /api/offers: a filled offer is visible', () => {
  it('shows a filled offer, carrying the fill txid that proves it landed', async () => {
    const { app, offerStore } = await build()
    const row = await offerStore!.insertIntent(record())
    await offerStore!.transition(row.id, 'fillable', 'filling')
    await offerStore!.transition(row.id, 'filling', 'filled', { fill_txid: 'ff'.repeat(32) })

    const { body } = await get(app)
    expect(body.offers).toHaveLength(1)
    expect(body.offers[0]).toMatchObject({ id: 'fill-1', state: 'filled', fillTxid: 'ff'.repeat(32) })
  })

  it('carries the outpoint, both legs and the amounts an operator reconciles against', async () => {
    const { app, offerStore } = await build()
    await offerStore!.insertIntent(record())

    const { body } = await get(app)
    expect(body.offers[0]).toMatchObject({
      outpoint: `${'ab'.repeat(32)}:0`,
      wantAssetId: null,
      wantAmount: '5000',
      offerAssetId: USDT,
      offerAmount: '1000000',
    })
  })

  it('reports a fill with no txid as having none rather than inventing one', async () => {
    const { app, offerStore } = await build()
    await offerStore!.insertIntent(record())

    const { body } = await get(app)
    expect(body.offers[0]?.state).toBe('fillable')
    expect(body.offers[0]?.fillTxid).toBeNull()
  })
})

describe('GET /api/offers: a refused offer is visible', () => {
  it('shows a refusal with the reason it was declined', async () => {
    const { app, offerRefusals } = await build()
    offerRefusals.record({
      at: 1_000_000,
      outpoint: `${'ab'.repeat(32)}:1`,
      reason: 'price_out_of_tolerance',
      detail: 'wants 5000 BTC for 1000000 USDT',
    })

    const { body } = await get(app)
    expect(body.refusals.entries).toHaveLength(1)
    expect(body.refusals.entries[0]).toMatchObject({
      outpoint: `${'ab'.repeat(32)}:1`,
      reason: 'price_out_of_tolerance',
      detail: 'wants 5000 BTC for 1000000 USDT',
    })
  })

  it('says the refusal list is ephemeral, so an empty one is not read as "none refused"', async () => {
    const { app } = await build()
    const { body } = await get(app)
    expect(body.refusals.ephemeral).toBe(true)
    expect(body.refusals.capacity).toBeGreaterThan(0)
  })

  it('keeps refusals even when no fill was ever recorded', async () => {
    const { app, offerRefusals } = await build()
    offerRefusals.record({ at: 1, outpoint: 'a:0', reason: 'unsupported_pair', detail: 'wants 1 BTC for 2 X' })

    const { body } = await get(app)
    expect(body.offers).toHaveLength(0)
    expect(body.refusals.entries).toHaveLength(1)
  })
})

describe('GET /api/offers: a deployment serving no market', () => {
  it('answers 200 with serving false rather than erroring on the null store', async () => {
    const { app } = await build({ serving: false })
    const { status, body } = await get(app)
    expect(status).toBe(200)
    expect(body.serving).toBe(false)
    expect(body.offers).toEqual([])
    expect(body.nextCursor).toBeNull()
  })

  it('still answers the refusal tail, which exists whether or not a store does', async () => {
    const { app, offerRefusals } = await build({ serving: false })
    offerRefusals.record({ at: 1, outpoint: 'a:0', reason: 'unsupported_pair', detail: 'wants 1 BTC for 2 X' })
    const { body } = await get(app)
    expect(body.refusals.entries).toHaveLength(1)
  })

  it('reports serving true where a store exists', async () => {
    const { app } = await build()
    const { body } = await get(app)
    expect(body.serving).toBe(true)
  })
})

describe('GET /api/offers: paging', () => {
  it('rejects a malformed limit as the caller’s mistake, not an internal fault', async () => {
    const { app } = await build()
    const response = await app.fetch(new Request('http://admin/api/offers?limit=-3'))
    expect(response.status).toBe(400)
  })

  // The bug this screen exists for is an empty view meaning two things. A typo'd
  // filter answering 200-with-nothing is that same failure one step along.
  it('refuses an unknown state rather than answering 200 with an empty list', async () => {
    const { app } = await build()
    const response = await app.fetch(new Request('http://admin/api/offers?state=fileld'))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'unknown_state', state: 'fileld' })
  })

  it('accepts every state the lifecycle actually has', async () => {
    const { app } = await build()
    for (const state of OFFER_FILL_STATES) {
      expect((await app.fetch(new Request(`http://admin/api/offers?state=${state}`))).status).toBe(200)
    }
  })

  it('filters to one state when asked', async () => {
    const { app, offerStore } = await build()
    const row = await offerStore!.insertIntent(record())
    await offerStore!.insertIntent(record({ id: 'fill-2', offerVout: 1 }))
    await offerStore!.transition(row.id, 'fillable', 'filling')

    const { body } = await get(app, '/api/offers?state=filling')
    expect(body.offers.map((offer) => offer.id)).toEqual(['fill-1'])
  })
})
