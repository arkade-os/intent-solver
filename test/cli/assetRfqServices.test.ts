/**
 * The composition #23 was about: the atomic-class corridor had a store, an
 * orchestrator, wire payloads and unit tests, and nothing in a running solver
 * ever built the service the registry registers. Every test below is a claim
 * about `createServices` itself.
 *
 * Asserted against the source text for the reason `evmServices.test.ts` gives:
 * constructing the stack needs an Arkade wallet, an emulator and a Lightning
 * node a unit test has none of. The half that CAN be exercised — that the
 * configured markets really do become registered corridors — is, at the bottom.
 */
import { describe, it, expect } from 'vitest'
import { corridorSetFromDeps, readerSetFromDeps } from '@arkade-os/solver-app/ops/corridorSet.js'
import { assetRfqMarketsFrom, recoverReadableMarkets } from '@arkade-os/solver-app/ops/assetRfqMarkets.js'
import type { ReadableAssetRfqMarket } from '@arkade-os/solver-corridors/corridors/assetRfq.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { resolveDbLayout } from '@arkade-os/solver-corridors/db/layout.js'
import { DEFAULT_SERVING, type AssetMarketPricingView } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { createServicesBody } from '../support/createServicesBody.js'

const USDA = '1a'.repeat(34)
const body = () => createServicesBody()

describe('createServices — the asset RFQ service', () => {
  it('constructs one, which is the whole of #23', () => {
    expect(body()).toContain('new AssetRfqSwapService(')
  })

  it('constructs one even when no market is served yet', () => {
    // A first dashboard row has to attach to a running service.
    expect(body()).toContain('new AssetRfqSwapService(')
    expect(body()).toContain('await AssetRfqSwapStore.open(swapFile)')
    expect(body()).not.toMatch(/assetRfqMarkets\.length > 0 \? await AssetRfqSwapStore\.open/)
  })

  it('puts the table in the swap file, sharing the connection', () => {
    // A second connection to a file this process already holds is how a
    // single-writer database starts returning SQLITE_BUSY under load.
    expect(body()).toContain('AssetRfqSwapStore.open(swapFile)')
  })

  it('opens ONE store and builds ONE service for every market', () => {
    // A corridor exists per market per DIRECTION; a store per market would
    // multiply files and connections with the market list.
    expect(body().match(/AssetRfqSwapStore\.open/g)).toHaveLength(1)
    expect(body().match(/new AssetRfqSwapService\(/g)).toHaveLength(1)
  })

  it('resolves the markets BEFORE opening anything, so a bad join costs no file', () => {
    expect(body().indexOf('assetRfqMarketsFrom(')).toBeLessThan(body().indexOf('AssetRfqSwapStore.open'))
  })

  it('reads the serve list off the console row, never off a second env list', () => {
    expect(body()).toContain('assetRfqMarketsFrom(assetMarkets.pricing,')
    expect(body()).toContain('assetRfqMarketsFrom(next.pricing,')
    expect(body()).not.toContain('policy.assetRfqTokens')
    expect(body().match(/assetRfqMarketsFrom\(/g)).toHaveLength(2)
  })
})

describe('the four Arkade seams', () => {
  it('derives the offer through the shipped derivation, not an inline one', () => {
    expect(body()).toContain('deriveOffer: offerScriptFrom(assetRfqDerivation)')
  })

  it('gives the derivation and the settle the SAME keys', () => {
    // Two derivations would let the address a client is quoted and the covenant
    // a fill spends drift apart, which strands the deposit.
    expect(body().match(/assetRfqDerivation/g)?.length).toBeGreaterThanOrEqual(3)
    expect(body()).toContain('derivation: assetRfqDerivation')
  })

  it('normalises the emulator key to x-only', () => {
    // The emulator advertises a compressed key; the covenant takes 32 bytes, so
    // the raw form quotes an address no client ever derives.
    expect(body()).toContain('emulatorPubkey: xOnlyPubkey(hex.decode(emulatorInfo.signerPubkey))')
  })

  it('takes the exit closure from the ADVERTISED delay, never the local override', () => {
    expect(body()).toContain('exitDelay: offerExitDelay(arkade.advertisedExitDelay)')
    expect(body()).not.toContain('offerExitDelay(arkade.unilateralDelays')
  })

  it('reads AVAILABLE inventory, never the total', () => {
    // A wallet whose batch expired reports millions and can spend nothing;
    // quoting off `total` accepts every swap and fails every fill.
    expect(body()).toContain('balance: async () => offerInventoryFrom(await arkade.wallet.getBalance())')
  })

  it('watches ONE outpoint, because a fill spends one input', () => {
    expect(body()).toContain('largestOfferOutpoint(await liveOfferOutpoints(arkade, offerPkScript)')
  })

  it('ranks that outpoint by the DEPOSIT LEG, not by sats', () => {
    // An asset deposit rides a uniform dust carrier, so ranking on sats ties a
    // stale carrier against the live one and the indexer's order decides which
    // is recorded — then settle re-measures it and the row sticks.
    expect(body()).toContain('offerPkScript), depositLeg)')
  })

  it('wires the spend through the guarded settle port', () => {
    expect(body()).toContain('settle: quotedOfferSettleFor(')
  })

  it('binds the quote window to the configured one rather than a literal', () => {
    expect(body()).toContain('quoteValiditySeconds: policy.assetQuoteValiditySeconds')
  })
})

describe('the corridors reach the registry and the console', () => {
  it('hands the service, the store and the markets to the shared deps', () => {
    // `corridorSetFromDeps` registers only when the first two are present, and
    // `readerSetFromDeps` needs the store for an operator to see a live
    // negotiation at all.
    const shared = body().slice(body().indexOf('const shared = {'))
    expect(shared).toContain('assetRfqService,')
    expect(shared).toContain('assetRfqStore,')
    expect(body()).toContain('assetRfqMarkets: serving')
    expect(body()).toContain('assetRfqMarkets: readable')
  })

  it('closes the store, isolated like every other resource', () => {
    expect(body()).toContain("['assetRfqStore', () => assetRfqStore.close()]")
  })

  it('hands the offer service the rows declared for offers, at boot and on swap', () => {
    // An unpriced market fills at the maker's price; the row IS the pricing.
    expect(body()).toContain('const liveOfferMarkets = offerMarketsFrom(assetMarkets.pricing)')
    expect(body()).toContain('markets: liveOfferMarkets,')
    expect(body()).toContain('const offers = offerMarketsFrom(next.pricing)')
    expect(body()).toContain('replaceMarkets({ markets: offers, pricing: next.pricing })')
    expect(body()).not.toContain('markets: policy.offerMarkets')
  })

  it('hot-swaps the captured corridor set in place after a console write', () => {
    expect(body()).toContain('retainReadableMarkets(rfq, readableMarkets, live)')
    expect(body()).toContain('replaceQueue(async () => {')
    expect(body().indexOf('const nextSets = setsFrom(livePolicy, rfq, readable)')).toBeLessThan(
      body().indexOf('await assetRfqService.replaceMarkets(rfq)'),
    )
    expect(body()).toContain('services.corridors.replace')
    expect(body()).toContain('services.readers.replace')
  })
})

describe('the swap-file layout names the table', () => {
  it('keeps it in the swap file in BOTH layouts, so one backup covers it', () => {
    // The split layout exists to avoid moving rows a previous release wrote,
    // and this corridor has no previous release.
    expect(resolveDbLayout('/srv/swaps.sqlite', () => false).assetRfq).toBe('/srv/swaps.sqlite')
    expect(resolveDbLayout('/srv/swaps.sqlite', () => true).assetRfq).toBe('/srv/swaps.sqlite')
  })
})

describe('a configured market really does become a served corridor', () => {
  const pricing: AssetMarketPricingView = {
    ...DEFAULT_SERVING,
    symbol: 'USDA',
    base: null,
    quote: USDA,
    baseDecimals: 8,
    quoteDecimals: 6,
    feedUrl: 'https://feed.test/price',
    pricePath: '/price',
    toleranceBps: 10,
    feeBps: 25,
    sellBaseFeeFlat: 0n,
    buyBaseFeeFlat: 0n,
    sellBase: { min: 1n, max: 10n ** 12n },
    buyBase: { min: 1n, max: 10n ** 12n },
  }
  const deps = async () => ({
    store: null as never,
    onchainStore: null as never,
    assetRfqService: { tickAll: async () => [] } as never,
    assetRfqStore: await AssetRfqSwapStore.open(':memory:'),
    assetRfqMarkets: assetRfqMarketsFrom([pricing], { dustSats: 0n, pricedByDefault: false }),
  })

  it('registers both directions under the pairs a client would ask for', async () => {
    const built = await deps()
    const corridors = corridorSetFromDeps(built)
    expect(corridors.get(`arkade:BTC->arkade:${USDA}`)).toBeDefined()
    expect(corridors.get(`arkade:${USDA}->arkade:BTC`)).toBeDefined()
    await built.assetRfqStore.close()
  })

  it('keeps them readable even with the service absent, so a paused market stays visible', async () => {
    const built = await deps()
    const readers = readerSetFromDeps({ ...built, assetRfqService: null })
    expect(readers.get(`arkade:BTC->arkade:${USDA}`)).toBeDefined()
    expect(corridorSetFromDeps({ ...built, assetRfqService: null }).get(`arkade:BTC->arkade:${USDA}`)).toBeUndefined()
    await built.assetRfqStore.close()
  })

  it('registers nothing at all when the console holds no market', async () => {
    const store = await AssetRfqSwapStore.open(':memory:')
    const corridors = corridorSetFromDeps({
      store: null as never,
      onchainStore: null as never,
      assetRfqService: { tickAll: async () => [] } as never,
      assetRfqStore: store,
      assetRfqMarkets: assetRfqMarketsFrom([], { dustSats: 0n, pricedByDefault: false }),
    })
    expect([...corridors]).toHaveLength(0)
    await store.close()
  })
})

describe('a market that stopped serving stays readable across a restart', () => {
  const PAIR = `arkade:BTC->arkade:${USDA}`
  const RFQ_ID = 'a'.repeat(64)
  const servedPricing: AssetMarketPricingView = {
    ...DEFAULT_SERVING,
    symbol: 'USDA',
    base: null,
    quote: USDA,
    baseDecimals: 8,
    quoteDecimals: 6,
    feedUrl: 'https://feed.test/price',
    pricePath: '/price',
    toleranceBps: 10,
    feeBps: 25,
    sellBaseFeeFlat: 0n,
    buyBaseFeeFlat: 0n,
    sellBase: { min: 1n, max: 10n ** 12n },
    buyBase: { min: 1n, max: 10n ** 12n },
  }

  const storeWithLiveRow = async (): Promise<AssetRfqSwapStore> => {
    const store = await AssetRfqSwapStore.open(':memory:', () => 1_000)
    await store.insertQuote({
      id: 'swap-1',
      rfqId: RFQ_ID,
      pair: PAIR,
      fromAssetId: null,
      fromAmount: 100_000_000n,
      toAssetId: USDA,
      toAmount: 99_500_000n,
      makerPkScript: `5120${'c'.repeat(64)}`,
      makerPublicKey: 'b'.repeat(64),
      offerPkScript: `5120${'d'.repeat(64)}`,
      offerAddress: 'ark1qoffer',
      solverPubkey: 'e'.repeat(64),
      validUntil: 2_000,
    })
    return store
  }

  const readersOver = (store: AssetRfqSwapStore, assetRfqMarkets: readonly ReadableAssetRfqMarket[]) =>
    readerSetFromDeps({ store: null as never, onchainStore: null as never, assetRfqStore: store, assetRfqMarkets })

  it('answers for its live negotiation with no console row left to derive it from', async () => {
    const store = await storeWithLiveRow()
    const readers = readersOver(store, recoverReadableMarkets([], await store.listNonTerminal()))
    expect(readers.get(PAIR)).toBeDefined()
    expect(await readers.get(PAIR)!.statusFor(RFQ_ID)).not.toBeNull()
    await store.close()
  })

  it('registers no duplicate pair when that market is still served', async () => {
    const store = await storeWithLiveRow()
    const serving = assetRfqMarketsFrom([servedPricing], { dustSats: 0n, pricedByDefault: false })
    const readable = recoverReadableMarkets(serving, await store.listNonTerminal())
    expect(readable).toHaveLength(1)
    expect(() => readersOver(store, readable)).not.toThrow()
    await store.close()
  })

  it('seeds the boot reader set from the recovered list rather than the serving one', () => {
    const source = body()
    const seeded = 'recoverReadableMarkets('
    const built = 'const { corridors, readers } = setsFrom(policy, assetRfqMarkets, readableMarkets)'
    // Both needles pinned present before the ordering: `indexOf` answers -1 for
    // an absent one, which is below any real index and passes vacuously.
    expect(source).toContain('await assetRfqStore.listNonTerminal()')
    expect(source).toContain(seeded)
    expect(source).toContain(built)
    expect(source.indexOf(seeded)).toBeLessThan(source.indexOf(built))
  })
})
