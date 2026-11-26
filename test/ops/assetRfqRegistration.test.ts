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

import { describe, it, expect, vi } from 'vitest'
import { asset } from '@arkade-os/sdk'
import { ASSET_SWAP_CONTRACT_VERSIONS, arkadeSwapRequest } from '@arkade-os/swap/protocol'
import { hex } from '@scure/base'
import {
  corridorSetFromDeps,
  readerSetFromDeps,
  servedContractVersions,
} from '@arkade-os/solver-app/ops/corridorSet.js'
import { recoverReadableMarkets } from '@arkade-os/solver-app/ops/assetRfqMarkets.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { AssetRfqSwapService, type AssetRfqDeps } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import {
  RFQ_ASSET_SWAP_V2,
  RFQ_ASSET_SWAP_DIRECTED,
  RFQ_ASSET_SWAP_DIRECTED_NONCE,
  RFQ_ASSET_SWAP_DIRECTED_NONCE_V2,
} from '@arkade-os/solver-core/core/rfqContract.js'

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

const built = async (over: Partial<AssetRfqDeps> = {}) => {
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
    ...over,
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
    expect(set.get(`arkade:BTC->arkade:${ASSET_A}`)?.descriptor.contractVersion).toBe(RFQ_ASSET_SWAP_V2)
    await store.close()
  })

  it('refuses the directed covenant when an operator list names only v2 and v3', async () => {
    const { store, service } = await built()
    const pair = `arkade:BTC->arkade:${ASSET_A}`
    const set = corridorSetFromDeps({
      ...base(),
      assetRfqService: service,
      assetRfqStore: store,
      assetRfqMarkets: [market(ASSET_A, 'USDA')],
      rfqContractVersions: new Set(['asset-swap-v2', 'asset-swap-v3']),
    })
    const outcome = await set
      .get(pair)!
      .quote({ v: 1, type: 'rfq_request', rfq_id: 'a'.repeat(64), contract_versions: [RFQ_ASSET_SWAP_DIRECTED] })
    expect(outcome.kind).toBe('refused')
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_payload', error_code: 'contract_version_unsupported' })
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

describe('asset RFQ negotiates only directed covenants', () => {
  const PAIR = `arkade:BTC->arkade:${ASSET_A}`
  const RFQ_ID = 'a'.repeat(64)
  const request = (over: Record<string, unknown> = {}) => ({
    v: 1,
    type: 'rfq_request',
    rfq_id: RFQ_ID,
    pair: PAIR,
    amount_side: 'from',
    amount: '100000000',
    profile: { maker_pk_script: `5120${'c'.repeat(64)}`, maker_public_key: 'b'.repeat(64) },
    ...over,
  })

  /** Served as an unset `rfq.contractVersions` serves it: the build defaults. */
  const serving = async () => {
    const derived: (string | undefined)[] = []
    const { store, service } = await built({
      balance: async () => new Map([[ASSET_A, 10n ** 18n]]),
      deriveOffer: (terms, version) => {
        expect(terms.rfqId).toBe(RFQ_ID)
        derived.push(version)
        return { pkScript: `5120${'d'.repeat(64)}`, address: 'ark1q' }
      },
    })
    const corridorFor = (versions: readonly string[] | null) =>
      corridorSetFromDeps({
        ...base(),
        assetRfqService: service,
        assetRfqStore: store,
        assetRfqMarkets: [market(ASSET_A, 'USDA')],
        rfqContractVersions: servedContractVersions(versions, []),
      }).get(PAIR)!
    return { store, derived, corridor: corridorFor(null), corridorFor }
  }

  it('refuses a request that does not negotiate, and says which version it needs', async () => {
    const { store, derived, corridor } = await serving()
    const outcome = await corridor.quote(request())
    expect(outcome).toMatchObject({ kind: 'refused', payload: { reason: 'unsupported_pair' } })
    expect(outcome.detail).toMatch(/negotiation/)
    expect(outcome.detail).toContain(RFQ_ASSET_SWAP_DIRECTED)
    expect(derived).toEqual([])
    expect(await store.findByRfqId(RFQ_ID)).toBeNull()
    await store.close()
  })

  it('refuses a client that can derive only v3 and v2', async () => {
    const { store, derived, corridor } = await serving()
    const outcome = await corridor.quote(request({ contract_versions: ['asset-swap-v3', 'asset-swap-v2'] }))
    expect(outcome).toMatchObject({
      kind: 'refused',
      payload: {
        reason: 'unsupported_payload',
        error_code: 'contract_version_unsupported',
        field: 'contract_versions',
      },
    })
    expect(derived).toEqual([])
    await store.close()
  })

  it.each([
    ['a nonce-capable client', [RFQ_ASSET_SWAP_DIRECTED_NONCE, RFQ_ASSET_SWAP_DIRECTED], RFQ_ASSET_SWAP_DIRECTED_NONCE],
    ['an older client', [RFQ_ASSET_SWAP_DIRECTED], RFQ_ASSET_SWAP_DIRECTED],
    ["the swap client's default order", ASSET_SWAP_CONTRACT_VERSIONS, RFQ_ASSET_SWAP_DIRECTED_NONCE],
    [
      'a client preferring the single-key covenant',
      [RFQ_ASSET_SWAP_DIRECTED_NONCE_V2, RFQ_ASSET_SWAP_DIRECTED_NONCE, RFQ_ASSET_SWAP_DIRECTED],
      RFQ_ASSET_SWAP_DIRECTED_NONCE_V2,
    ],
    ['a single-key-only client', [RFQ_ASSET_SWAP_DIRECTED_NONCE_V2], RFQ_ASSET_SWAP_DIRECTED_NONCE_V2],
  ])('selects and records the version for %s', async (_client, wanted, version) => {
    const { store, derived, corridor, corridorFor } = await serving()
    const outcome = await corridor.quote(request({ contract_versions: wanted }))
    expect(outcome).toMatchObject({ kind: 'quote', payload: { contract_version: version } })
    expect(derived).toEqual([version])
    expect((await store.findByRfqId(RFQ_ID))?.contractVersion).toBe(version)

    const otherVersion = version === RFQ_ASSET_SWAP_DIRECTED ? RFQ_ASSET_SWAP_DIRECTED_NONCE : RFQ_ASSET_SWAP_DIRECTED
    const narrowed = corridorFor([otherVersion])
    const next = await narrowed.quote(request({ contract_versions: [version] }))
    expect(next).toMatchObject({ kind: 'refused', payload: { error_code: 'contract_version_unsupported' } })
    expect(await narrowed.statusFor(RFQ_ID)).toMatchObject({ type: 'rfq_status', state: 'quoted' })
    await store.close()
  })

  it('quotes the single-key covenant on a co-signer key it never builds on, and refuses that key for the nonce one', async () => {
    const { store, corridor } = await serving()
    const fromClient = (rfqId: string, contractVersions: readonly string[]) =>
      arkadeSwapRequest({
        rfqId,
        wantAsset: asset.AssetId.fromString(ASSET_A),
        amount: 100_000_000n,
        makerPkScript: `5120${'c'.repeat(64)}`,
        makerPublicKey: 'b'.repeat(64),
        contractVersions,
        emulatorPubkey: hex.decode('a1'.repeat(32)),
      })

    expect(await corridor.quote(fromClient(RFQ_ID, [RFQ_ASSET_SWAP_DIRECTED_NONCE_V2]))).toMatchObject({
      kind: 'quote',
      payload: { contract_version: RFQ_ASSET_SWAP_DIRECTED_NONCE_V2 },
    })
    expect(await corridor.quote(fromClient('b'.repeat(64), [RFQ_ASSET_SWAP_DIRECTED_NONCE]))).toMatchObject({
      kind: 'refused',
      payload: { error_code: 'unsupported_emulator_pubkey' },
    })
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

/**
 * #193 widened the READER set so a live negotiation survives its market being
 * switched off; widening the SERVING set too would re-open quoting on it.
 */
describe('a market that stopped serving keeps its readers, never its corridors', () => {
  const withLiveRow = async () => {
    const made = await built()
    await made.store.insertQuote({
      id: 'swap-1',
      rfqId: 'a'.repeat(64),
      pair: `arkade:BTC->arkade:${ASSET_A}`,
      fromAssetId: null,
      fromAmount: 100_000_000n,
      toAssetId: ASSET_A,
      toAmount: 99_500_000n,
      makerPkScript: `5120${'c'.repeat(64)}`,
      makerPublicKey: 'b'.repeat(64),
      offerPkScript: `5120${'d'.repeat(64)}`,
      offerAddress: 'ark1qoffer',
      solverPubkey: 'e'.repeat(64),
      validUntil: 2_000,
    })
    return made
  }

  /** The composition root's split, with the console row gone. */
  const setsWithNothingServed = async (store: AssetRfqSwapStore, service: AssetRfqSwapService) => {
    const shared = { ...base(), assetRfqService: service, assetRfqStore: store }
    return {
      corridors: corridorSetFromDeps({ ...shared, assetRfqMarkets: [] }),
      readers: readerSetFromDeps({
        ...shared,
        assetRfqMarkets: recoverReadableMarkets([], await store.listNonTerminal()),
      }),
    }
  }

  it('still refuses a new quote on a disabled market', async () => {
    const { store, service } = await withLiveRow()
    const { corridors, readers } = await setsWithNothingServed(store, service)
    expect(readers.get(`arkade:BTC->arkade:${ASSET_A}`)).toBeDefined()
    expect(readers.get(`arkade:${ASSET_A}->arkade:BTC`)).toBeDefined()
    expect(corridors.get(`arkade:BTC->arkade:${ASSET_A}`)).toBeUndefined()
    expect(corridors.get(`arkade:${ASSET_A}->arkade:BTC`)).toBeUndefined()
    expect(corridors.size).toBe(0)
    await store.close()
  })
})

/** mutinynet holds two such rows, both `refused`. */
describe('a stored asset-swap-v3 row, which this build no longer derives', () => {
  it('stays inert at boot, in the sweep, the watch loop, the status route and the console', async () => {
    const deriveOffer = vi.fn(() => ({ pkScript: `5120${'d'.repeat(64)}`, address: 'ark1q' }))
    const depositAt = vi.fn(async () => null)
    const settle = vi.fn(async () => 'tx')
    const { store, service } = await built({ deriveOffer, depositAt, settle })
    const pair = `arkade:BTC->arkade:${ASSET_A}`
    await store.insertQuote({
      id: 'swap-v3',
      rfqId: 'c'.repeat(64),
      pair,
      fromAssetId: null,
      fromAmount: 100_000_000n,
      toAssetId: ASSET_A,
      toAmount: 99_500_000n,
      makerPkScript: `5120${'c'.repeat(64)}`,
      makerPublicKey: 'b'.repeat(64),
      offerPkScript: `5120${'f'.repeat(64)}`,
      offerAddress: 'ark1qv3',
      solverPubkey: 'e'.repeat(64),
      validUntil: 2_000,
      contractVersion: 'asset-swap-v3',
    })
    await store.fail('swap-v3', 'quoted', 'quote expired before the deposit was observed')

    const served = [market(ASSET_A, 'USDA')]
    const corridors = corridorSetFromDeps({
      ...base(),
      assetRfqService: service,
      assetRfqStore: store,
      assetRfqMarkets: served,
    })
    const readable = recoverReadableMarkets(served, await store.listNonTerminal())
    const reader = readerSetFromDeps({ ...base(), assetRfqStore: store, assetRfqMarkets: readable }).get(pair)!
    for (const corridor of corridors) await corridor.tickAll()

    expect(await reader.findRecoverable()).toEqual([])
    expect(await reader.statusFor('c'.repeat(64))).toMatchObject({
      type: 'rfq_status',
      profile: { offer_address: 'ark1qv3' },
    })
    expect((await reader.page({})).swaps).toHaveLength(1)
    expect((await reader.detail('swap-v3'))?.raw).toMatchObject({ contractVersion: 'asset-swap-v3', state: 'refused' })
    expect(deriveOffer).not.toHaveBeenCalled()
    expect(depositAt).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    await store.close()
  })
})
