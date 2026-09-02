import { describe, it, expect, vi } from 'vitest'
import { buildAdminApp, type AdminDeps } from '../../src/admin/server.js'
import { readerSetFromDeps, type FlatCorridorDeps } from '../../src/ops/corridorSet.js'

const emptyPage = { rows: [], nextCursor: null }

const store = (over: Record<string, unknown> = {}) => ({
  page: vi.fn().mockResolvedValue(emptyPage),
  findRecoverable: vi.fn().mockResolvedValue([]),
  // The overview reads `stuck` separately: it is terminal, so `findRecoverable`
  // excludes it, and a stuck row waits for a human with nothing saying so. It
  // reads a bounded PAGE of them and the true COUNT apart, so that capping the
  // list can never understate how many are waiting.
  findByStates: vi.fn().mockResolvedValue([]),
  countByStates: vi.fn().mockResolvedValue(0),
  committedSats: vi.fn().mockResolvedValue(0),
  get: vi.fn().mockRejectedValue(new Error('no such swap')),
  history: vi.fn().mockResolvedValue([]),
  ...over,
})

const fakeServices = (over: Record<string, unknown> = {}) => {
  // Overrides applied first: cases that swap a store out need readers over the
  // store they installed.
  const stores = {
    store: store(),
    receiveStore: store(),
    onchainStore: store(),
    onchainReceiveStore: store(),
    ...over,
  }
  return {
    // What the process is currently failing on, beside what needs a human.
    tickErrors: { failing: [] },
    config: {
      network: 'regtest',
      lnBackend: 'fake',
      emulatorUrl: 'http://emulator.test',
      arkade: { arkServerUrl: 'http://ark.test' },
      maxExposedSats: 300_000,
      // The global outer bound each corridor is narrowed from. Present on the
      // real Config, so a double without it reads `undefined.maxSats` and 500s
      // the moment any route consults it.
      limits: { minSats: 1_000, maxSats: 100_000 },
      corridorEnabled: {
        'arkade:BTC->lightning:BTC': true,
        'lightning:BTC->arkade:BTC': true,
        'arkade:BTC->onchain:BTC': true,
        'onchain:BTC->arkade:BTC': true,
      },
      corridorFees: {
        'arkade:BTC->lightning:BTC': { bps: 0, flatSats: 0 },
        'lightning:BTC->arkade:BTC': { bps: 0, flatSats: 0 },
        'arkade:BTC->onchain:BTC': { bps: 0, flatSats: 0 },
        'onchain:BTC->arkade:BTC': { bps: 0, flatSats: 0 },
      },
      corridorLimits: {
        'arkade:BTC->lightning:BTC': { minSats: 1_000, maxSats: 100_000 },
        'lightning:BTC->arkade:BTC': { minSats: 1_000, maxSats: 100_000 },
        'arkade:BTC->onchain:BTC': { minSats: 1_000, maxSats: 100_000 },
        'onchain:BTC->arkade:BTC': { minSats: 1_000, maxSats: 100_000 },
      },
    },
    ...stores,
    readers: readerSetFromDeps(stores as unknown as FlatCorridorDeps),
    adminStore: { getOverrides: vi.fn().mockResolvedValue({}) },
    ln: { getBalance: vi.fn().mockResolvedValue({ availableSats: 500_000, incomingSats: 0 }) },
    arkade: {
      reservations: { reserved: () => new Set<string>() },
      wallet: {
        getBalance: vi.fn().mockResolvedValue({ total: 250_000 }),
        getAddress: vi.fn().mockResolvedValue('tark1solver'),
        // Real outpoints: `poolPlan` keys the reserved filter on them, so a
        // value-only coin yields "undefined:undefined" and would never match a
        // reservation a future test adds here.
        getSpendableVtxos: vi.fn().mockResolvedValue([{ txid: 'coin0', vout: 0, value: 300_000 }]),
        arkProvider: { getInfo: vi.fn().mockResolvedValue({ dust: 330 }) },
      },
    },
    onchain: {
      estimateFeeRate: vi.fn().mockResolvedValue(3),
      getBalance: vi.fn().mockResolvedValue({ confirmedSats: 0, unconfirmedSats: 0 }),
    },
    emulatorPubkey: 'ff'.repeat(33),
    providerPubkey: 'aa'.repeat(32),
    ...over,
  } as never
}

const app = (over: Record<string, unknown> = {}, deps: Partial<AdminDeps> = {}) =>
  buildAdminApp({ services: fakeServices(over), startedAt: 1_000_000, mode: 'relay', now: () => 1_000_042, ...deps })

const get = (path: string, over = {}, deps: Partial<AdminDeps> = {}) =>
  app(over, deps).fetch(new Request(`http://admin${path}`))

describe('GET /api/swaps', () => {
  it('merges all four corridors into one list', async () => {
    const response = await get('/api/swaps')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ swaps: [] })
  })

  it('asks only the named corridor when one is given', async () => {
    const only = store()
    const other = store()
    await get('/api/swaps?corridor=arkade%3ABTC-%3Elightning%3ABTC', { store: only, receiveStore: other })
    expect(only.page).toHaveBeenCalled()
    expect(other.page).not.toHaveBeenCalled()
  })

  it('rejects an unknown corridor with 400', async () => {
    const response = await get('/api/swaps?corridor=bogus')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'unknown_corridor' })
  })

  it('rejects an unknown phase with 400', async () => {
    expect((await get('/api/swaps?phase=sideways')).status).toBe(400)
  })

  it('turns a bad limit into 400, not an internal error', async () => {
    const failing = store({ page: vi.fn().mockRejectedValue(new Error('page limit must be a positive integer')) })
    const response = await get('/api/swaps?limit=-1', { store: failing })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'bad_request' })
  })

  it('sorts newest first across corridors', async () => {
    const send = store({
      page: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'old',
            state: 'quoted',
            createdAt: 1,
            updatedAt: 1,
            amountSats: 1,
            paymentHash: 'a',
            failureReason: null,
          },
        ],
        nextCursor: null,
      }),
    })
    const receive = store({
      page: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'new',
            state: 'quoted',
            createdAt: 99,
            updatedAt: 99,
            amountSats: 1,
            payoutSats: 1,
            paymentHash: 'b',
            failureReason: null,
          },
        ],
        nextCursor: null,
      }),
    })
    const body = (await (await get('/api/swaps', { store: send, receiveStore: receive })).json()) as {
      swaps: { id: string }[]
    }
    expect(body.swaps.map((s) => s.id)).toEqual(['new', 'old'])
  })
})

describe('GET /api/swaps/:corridor/:id', () => {
  it('404s an id no corridor has', async () => {
    expect((await get('/api/swaps/arkade%3ABTC-%3Elightning%3ABTC/nope')).status).toBe(404)
  })

  it('400s an unknown corridor rather than 404ing it', async () => {
    expect((await get('/api/swaps/bogus/whatever')).status).toBe(400)
  })

  it('returns the raw row, the projection and the timeline', async () => {
    const row = {
      id: 'a',
      state: 'claimed',
      createdAt: 1,
      updatedAt: 2,
      amountSats: 1_000,
      paymentHash: 'aa',
      failureReason: null,
    }
    const withRow = store({
      get: vi.fn().mockResolvedValue(row),
      history: vi.fn().mockResolvedValue([{ at: 1, from: null, to: 'quoted' }]),
    })
    const body = await (await get('/api/swaps/arkade%3ABTC-%3Elightning%3ABTC/a', { store: withRow })).json()
    expect(body).toMatchObject({
      swap: { id: 'a', phase: 'done', state: 'claimed' },
      history: [{ to: 'quoted' }],
    })
  })
})

describe('GET /api/backends', () => {
  it('reports a dead backend as down instead of failing the whole page', async () => {
    const ln = { getBalance: vi.fn().mockRejectedValue(new Error('lnd unreachable')) }
    const response = await get('/api/backends', { ln })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { backends: { name: string; ok: boolean; error: string | null }[] }
    expect(body.backends.find((b) => b.name === 'lightning')).toMatchObject({ ok: false })
    expect(body.backends.find((b) => b.name === 'lightning')?.error).toContain('lnd unreachable')
    // The others still answered.
    expect(body.backends.find((b) => b.name === 'arkade')?.ok).toBe(true)
  })

  it('omits the relay row entirely when there is no relay connection', async () => {
    const body = (await (await get('/api/backends')).json()) as { backends: { name: string }[] }
    expect(body.backends.map((b) => b.name)).not.toContain('relay')
  })

  it('reports a disconnected relay as down, since that is the failure nothing else shows', async () => {
    const relay = { url: 'wss://relay.test', isConnected: () => false }
    const body = (await (await get('/api/backends', {}, { relay })).json()) as {
      backends: { name: string; ok: boolean }[]
    }
    expect(body.backends.find((b) => b.name === 'relay')).toMatchObject({ ok: false })
  })
})

describe('GET /api/overview', () => {
  it('reports exposure against the cap', async () => {
    const body = await (await get('/api/overview')).json()
    expect(body).toMatchObject({
      mode: 'relay',
      network: 'regtest',
      uptimeSeconds: 42,
      exposure: { committedSats: 0, capSats: 300_000 },
    })
  })

  it('still renders when a balance backend is down', async () => {
    const ln = { getBalance: vi.fn().mockRejectedValue(new Error('down')) }
    const response = await get('/api/overview', { ln })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ balances: { lightningSats: null, lightningError: 'down' } })
  })

  it('lists all four corridors with their effective policy', async () => {
    const body = (await (await get('/api/overview')).json()) as { corridors: { corridor: string }[] }
    expect(body.corridors).toHaveLength(4)
  })
})

describe('GET /api/wallet', () => {
  it('reports the pool shape alongside the balances', async () => {
    const body = await (await get('/api/wallet')).json()
    expect(body).toMatchObject({ arkade: { address: 'tark1solver' }, onchain: { feeRate: 3 } })
  })

  it('reports a pool it could not read without failing the page', async () => {
    const arkade = {
      // Present so `poolPlan` reaches the failure this test is ABOUT — the
      // reserved filter reads the ledger first, and a fixture without it fails
      // earlier with a different message.
      reservations: { reserved: () => new Set<string>() },
      wallet: {
        getBalance: vi.fn().mockResolvedValue({ total: 1 }),
        getAddress: vi.fn().mockResolvedValue('tark1solver'),
        getSpendableVtxos: vi.fn().mockRejectedValue(new Error('indexer down')),
        arkProvider: { getInfo: vi.fn().mockResolvedValue({ dust: 330 }) },
      },
    }
    const response = await get('/api/wallet', { arkade })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ arkade: { pool: null, poolError: 'indexer down' } })
  })
})

describe('GET /api/quotes', () => {
  it('says the bid tail is ephemeral, so an empty list is not read as "no bids"', async () => {
    const body = await (await get('/api/quotes')).json()
    expect(body).toMatchObject({ quoted: [], bids: { ephemeral: true } })
  })
})
