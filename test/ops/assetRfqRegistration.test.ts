/**
 * Registering the atomic-class corridors through the composition root.
 *
 * The property that matters is the one `readerSetFromDeps`'s own doc states:
 * the reader set is deliberately WIDER than the serving set. A market whose
 * service was never built must still be READABLE, or an operator who switched
 * it off would watch its live negotiations vanish from the only screen that
 * shows them — and the status route would answer "no negotiation with this
 * rfq_id" about a live one.
 */

import { describe, it, expect } from 'vitest'
import { corridorSetFromDeps, readerSetFromDeps } from '@arkade-os/solver-app/ops/corridorSet.js'
import { readableAssetRfqMarketsFrom } from '@arkade-os/solver-app/ops/assetRfqMarkets.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { AssetRfqSwapService, type AssetRfqMarket } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'

const ASSET_A = `${'aa'.repeat(32)}0100`
const ASSET_B = `${'bb'.repeat(32)}0000`

const market = (assetId: string, symbol: string) => ({
  base: null,
  quote: assetId,
  symbol,
  baseDecimals: 8,
  quoteDecimals: 6,
  feeBps: 50,
  sellBase: { min: 1n, max: 10n ** 24n },
  buyBase: { min: 1n, max: 10n ** 24n },
  feedUrl: 'https://feed.example',
  pricePath: 'price',
  carrierSats: 0n,
})

/**
 * The four BTC corridors need stores this test does not care about. Absent
 * services mean they simply do not register, which is exactly the behaviour
 * being relied on.
 */
const base = () => ({ store: null as never, onchainStore: null as never })

const built = async () => {
  const store = await AssetRfqSwapStore.open(':memory:')
  const service = new AssetRfqSwapService({
    store,
    markets: [market(ASSET_A, 'USDA')],
    solverPubkey: 'e'.repeat(64),
    quoteValiditySeconds: 30,
    dustSats: 0n,
    fetchPrice: async () => ({ mantissa: 100_000n, scale: 0 }),
    deriveOffer: () => ({ pkScript: `5120${'d'.repeat(64)}`, address: 'ark1q' }),
    depositAt: async () => null,
    balance: async () => new Map(),
    settle: async () => 'tx',
  })
  return { store, service }
}

describe('corridorSetFromDeps — the serving set', () => {
  it('registers both directions of every configured market', async () => {
    const { store, service } = await built()
    const set = corridorSetFromDeps({
      ...base(),
      assetRfqService: service,
      assetRfqStore: store,
      assetRfqMarkets: [market(ASSET_A, 'USDA')],
    })
    expect(set.get(`arkade:BTC->arkade:${ASSET_A}`)).toBeDefined()
    expect(set.get(`arkade:${ASSET_A}->arkade:BTC`)).toBeDefined()
    await store.close()
  })

  it('registers nothing when no market is configured', async () => {
    const { store, service } = await built()
    const set = corridorSetFromDeps({ ...base(), assetRfqService: service, assetRfqStore: store })
    expect(set.size).toBe(0)
    await store.close()
  })

  /**
   * No service means the corridor was not enabled, and an absent corridor is
   * how a pair gets refused by name as `unsupported_pair` — the same rule every
   * other corridor family here follows.
   */
  it('registers nothing when the service was never built', async () => {
    const { store } = await built()
    const set = corridorSetFromDeps({
      ...base(),
      assetRfqStore: store,
      assetRfqMarkets: [market(ASSET_A, 'USDA')],
    })
    expect(set.size).toBe(0)
    await store.close()
  })

  it('refuses two markets whose symbols collide, at composition time', async () => {
    const { store, service } = await built()
    // Two different assets sharing a symbol would share an env stem, so
    // `<STEM>_ENABLED=false` would dark a corridor the operator did not name.
    expect(() =>
      corridorSetFromDeps({
        ...base(),
        assetRfqService: service,
        assetRfqStore: store,
        assetRfqMarkets: [market(ASSET_A, 'USDA'), market(ASSET_B, 'USDA')],
      }),
    ).toThrow(/duplicate corridor env stem/)
    await store.close()
  })
})

describe('readerSetFromDeps — wider than the serving set, on purpose', () => {
  it('reads a market whose service was never built', async () => {
    const { store } = await built()
    const readers = readerSetFromDeps({
      ...base(),
      assetRfqStore: store,
      assetRfqMarkets: [market(ASSET_A, 'USDA')],
    })
    expect(readers.get(`arkade:BTC->arkade:${ASSET_A}`)).toBeDefined()
    expect(readers.get(`arkade:${ASSET_A}->arkade:BTC`)).toBeDefined()
    await store.close()
  })

  it('reads nothing when there is no store at all', async () => {
    const readers = readerSetFromDeps({ ...base(), assetRfqMarkets: [market(ASSET_A, 'USDA')] })
    expect(readers.get(`arkade:BTC->arkade:${ASSET_A}`)).toBeUndefined()
  })
})

describe('a market that stopped serving keeps the rows it already holds readable', () => {
  const SELL = `arkade:BTC->arkade:${ASSET_A}`
  const BUY = `arkade:${ASSET_A}->arkade:BTC`
  const RFQ_ID = 'a'.repeat(64)

  const withLiveRow = async () => {
    const { store, service } = await built()
    await store.insertQuote({
      id: 'swap-1',
      rfqId: RFQ_ID,
      pair: SELL,
      fromAssetId: null,
      fromAmount: 100_000_000n,
      toAssetId: ASSET_A,
      toAmount: 99_500_000_000n,
      makerPkScript: `5120${'c'.repeat(64)}`,
      makerPublicKey: 'b'.repeat(64),
      offerPkScript: `5120${'d'.repeat(64)}`,
      offerAddress: 'ark1qoffer',
      solverPubkey: 'e'.repeat(64),
      validUntil: 2_000,
    })
    return { store, service }
  }

  const setsWithout = async (serving: readonly AssetRfqMarket[], store: AssetRfqSwapStore, service: unknown) => {
    const readableAssetRfqMarkets = readableAssetRfqMarketsFrom(serving, await store.listNonTerminal())
    return {
      readers: readerSetFromDeps({
        ...base(),
        assetRfqStore: store,
        assetRfqMarkets: serving,
        readableAssetRfqMarkets,
      }),
      corridors: corridorSetFromDeps({
        ...base(),
        assetRfqService: service as never,
        assetRfqStore: store,
        assetRfqMarkets: serving,
      }),
    }
  }

  it('answers statusFor for a disabled market', async () => {
    const { store, service } = await withLiveRow()
    const { readers } = await setsWithout([], store, service)
    const reader = readers.get(SELL)
    expect(reader).toBeDefined()
    expect(await reader!.statusFor(RFQ_ID)).not.toBeNull()
    await store.close()
  })

  it('pages and prices the row of a disabled market', async () => {
    const { store, service } = await withLiveRow()
    const { readers } = await setsWithout([], store, service)
    const reader = readers.get(SELL)!
    expect((await reader.page!({ limit: 10 })).swaps.map((swap) => swap.id)).toEqual(['swap-1'])
    // `ledgerRows` filters on `updated_at`, which `built()` stamps from the real clock.
    const ledger = await reader.economics!({ since: 0, until: Math.floor(Date.now() / 1000) + 60, limit: 10 })
    expect(ledger.records.map((record) => record.id)).toEqual(['swap-1'])
    await store.close()
  })

  it('registers both directions, so the reverse pair is answerable too', async () => {
    const { store, service } = await withLiveRow()
    const { readers } = await setsWithout([], store, service)
    expect(readers.get(BUY)).toBeDefined()
    await store.close()
  })

  /** Readable is not servable — the constraint the recovery must not breach. */
  it('still refuses a new quote on a disabled market', async () => {
    const { store, service } = await withLiveRow()
    const { corridors } = await setsWithout([], store, service)
    expect(corridors.get(SELL)).toBeUndefined()
    expect(corridors.get(BUY)).toBeUndefined()
    expect(corridors.size).toBe(0)
    await store.close()
  })

  /** DELETED, not merely disabled: no `admin_market` row survives, so the row's legs are all that is left. */
  it('reads a deleted market, whose configuration is gone entirely', async () => {
    const { store, service } = await withLiveRow()
    const { readers, corridors } = await setsWithout([market(ASSET_B, 'USDB')], store, service)
    const reader = readers.get(SELL)
    expect(reader).toBeDefined()
    expect(await reader!.statusFor(RFQ_ID)).not.toBeNull()
    expect(corridors.get(SELL)).toBeUndefined()
    await store.close()
  })

  it('stops reading it once the row reaches a terminal state', async () => {
    const { store, service } = await withLiveRow()
    await store.fail('swap-1', 'quoted', 'lapsed')
    const { readers } = await setsWithout([], store, service)
    expect(readers.get(SELL)).toBeUndefined()
    await store.close()
  })
})
