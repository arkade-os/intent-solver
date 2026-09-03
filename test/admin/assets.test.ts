/**
 * The console's view of Arkade asset holdings.
 *
 * The first describe is a REGRESSION GUARD on a live outage rather than a new
 * feature's happy path: `WalletBalance.assets[].amount` is a `bigint`, `c.json` is
 * `JSON.stringify`, and `JSON.stringify` throws on a bigint instead of skipping it.
 * Before this, a solver holding any asset answered
 * `500 Do not know how to serialize a BigInt` on BOTH `/api/overview` and
 * `/api/wallet` — and the client fetches the overview on every view, so the whole
 * console was dark for exactly the operator running the asset-offer corridor.
 *
 * Asserted through the REAL routes, not against the projection helper alone. The bug
 * lived in the seam between a helper that returned a fine object and a serialiser that
 * refused it, and a test that only called the helper would have passed throughout.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildAdminApp, type AdminDeps } from '@arkade-os/solver-app/admin/server.js'
import { consoleBalance, describeAssets, resetAssetMetadata, shortAssetId } from '@arkade-os/solver-app/admin/assets.js'
import { readerSetFromDeps, type FlatCorridorDeps } from '@arkade-os/solver-app/ops/corridorSet.js'

const ASSET = `46dc44798d${'0'.repeat(54)}0000`
const OTHER = `99ff1122aa${'0'.repeat(54)}beef`

const emptyPage = { rows: [], nextCursor: null }

const store = () => ({
  page: vi.fn().mockResolvedValue(emptyPage),
  findRecoverable: vi.fn().mockResolvedValue([]),
  findByStates: vi.fn().mockResolvedValue([]),
  countByStates: vi.fn().mockResolvedValue(0),
  committedSats: vi.fn().mockResolvedValue(0),
  get: vi.fn().mockRejectedValue(new Error('no such swap')),
  history: vi.fn().mockResolvedValue([]),
})

const corridorMap = <T>(value: T) => ({
  'arkade:BTC->lightning:BTC': value,
  'lightning:BTC->arkade:BTC': value,
  'arkade:BTC->onchain:BTC': value,
  'onchain:BTC->arkade:BTC': value,
})

/** A balance shaped as the SDK returns one — asset amounts as `bigint`. */
const balanceWith = (assets: { assetId: string; amount: bigint }[], available = assets) => ({
  boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
  settled: 250_000,
  preconfirmed: 0,
  available: 250_000,
  gated: 0,
  intentLocked: 0,
  recoverable: 0,
  pendingRecovery: 0,
  unrolled: 0,
  total: 250_000,
  assets,
  availableAssets: available,
})

const fakeServices = (over: { balance?: unknown; assetManager?: unknown; vtxos?: unknown[] } = {}) => {
  const stores = {
    store: store(),
    receiveStore: store(),
    onchainStore: store(),
    onchainReceiveStore: store(),
  }
  return {
    tickErrors: { failing: [] },
    config: {
      network: 'regtest',
      lnBackend: 'fake',
      emulatorUrl: 'http://emulator.test',
      arkade: { arkServerUrl: 'http://ark.test' },
      maxExposedSats: 300_000,
      limits: { minSats: 1_000, maxSats: 100_000 },
      corridorEnabled: corridorMap(true),
      corridorFees: corridorMap({ bps: 0, flatSats: 0 }),
      corridorLimits: corridorMap({ minSats: 1_000, maxSats: 100_000 }),
    },
    ...stores,
    readers: readerSetFromDeps(stores as unknown as FlatCorridorDeps),
    adminStore: { getOverrides: vi.fn().mockResolvedValue({}) },
    ln: { getBalance: vi.fn().mockResolvedValue({ availableSats: 500_000, incomingSats: 0 }) },
    arkade: {
      reservations: { reserved: () => new Set<string>() },
      wallet: {
        getBalance: vi.fn().mockResolvedValue(over.balance ?? balanceWith([{ assetId: ASSET, amount: 1000n }])),
        getAddress: vi.fn().mockResolvedValue('tark1solver'),
        getSpendableVtxos: vi.fn().mockResolvedValue(over.vtxos ?? [{ txid: 'coin0', vout: 0, value: 300_000 }]),
        arkProvider: { getInfo: vi.fn().mockResolvedValue({ dust: 330 }) },
        ...(over.assetManager === undefined ? {} : { assetManager: over.assetManager }),
      },
    },
    onchain: {
      estimateFeeRate: vi.fn().mockResolvedValue(3),
      getBalance: vi.fn().mockResolvedValue({ confirmedSats: 0, unconfirmedSats: 0 }),
    },
    emulatorPubkey: 'ff'.repeat(33),
    providerPubkey: 'aa'.repeat(32),
  } as never
}

const get = (path: string, over = {}, deps: Partial<AdminDeps> = {}) =>
  buildAdminApp({
    services: fakeServices(over),
    startedAt: 1_000_000,
    mode: 'relay',
    now: () => 1_000_042,
    ...deps,
  }).fetch(new Request(`http://admin${path}`))

beforeEach(() => resetAssetMetadata())

describe('a wallet holding an asset does not take the console down', () => {
  it('answers /api/wallet rather than 500ing on the bigint', async () => {
    const response = await get('/api/wallet')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { arkade: { balance: { availableAssets: { amount: string }[] } } }
    expect(body.arkade.balance.availableAssets[0]?.amount).toBe('1000')
  })

  it('answers /api/overview, which the client loads on EVERY view', async () => {
    const response = await get('/api/overview')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { balances: { arkade: { assets: { assetId: string }[] } } }
    expect(body.balances.arkade.assets[0]?.assetId).toBe(ASSET)
  })

  it('carries the amount as a STRING, since an asset supply overflows a double', async () => {
    // Past `Number.MAX_SAFE_INTEGER` on purpose: a `Number()` projection would round
    // this to ...992 and report a balance the solver does not hold.
    const huge = 9_007_199_254_740_993n
    const body = (await (
      await get('/api/wallet', { balance: balanceWith([{ assetId: ASSET, amount: huge }]) })
    ).json()) as { arkade: { balance: { assets: { amount: string }[] } } }
    expect(body.arkade.balance.assets[0]?.amount).toBe('9007199254740993')
  })
})

/**
 * The constraint the whole change is held to: a solver that has never touched an
 * asset must render exactly as it did. Asserted on the wire, not on a helper.
 */
describe('a wallet holding no asset is unchanged', () => {
  it('reports empty asset lists and untouched sat buckets', async () => {
    const body = (await (await get('/api/wallet', { balance: balanceWith([]) })).json()) as {
      arkade: { balance: Record<string, unknown> }
    }
    expect(body.arkade.balance.assets).toEqual([])
    expect(body.arkade.balance.availableAssets).toEqual([])
    expect(body.arkade.balance.available).toBe(250_000)
    expect(body.arkade.balance.total).toBe(250_000)
    expect(body.arkade.balance.boarding).toEqual({ confirmed: 0, unconfirmed: 0, total: 0 })
  })

  it('reports nothing encumbered on the pool', async () => {
    const body = (await (await get('/api/wallet', { balance: balanceWith([]) })).json()) as {
      arkade: { pool: { pieces: number[]; assetEncumberedSats: number; assetBearingPieces: number } }
    }
    expect(body.arkade.pool.pieces).toEqual([300_000])
    expect(body.arkade.pool.assetEncumberedSats).toBe(0)
    expect(body.arkade.pool.assetBearingPieces).toBe(0)
  })
})

describe('shortAssetId', () => {
  it('keeps both ends, because ids sharing a prefix are not unusual', () => {
    expect(shortAssetId(ASSET)).toBe('46dc4479…0000')
    // Head AND tail: a prefix-only form would render these two as the same asset.
    expect(shortAssetId(`46dc4479${'1'.repeat(56)}`)).not.toBe(shortAssetId(ASSET))
  })

  it('leaves a short id alone rather than making it longer', () => {
    expect(shortAssetId('abc')).toBe('abc')
  })
})

describe('asset metadata', () => {
  const details = (metadata: Record<string, unknown>) => ({ assetId: ASSET, supply: 1000n, metadata })

  it('labels an asset on the read AFTER the one that warmed it', async () => {
    const getAssetDetails = vi.fn().mockResolvedValue(details({ ticker: 'USDX', decimals: 6 }))
    const assets = [{ assetId: ASSET, amount: 1000n }]

    // The request path is a pure cache read, so the first call cannot have a label.
    expect(describeAssets(assets, { getAssetDetails })[0]?.ticker).toBeUndefined()
    await vi.waitFor(() => expect(getAssetDetails).toHaveBeenCalledWith(ASSET))
    const labelled = describeAssets(assets, { getAssetDetails })[0]
    expect(labelled?.ticker).toBe('USDX')
    expect(labelled?.decimals).toBe(6)
  })

  it('never applies decimals to the amount, which stays base units', async () => {
    const getAssetDetails = vi.fn().mockResolvedValue(details({ ticker: 'USDX', decimals: 6 }))
    const assets = [{ assetId: ASSET, amount: 1_000_000n }]
    describeAssets(assets, { getAssetDetails })
    await vi.waitFor(() => expect(getAssetDetails).toHaveBeenCalled())
    // An offer names `wantAmount` in base units and `offerInventoryFrom` compares base
    // units, so a scaled `1` here is a figure an operator would read as covering a
    // request for 1_000_000 and be wrong by 10**6.
    expect(describeAssets(assets, { getAssetDetails })[0]?.amount).toBe('1000000')
  })

  it('fetches an id once per process however often it is read', async () => {
    const getAssetDetails = vi.fn().mockResolvedValue(details({ ticker: 'USDX' }))
    const assets = [{ assetId: ASSET, amount: 1n }]
    describeAssets(assets, { getAssetDetails })
    await vi.waitFor(() => expect(getAssetDetails).toHaveBeenCalledTimes(1))
    // Awaited between reads ON PURPOSE. Back-to-back synchronous reads are all held
    // off by the in-flight guard alone, so a burst would pass even with no cache at
    // all — and the case that matters is the NEXT request, a tick later, with the
    // first fetch long since settled.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
      describeAssets(assets, { getAssetDetails })
    }
    expect(getAssetDetails).toHaveBeenCalledTimes(1)
  })

  it('starts one fetch, not one per concurrent read, while the first is in flight', () => {
    // Never resolves: the `inFlight` guard is the only thing stopping a page opened
    // against a slow indexer from fanning out a request per render.
    const getAssetDetails = vi.fn().mockReturnValue(new Promise(() => {}))
    const assets = [{ assetId: ASSET, amount: 1n }]
    for (let i = 0; i < 4; i++) describeAssets(assets, { getAssetDetails })
    expect(getAssetDetails).toHaveBeenCalledTimes(1)
  })

  it('caches an asset that HAS no metadata, since absent is final for an immutable field', async () => {
    const getAssetDetails = vi.fn().mockResolvedValue({ assetId: ASSET, supply: 1n })
    const assets = [{ assetId: ASSET, amount: 1n }]
    describeAssets(assets, { getAssetDetails })
    await vi.waitFor(() => expect(getAssetDetails).toHaveBeenCalledTimes(1))
    describeAssets(assets, { getAssetDetails })
    expect(getAssetDetails).toHaveBeenCalledTimes(1)
  })

  it('renders the id when the indexer refuses, and retries later rather than caching the failure', async () => {
    const getAssetDetails = vi.fn().mockRejectedValue(new Error('indexer down'))
    const assets = [{ assetId: ASSET, amount: 7n }]
    const first = describeAssets(assets, { getAssetDetails })[0]
    expect(first?.amount).toBe('7')
    expect(first?.shortId).toBe('46dc4479…0000')
    // Re-read inside the poll because the in-flight guard clears on the rejected
    // promise's `finally`, which lands after the call itself. Were the failure cached,
    // this would sit at one call however long it polled.
    await vi.waitFor(() => {
      describeAssets(assets, { getAssetDetails })
      expect(getAssetDetails).toHaveBeenCalledTimes(2)
    })
  })

  it('keeps a route answering when the wallet exposes no asset manager at all', async () => {
    const response = await get('/api/wallet', { assetManager: null })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { arkade: { balance: { assets: { shortId: string }[] } } }
    expect(body.arkade.balance.assets[0]?.shortId).toBe('46dc4479…0000')
  })

  it('keeps a route answering when the manager exists but cannot answer this call', async () => {
    // The harder half of the same guard, and the one a `null` check alone misses: a
    // present-but-narrower manager passes a truthiness test and then throws
    // `getAssetDetails is not a function` straight through the route as a 500.
    const response = await get('/api/wallet', { assetManager: {} })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { arkade: { balance: { assets: { amount: string }[] } } }
    expect(body.arkade.balance.assets[0]?.amount).toBe('1000')
  })

  it('labels each id from its own entry rather than the first one fetched', async () => {
    const getAssetDetails = vi.fn(async (id: string) => ({
      assetId: id,
      supply: 1n,
      metadata: { ticker: id === ASSET ? 'AAA' : 'BBB' },
    }))
    const assets = [
      { assetId: ASSET, amount: 1n },
      { assetId: OTHER, amount: 2n },
    ]
    describeAssets(assets, { getAssetDetails })
    await vi.waitFor(() => expect(getAssetDetails).toHaveBeenCalledTimes(2))
    const labelled = describeAssets(assets, { getAssetDetails })
    expect(labelled.map((asset) => asset.ticker)).toEqual(['AAA', 'BBB'])
  })
})

describe('consoleBalance', () => {
  it('converts a bigint nested anywhere, not just the two fields known today', () => {
    // Generic on purpose: naming `assets`/`availableAssets` would be shorter and would
    // hand the console another 500 the next time the SDK adds a bigint field.
    const balance = { ...balanceWith([]), future: { deep: [{ n: 5n }] } } as never
    expect(JSON.stringify(consoleBalance(balance))).toContain('"n":"5"')
  })
})
