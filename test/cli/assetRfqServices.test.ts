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
import { assetRfqMarketsFrom } from '@arkade-os/solver-app/ops/assetRfqMarkets.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { resolveDbLayout } from '@arkade-os/solver-corridors/db/layout.js'
import type { AssetMarketPricingView } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { createServicesBody } from '../support/createServicesBody.js'

const USDA = '1a'.repeat(34)
const body = () => createServicesBody()

describe('createServices — the asset RFQ service', () => {
  it('constructs one, which is the whole of #23', () => {
    expect(body()).toContain('new AssetRfqSwapService(')
  })

  it('opens its store only when a market is served', () => {
    // A deployment that named no asset must gain no table it never asked for,
    // the same property the EVM stores have.
    expect(body()).toMatch(/assetRfqMarkets\.length > 0 \? await AssetRfqSwapStore\.open/)
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

  it('joins the named assets to the console rows, never to a second list', () => {
    expect(body()).toContain('assetRfqMarketsFrom(policy.assetRfqTokens, assetMarkets.pricing)')
    expect(body().match(/assetRfqMarketsFrom\(/g)).toHaveLength(1)
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
    const shared = body().slice(body().indexOf('const corridorDeps'))
    expect(shared).toContain('assetRfqService,')
    expect(shared).toContain('assetRfqStore,')
    expect(shared).toContain('assetRfqMarkets,')
  })

  it('closes the store, isolated like every other resource', () => {
    expect(body()).toContain("['assetRfqStore', () => assetRfqStore?.close()]")
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
    base: null,
    quote: USDA,
    baseDecimals: 8,
    quoteDecimals: 6,
    feedUrl: 'https://feed.test/price',
    pricePath: '/price',
    toleranceBps: 10,
    feeBps: 25,
    sellBase: { min: 1n, max: 10n ** 12n },
    buyBase: { min: 1n, max: 10n ** 12n },
  }
  const token = { symbol: 'USDA', assetId: USDA, enabled: { sell_base: true, buy_base: true } }
  const deps = async () => ({
    store: null as never,
    onchainStore: null as never,
    assetRfqService: { tickAll: async () => [] } as never,
    assetRfqStore: await AssetRfqSwapStore.open(':memory:'),
    assetRfqMarkets: assetRfqMarketsFrom([token], [pricing]),
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

  it('registers nothing at all when no asset is named', async () => {
    const store = await AssetRfqSwapStore.open(':memory:')
    const corridors = corridorSetFromDeps({
      store: null as never,
      onchainStore: null as never,
      assetRfqService: { tickAll: async () => [] } as never,
      assetRfqStore: store,
      assetRfqMarkets: assetRfqMarketsFrom([], [pricing]),
    })
    expect([...corridors]).toHaveLength(0)
    await store.close()
  })
})
