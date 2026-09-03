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
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { AssetRfqSwapService } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'

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
