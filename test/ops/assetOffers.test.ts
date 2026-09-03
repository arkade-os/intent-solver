/**
 * The wiring, not the decision — `test/core/assetOffer.test.ts` covers the gate.
 *
 * What is worth pinning here is what composition can get wrong: reading the
 * deposit from the packet instead of the chain, opening two intents against one
 * outpoint, and submitting without first marking the row in flight.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  AssetOfferService,
  assertMarketsPriced,
  parseAssetMarkets,
  type AssetOfferDeps,
} from '@arkade-os/solver-app/ops/assetOffers.js'
import { OfferFillStore } from '@arkade-os/solver-corridors/db/offerFills.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import { priceFrom } from '@arkade-os/solver-core/core/priceFeed.js'
import { encodeOffer, OFFER_PACKET_TYPE, type Offer } from '@arkade-os/swap'
import { Extension, UnknownPacket, asset } from '@arkade-os/sdk'
import { Transaction } from '@scure/btc-signer'
import { base64, hex } from '@scure/base'

const USDT = '11'.repeat(34)
const SCRIPT = new Uint8Array(34).fill(0xab)
const SCRIPT_HEX = 'ab'.repeat(34)

/** A maker depositing USDT and wanting sats. */
const offer = (over: Partial<Offer> = {}): Offer =>
  ({
    swapPkScript: SCRIPT,
    wantAmount: 1_000n,
    wantAsset: undefined,
    offerAsset: { toString: () => USDT },
    ...over,
  }) as unknown as Offer

const build = async (over: Partial<AssetOfferDeps> = {}) => {
  const store = await OfferFillStore.open(betterSqliteDriver(':memory:'))
  let n = 0
  const deps: AssetOfferDeps = {
    store,
    markets: [{ a: USDT, b: null }],
    minFillAmount: 10n,
    maxFillAmount: 100_000n,
    balance: async () => ({ available: 1_000_000, availableAssets: [{ assetId: USDT, amount: 5_000n }] }),
    outputsAt: async () => [{ script: SCRIPT_HEX, value: 500, assets: [{ assetId: USDT, amount: 900n }] }],
    newId: () => `fill-${(n += 1)}`,
    ...over,
  }
  return { store, deps, service: new AssetOfferService(deps) }
}

const found = { offer: offer(), txid: 'a'.repeat(64), vout: 0 }

describe('consider', () => {
  it('records an intent for an offer it can fill', async () => {
    const { store, service } = await build()
    const outcome = await service.consider(found)
    expect(outcome).toEqual({ fill: true, id: 'fill-1' })

    const row = await store.findById('fill-1')
    expect(row).toMatchObject({ state: 'fillable', offerAssetId: USDT, wantAssetId: null, wantAmount: 1_000n })
  })

  it('observes the deposit from the chain, not the packet', async () => {
    // An offer advertising a deposit it does not hold must not be filled for
    // nothing. Nothing on the packet says what was deposited; only the outputs
    // at its script do.
    const { service } = await build({ outputsAt: async () => [] })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'offer_unfunded' })
  })

  it('counts only the named asset on the deposit side', async () => {
    // A large amount of some OTHER asset holds none of what was promised —
    // otherwise minting something worthless buys a fill.
    const { service } = await build({
      outputsAt: async () => [{ script: SCRIPT_HEX, value: 500, assets: [{ assetId: '22'.repeat(34), amount: 9n }] }],
    })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'offer_unfunded' })
  })

  it('does not open a second intent against the same outpoint', async () => {
    const { store, service } = await build()
    await service.consider(found)
    const again = await service.consider(found)
    expect(again).toEqual({ fill: true, id: 'fill-1' })
    expect(await store.listNonTerminal()).toHaveLength(1)
  })

  it('refuses a market it does not serve, without recording anything', async () => {
    const { store, service } = await build({ markets: [] })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'unsupported_pair' })
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('reads inventory fresh, so a drained float stops filling', async () => {
    const { service } = await build({
      balance: async () => ({ available: 10, availableAssets: [] }),
    })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'insufficient_inventory' })
  })
})

describe('offer consistency — Swap Protocol V1 § 5.1', () => {
  // This fixture's keys are filler, so reconstruction throws and the guard
  // refuses through its catch. That is the right answer — a script that cannot
  // be built cannot agree — but it is NOT the script comparison. The comparison
  // itself, including a maker changing terms under an honest script, is pinned
  // with real curve keys in test/arkade/offerConsistency.test.ts. What these
  // cases pin is the SERVICE behaviour: it refuses, and it refuses first.
  const serverPubkey = new Uint8Array(32).fill(0x02)

  it('refuses an offer whose script does not encode its stated terms', async () => {
    const { store, service } = await build({ serverPubkey })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'offer_inconsistent' })
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('checks it BEFORE reading anything else off the packet', async () => {
    // Everything downstream — deposit, market, price — trusts fields from an
    // attacker-supplied packet. A mismatch must stop the read, not lose a race
    // with it.
    const outputsAt = vi.fn(async () => [])
    const fetchPrice = vi.fn(async () => priceFrom('1'))
    const { service } = await build({ serverPubkey, outputsAt, fetchPrice })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'offer_inconsistent' })
    expect(outputsAt).not.toHaveBeenCalled()
    expect(fetchPrice).not.toHaveBeenCalled()
  })

  it('skips the check when no signer key is configured', async () => {
    // Documented as skipping a protocol MUST rather than silently passing it.
    const { service } = await build()
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
  })
})

describe('the price gate', () => {
  // BTC/USDT: the maker deposits 900 USDT-units and wants 1000 sats. Feed is
  // sats-per-USDT so the fixture's ratio sits near it.
  const pricing = [
    {
      base: USDT,
      quote: null,
      baseDecimals: 0,
      quoteDecimals: 0,
      feedUrl: 'https://feed.test/p',
      pricePath: '/price',
      toleranceBps: 100,
      feeBps: 0,
    },
  ]

  it('takes an offer inside tolerance', async () => {
    const { service } = await build({ pricing, fetchPrice: async () => priceFrom('1.12') })
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
  })

  it('refuses one outside tolerance, recording nothing', async () => {
    // 1000/900 = 1.111…; a feed of 0.5 puts the ask far above tolerance.
    const { store, service } = await build({ pricing, fetchPrice: async () => priceFrom('0.5') })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'price_out_of_tolerance' })
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('FAILS CLOSED when the feed cannot be read', async () => {
    // An unreadable feed must not become a free fill at whatever was asked.
    const errors: unknown[] = []
    const { service } = await build({
      pricing,
      fetchPrice: async () => {
        throw new Error('feed down')
      },
      onError: (_id, error) => void errors.push(error),
    })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'price_out_of_tolerance' })
    expect(errors).toHaveLength(1)
  })

  it('fails closed for a market that is priced nowhere', async () => {
    const { service } = await build({
      pricing: [{ ...pricing[0]!, base: '99'.repeat(34) }],
      fetchPrice: async () => priceFrom('1.12'),
    })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'price_out_of_tolerance' })
  })

  it('leaves an unpriced deployment unchanged', async () => {
    // Opting out entirely is allowed; opting in halfway is not.
    const { service } = await build()
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
  })

  it('does not read the feed for an offer the cheap gates already refused', async () => {
    const fetchPrice = vi.fn(async () => priceFrom('1.12'))
    const { service } = await build({ pricing, fetchPrice, markets: [] })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'unsupported_pair' })
    expect(fetchPrice).not.toHaveBeenCalled()
  })
})

describe('per-direction bounds', () => {
  // The fixture deposits USDT (the base) and wants sats (the quote), so it
  // lands on this market's `sell_base` side.
  const priced = (over: Record<string, unknown>) => [
    {
      base: USDT,
      quote: null,
      baseDecimals: 0,
      quoteDecimals: 0,
      feedUrl: 'https://feed.test/p',
      pricePath: '/price',
      // As permissive as the gate allows, so these cases isolate the BOUNDS
      // logic rather than re-testing pricing. Not 10_000: at BPS the buy_base
      // comparison degenerates and every offer passes at any price, so
      // `offerWithinTolerance` refuses it outright.
      toleranceBps: 9_999,
      feeBps: 0,
      ...over,
    },
  ]
  const fetchPrice = async () => priceFrom('1')

  it('applies the direction`s own bounds over the deployment-wide pair', async () => {
    const { service } = await build({
      pricing: priced({ sellBase: { min: 5_000n, max: 10_000n } }),
      fetchPrice,
    })
    // 1000 sats is inside the global 10..100_000 but under this direction's min.
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'amount_out_of_range' })
  })

  it('takes one inside the direction`s bounds', async () => {
    const { service } = await build({
      pricing: priced({ sellBase: { min: 100n, max: 10_000n } }),
      fetchPrice,
    })
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
  })

  it('treats a max of 0 as DISABLING that direction', async () => {
    // Not "unbounded" — the reference uses the same convention, so a market can
    // be one-way without being two entries.
    const { service } = await build({
      pricing: priced({ sellBase: { min: 0n, max: 0n } }),
      fetchPrice,
    })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'amount_out_of_range' })
  })

  it('leaves the other direction alone', async () => {
    // buyBase bounds must not gate a buy_base offer.
    const { service } = await build({
      pricing: priced({ buyBase: { min: 0n, max: 0n } }),
      fetchPrice,
    })
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
  })
})

describe('tickAll', () => {
  it('marks the row in flight BEFORE submitting', async () => {
    // A crash mid-submission must leave a row that says something may be out,
    // not one that still reads fillable and invites a second submission.
    let stateAtSettle: string | undefined
    const { store, service } = await build({
      settle: async (row) => {
        stateAtSettle = (await store.findById(row.id))?.state
        return '0xfill'
      },
    })
    await service.consider(found)
    expect(await service.tickAll()).toBe(1)
    expect(stateAtSettle).toBe('filling')
    expect(await store.findById('fill-1')).toMatchObject({ state: 'filled', fillTxid: '0xfill' })
  })

  it('leaves a failed submission stuck, never refused', async () => {
    // `filling` means something may have been submitted; only a human can tell.
    const errors: unknown[] = []
    const { store, service } = await build({
      settle: async () => {
        throw new Error('relay refused')
      },
      onError: (_id, error) => void errors.push(error),
    })
    await service.consider(found)
    expect(await service.tickAll()).toBe(0)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'stuck', failureReason: 'relay refused' })
    expect(errors).toHaveLength(1)
  })

  it('does nothing without a settle port, leaving the row fillable', async () => {
    // A deployment that decides but cannot fill must not lose the intent.
    const { store, service } = await build()
    await service.consider(found)
    expect(await service.tickAll()).toBe(0)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'fillable' })
  })
})

describe('consumeOfferTxs — the discovery intake', () => {
  /**
   * A real funding transaction, encoded the way the maker's wallet encodes one
   * and the way arkd hands it back. Nothing here is hand-rolled TLV: `encodeOffer`
   * is the same function that produced the packet solverd would emit, so a change
   * to the wire format breaks this rather than passing against our own dialect.
   */
  const fundingTx = (over: Partial<Offer> = {}): string => {
    const published = {
      swapPkScript: SCRIPT,
      wantAmount: 1_000n,
      offerAsset: asset.AssetId.fromString(USDT),
      makerPkScript: new Uint8Array(34).fill(0xcd),
      makerPublicKey: new Uint8Array(32).fill(0x11),
      emulatorPubkey: new Uint8Array(32).fill(0x22),
      ...over,
    } as Offer
    const tx = new Transaction({ allowUnknownOutputs: true, disableScriptCheck: true })
    tx.addOutput({ script: published.swapPkScript, amount: 500n })
    const out = Extension.create([new UnknownPacket(OFFER_PACKET_TYPE, encodeOffer(published))]).txOut()
    tx.addOutput({ script: out.script, amount: out.amount })
    return base64.encode(tx.toPSBT())
  }

  const stream = async function* (txs: readonly string[]): AsyncGenerator<{ txid: string; tx: string }> {
    for (const tx of txs) yield { txid: 'announced', tx }
  }

  it('decides an offer decoded off the stream, keyed to the outpoint it funds', async () => {
    const { store, service } = await build()
    const raw = fundingTx()
    await service.consumeOfferTxs(stream([raw]))

    const row = await store.findById('fill-1')
    expect(row).toMatchObject({ state: 'fillable', wantAmount: 1_000n, offerAssetId: USDT })
    // The txid comes from the transaction, not from the `txid` the stream
    // announced beside it: the row must name the outpoint settlement will spend.
    expect(row!.offerTxid).toBe(Transaction.fromPSBT(base64.decode(raw)).id)
    expect(row!.offerVout).toBe(0)
    expect(row!.offerPkScript).toBe(SCRIPT_HEX)
  })

  it('does not let one undecodable transaction end the stream', async () => {
    // Anyone can put a transaction on this stream. A malformed packet is normal
    // traffic, and a loop that dies on it goes deaf to every offer after it.
    const { store, service } = await build()
    await service.consumeOfferTxs(stream(['not a transaction at all', fundingTx()]))
    expect(await store.listNonTerminal()).toHaveLength(1)
  })

  it('keeps going when deciding one offer throws, and reports it', async () => {
    const errors: unknown[] = []
    const { store, service } = await build({
      outputsAt: vi
        .fn()
        .mockRejectedValueOnce(new Error('indexer down'))
        .mockResolvedValue([{ script: SCRIPT_HEX, value: 500, assets: [{ assetId: USDT, amount: 900n }] }]),
      onError: (_id, error) => void errors.push(error),
    })
    // Two DIFFERENT offers: one outpoint would be deduplicated by the store.
    await service.consumeOfferTxs(stream([fundingTx(), fundingTx({ wantAmount: 1_100n })]))
    expect(errors).toHaveLength(1)
    expect(await store.listNonTerminal()).toHaveLength(1)
  })

  it('ignores a transaction carrying no offer packet without recording anything', async () => {
    const bare = new Transaction({ allowUnknownOutputs: true, disableScriptCheck: true })
    bare.addOutput({ script: SCRIPT, amount: 500n })
    const { store, service } = await build()
    await service.consumeOfferTxs(stream([base64.encode(bare.toPSBT())]))
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('observes the deposit at the script rather than trusting the funding output', async () => {
    // The transaction says 500 sats landed. What decides is what the chain still
    // holds there, which is the read `outputsAt` performs — an offer whose
    // deposit has since been spent must not be recorded as fillable.
    const { store, service } = await build({ outputsAt: async () => [] })
    await service.consumeOfferTxs(stream([fundingTx()]))
    expect(await store.listNonTerminal()).toHaveLength(0)
  })
})

describe('parseAssetMarkets', () => {
  it('reads BTC as the null leg', () => {
    expect(parseAssetMarkets(`BTC/${USDT}`)).toEqual([{ a: null, b: USDT }])
  })

  it('reads asset-for-asset', () => {
    const other = '22'.repeat(34)
    expect(parseAssetMarkets(`${USDT}/${other}`)).toEqual([{ a: USDT, b: other }])
  })

  it('serves nothing when unset', () => {
    expect(parseAssetMarkets(undefined)).toEqual([])
    expect(parseAssetMarkets('')).toEqual([])
  })

  it('refuses a market naming one thing twice', () => {
    expect(() => parseAssetMarkets(`${USDT}/${USDT}`)).toThrow(/one thing twice/)
    expect(() => parseAssetMarkets('BTC/BTC')).toThrow(/one thing twice/)
  })

  it('refuses a malformed entry rather than silently serving fewer markets', () => {
    expect(() => parseAssetMarkets('BTC')).toThrow(/not A\/B/)
    expect(() => parseAssetMarkets('a/b/c')).toThrow(/not A\/B/)
  })
})

/**
 * A served market with no pricing takes an offer at ANY price the maker names —
 * `assetOffers.ts` says so on `AssetMarketPricing`, and `withinTolerance`
 * returns true when the pricing list is empty. That is a FAIL-OPEN: the gate
 * reads as optional, and absent it is not lenient but disabled.
 *
 * It only became reachable when a producer for `markets` arrived without one for
 * `pricing` — `OFFER_MARKETS` names pairs, and the console's market rows are
 * what carry a feed. Either alone is a configuration a deployment can express;
 * this refuses the combination rather than serving it quietly.
 *
 * Note which direction is safe. Pricing WITHOUT a matching market is fine —
 * nothing is served. Pricing set but unreadable already refuses (`fetchPrice`
 * absent returns false). Only market-without-pricing fills blind.
 */
describe('assertMarketsPriced', () => {
  const BTC = null
  const USDA = 'aa'.repeat(32)
  const EURX = 'bb'.repeat(32)
  const priced = (base: string | null, quote: string | null) =>
    ({
      base,
      quote,
      baseDecimals: 8,
      quoteDecimals: 6,
      feedUrl: 'https://f',
      pricePath: '/p',
      toleranceBps: 100,
    }) as never

  it('accepts a market its pricing covers', () => {
    expect(() => assertMarketsPriced([{ a: BTC, b: USDA }], [priced(BTC, USDA)])).not.toThrow()
  })

  it('accepts it in either orientation — the market is unordered, the feed is not', () => {
    expect(() => assertMarketsPriced([{ a: BTC, b: USDA }], [priced(USDA, BTC)])).not.toThrow()
  })

  it('REFUSES a served market with no pricing at all', () => {
    expect(() => assertMarketsPriced([{ a: BTC, b: USDA }], [])).toThrow(/pricing|price/i)
  })

  it('refuses when the pricing covers a different market', () => {
    expect(() => assertMarketsPriced([{ a: BTC, b: USDA }], [priced(BTC, EURX)])).toThrow(/pricing|price/i)
  })

  it('names the market that is unpriced, so an operator can fix it', () => {
    expect(() => assertMarketsPriced([{ a: BTC, b: USDA }], [])).toThrow(new RegExp(USDA.slice(0, 16)))
  })

  it('allows pricing with no market — nothing is served, nothing is at risk', () => {
    expect(() => assertMarketsPriced([], [priced(BTC, USDA)])).not.toThrow()
  })
})
