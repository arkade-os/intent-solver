/**
 * The `arkade:<X>->arkade:<Y>` orchestrator — quoting, and driving a
 * negotiation to a fill.
 *
 * Every Arkade seam is injected, exactly as `ops/assetOffers.ts` injects its
 * own: the derivation, the deposit read, the float and the settle. That is what
 * makes the money decisions testable without a wallet, and it is also the
 * honest shape — none of them is faked here, they are supplied.
 *
 * The properties worth pinning are the ones that cost money if they slip:
 * the solver never funds anything, a lapsed quote is never filled, a short
 * deposit is never filled, and a submitted fill whose outcome is unknown never
 * silently retries.
 */

import { describe, it, expect, vi } from 'vitest'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { IMPLIED_PRICE_HEADROOM } from '@arkade-os/solver-core/core/assetRfq.js'
import { UniqueConstraintError } from '@arkade-os/solver-core/core/driver.js'
import {
  AssetRfqSwapService,
  type AssetRfqDeps,
  type ObservedDeposit,
  type ReceiveCarrierQuote,
  type ReceiveCarrierQuotes,
} from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'

const ASSET_A = `${'aa'.repeat(32)}0100`
const ASSET_B = `${'ab'.repeat(32)}0100`
const PK_SCRIPT = `5120${'c'.repeat(64)}`
const XONLY = 'b'.repeat(64)
const OFFER_SCRIPT = `5120${'d'.repeat(64)}`
const RFQ_ID = 'a'.repeat(64)

/**
 * Bounds are PER DIRECTION and in the PAYOUT leg's units, matching
 * `ops/assetOffers.ts`'s `sellBase`/`buyBase`. One bound pair cannot serve both
 * directions of a cross-asset market: the leg being paid out flips, so `1000`
 * means a thousand atomic units of a stablecoin one way and a thousand sats the
 * other. A single pair would refuse or admit entirely the wrong sizes.
 */
const MARKET = {
  base: null,
  quote: ASSET_A,
  symbol: 'USDA',
  baseDecimals: 8,
  quoteDecimals: 6,
  feeBps: 50,
  // Client gives base (BTC), receives quote (the asset).
  sellBase: { min: 1n, max: 10n ** 24n },
  // Client gives quote (the asset), receives base (sats).
  buyBase: { min: 1n, max: 10n ** 24n },
  feedUrl: 'https://feed.example/btc',
  pricePath: 'price',
  carrierSats: 0n,
}

const harness = async (over: Partial<AssetRfqDeps> = {}) => {
  let clock = 1_000
  const store = await AssetRfqSwapStore.open(':memory:', () => clock)
  const settled: string[] = []
  const deps: AssetRfqDeps = {
    store,
    markets: [MARKET],
    solverPubkey: 'e'.repeat(64),
    quoteValiditySeconds: 30,
    dustSats: 330n,
    now: () => clock,
    fetchPrice: async () => ({ mantissa: 100_000n, scale: 0 }),
    deriveOffer: () => ({ pkScript: OFFER_SCRIPT, address: 'ark1qoffer' }),
    depositAt: async () => null,
    balance: async () => new Map([[ASSET_A, 10n ** 18n]]),
    settle: async (row) => {
      settled.push(row.id)
      return 'fa'.repeat(32)
    },
    newId: () => 'swap-1',
    ...over,
  }
  return {
    deps,
    store,
    settled,
    service: new AssetRfqSwapService(deps),
    tick: (n: number) => {
      clock = n
    },
  }
}

const request = (over: Record<string, unknown> = {}) => ({
  rfqId: RFQ_ID,
  pair: `arkade:BTC->arkade:${ASSET_A}`,
  amount: 100_000_000n,
  amountSide: 'from' as const,
  makerPkScript: PK_SCRIPT,
  makerPublicKey: XONLY,
  ...over,
})

const sequentialIds = () => {
  let n = 0
  return () => `swap-${++n}`
}

/**
 * Distinct clients derive distinct covenants, which is what the store's
 * live-offer index assumes: two negotiations watching one address would both
 * claim a single deposit, and at most one fill can succeed.
 */
const perClientOffer = (terms: { makerPublicKey: string }) => ({
  pkScript: `5120${terms.makerPublicKey}`,
  address: `ark1q${terms.makerPublicKey.slice(0, 8)}`,
})

const deposit = (over: Partial<ObservedDeposit> = {}): ObservedDeposit => ({
  txid: 'ff'.repeat(32),
  vout: 0,
  sats: 100_000_000n,
  assets: [],
  ...over,
})

describe('quote', () => {
  it('resolves both amounts and records the terms before answering', async () => {
    const { service, store } = await harness()
    const outcome = await service.quote(request())
    expect(outcome).toMatchObject({ accepted: true })
    if (!outcome.accepted) throw new Error('expected a quote')
    expect(outcome.swap).toMatchObject({
      state: 'quoted',
      fromAmount: 100_000_000n,
      toAmount: 99_500_000_000n,
      offerAddress: 'ark1qoffer',
    })
    // Written BEFORE the client could act on it: a quote this solver has no row
    // for is one it will not recognise a deposit against.
    expect((await store.findByRfqId(RFQ_ID))?.id).toBe('swap-1')
  })

  it('sizes valid_until from the configured window', async () => {
    const { service } = await harness()
    const outcome = await service.quote(request())
    if (!outcome.accepted) throw new Error('expected a quote')
    expect(outcome.swap.validUntil).toBe(1_030)
  })

  /**
   * The whole point of the corridor: the solver derives the offer covenant that
   * the CLIENT will fund, from the terms it just quoted plus the two parameters
   * the client supplied. The address is the commitment — terms other than these
   * derive a different address, which this solver is not watching.
   */
  it('derives the offer covenant from the quoted terms and the client parameters', async () => {
    const seen: unknown[] = []
    const { service } = await harness({
      deriveOffer: (terms) => {
        seen.push(terms)
        return { pkScript: OFFER_SCRIPT, address: 'ark1qoffer' }
      },
    })
    await service.quote(request())
    expect(seen[0]).toMatchObject({
      wantAmount: 99_500_000_000n,
      wantAssetId: ASSET_A,
      offerAssetId: null,
      makerPkScript: PK_SCRIPT,
      makerPublicKey: XONLY,
    })
  })

  it.each([
    ['a pair on another corridor', { pair: 'arkade:BTC->lightning:BTC' }],
    [
      'a pair with an asset on both legs, which no packet can carry',
      {
        pair: `arkade:${ASSET_A}->arkade:${'bb'.repeat(32)}0000`,
      },
    ],
    ['a market this deployment does not serve', { pair: `arkade:BTC->arkade:${'bb'.repeat(32)}0000` }],
  ])('refuses %s as unsupported_pair', async (_why, over) => {
    const { service } = await harness()
    expect(await service.quote(request(over))).toMatchObject({ accepted: false, reason: 'unsupported_pair' })
  })

  it('nets the carrier out of the payout when the operator prices it', async () => {
    const { service } = await harness({ markets: [{ ...MARKET, carrierSats: 330n }] })
    const outcome = await service.quote(request())
    expect(outcome).toMatchObject({ accepted: true })
    // 330 of the deposit's sats buy the carrier the asset payout rides on.
    expect((outcome as { swap: { toAmount: bigint } }).swap.toAmount).toBe(99_499_671_650n)
  })

  /**
   * Where the carrier lands, per direction. `carrierLegs` CHARGES it only when
   * the solver delivers the asset and the client is not already fronting one,
   * so a BTC->asset sale NETS the deposit while the asset->BTC payout is
   * CREDITED. The 330 therefore bounds the exact-out payout, and on exact-in it
   * is a floor on what the input must leave behind.
   */
  it.each([['an input the carrier consumes', 330n, 'from', 'fee_consumes_swap', '1'.repeat(64)]] as const)(
    'refuses a BTC->asset sale with %s',
    async (_why, amount, side, reason, signer) => {
      const { service } = await harness({ markets: [{ ...MARKET, carrierSats: 330n }] })
      const ask = request({ amount, amountSide: side, rfqId: signer, makerPublicKey: signer })
      expect(await service.quote(ask)).toMatchObject({ accepted: false, reason })
    },
  )

  it.each([
    ['exact-in', 331n, 'from', 995n],
    ['exact-out', 331n, 'to', 331n],
  ] as const)('prices a BTC->asset sale on the sat above the carrier on %s', async (_why, amount, side, toAmount) => {
    const { service } = await harness({ markets: [{ ...MARKET, carrierSats: 330n }], newId: sequentialIds() })
    const outcome = await service.quote(request({ amount, amountSide: side }))
    expect(outcome).toMatchObject({ accepted: true })
    expect(outcome.accepted && outcome.carrierSats).toBe(330n)
    expect((outcome as { swap: { toAmount: bigint } }).swap.toAmount).toBe(toAmount)
  })

  it('credits the carrier back on an asset->BTC payout rather than netting it', async () => {
    const { service } = await harness({
      markets: [{ ...MARKET, carrierSats: 330n }],
      balance: async () =>
        new Map([
          [ASSET_A, 10n ** 18n],
          [null, 10n ** 12n],
        ]),
    })
    const outcome = await service.quote(
      request({ pair: `arkade:${ASSET_A}->arkade:BTC`, amount: 331n, amountSide: 'to' }),
    )
    expect(outcome).toMatchObject({ accepted: true })
    // Credited, not charged: `carrierLegs` puts the 330 on the payout leg, which
    // is exactly the sat the named payout above could not go below.
    expect((outcome as { swap: { toAmount: bigint } }).swap.toAmount).toBe(331n)
    expect(outcome.accepted && outcome.carrierSats).toBe(330n)
  })

  it('charges each market its own carrier, so no service-wide figure can stand in', async () => {
    const { service } = await harness({
      markets: [
        { ...MARKET, carrierSats: 330n },
        { ...MARKET, symbol: 'USDB', quote: ASSET_B, carrierSats: 0n },
      ],
      balance: async () =>
        new Map([
          [ASSET_A, 10n ** 18n],
          [ASSET_B, 10n ** 18n],
        ]),
      newId: sequentialIds(),
      deriveOffer: perClientOffer,
    })
    const priced = await service.quote(request())
    const free = await service.quote(
      request({ pair: `arkade:BTC->arkade:${ASSET_B}`, rfqId: 'f'.repeat(64), makerPublicKey: 'c'.repeat(64) }),
    )
    expect(priced.accepted && priced.carrierSats).toBe(330n)
    expect(free.accepted && free.carrierSats).toBe(0n)
    expect(priced.accepted && free.accepted && priced.swap.toAmount < free.swap.toAmount).toBe(true)
  })

  it('quotes exact-out, binding the payout the client named', async () => {
    const { service } = await harness()
    const outcome = await service.quote(request({ amount: 1_000_000n, amountSide: 'to' }))
    expect(outcome).toMatchObject({ accepted: true })
    expect((outcome as { swap: { toAmount: bigint } }).swap.toAmount).toBe(1_000_000n)
  })

  /** An unreadable feed must never become a free fill. */
  it('refuses when the price feed cannot be read', async () => {
    const { service } = await harness({
      fetchPrice: async () => {
        throw new Error('feed down')
      },
    })
    expect(await service.quote(request())).toMatchObject({ accepted: false, reason: 'price_unavailable' })
  })

  /**
   * A quote-time pre-check is permitted by § 9 and is not sufficient — the same
   * gate runs again at action time. Quoting a swap the float cannot cover would
   * be committing to a price this solver already knows it cannot honour.
   */
  it('refuses when the float already cannot cover the payout', async () => {
    const { service } = await harness({ balance: async () => new Map([[ASSET_A, 1n]]) })
    expect(await service.quote(request())).toMatchObject({ accepted: false, reason: 'insufficient_inventory' })
  })

  /**
   * The bound that applies is the one for the direction being quoted, read in
   * the units of the leg actually being paid out. A market bounded generously
   * in one direction and closed in the other must serve exactly one of them.
   */
  it('applies the bounds of the direction being quoted, in that leg units', async () => {
    const { service } = await harness({
      markets: [{ ...MARKET, sellBase: { min: 1n, max: 10n ** 24n }, buyBase: { min: 1n, max: 1n } }],
    })
    // BTC in, asset out — the generous direction.
    expect(await service.quote(request())).toMatchObject({ accepted: true })
    // Asset in, sats out — bounded to a single sat, so this size is refused.
    expect(
      await service.quote(
        request({
          rfqId: 'f'.repeat(64),
          pair: `arkade:${ASSET_A}->arkade:BTC`,
          amount: 100_000_000_000n,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'amount_out_of_range' })
  })

  /**
   * `max: 0n` disables a direction rather than meaning unbounded — the same
   * convention `ops/assetOffers.ts` states, so a market can be one-way without
   * being two entries.
   */
  it('treats a zero max as a closed direction, not an open one', async () => {
    const { service } = await harness({ markets: [{ ...MARKET, sellBase: { min: 0n, max: 0n } }] })
    expect(await service.quote(request())).toMatchObject({ accepted: false, reason: 'amount_out_of_range' })
  })

  it('refuses a second negotiation reusing one rfq_id', async () => {
    const { service } = await harness({ newId: sequentialIds() })
    await service.quote(request())
    expect(await service.quote(request({ makerPublicKey: 'c'.repeat(64) }))).toMatchObject({
      accepted: false,
      reason: 'duplicate_swap',
    })
  })

  it('lets an unexpected write failure surface instead of calling it a duplicate', async () => {
    const { service, store } = await harness()
    vi.spyOn(store, 'insertQuote').mockRejectedValueOnce(new TypeError('quote construction is broken'))
    await expect(service.quote(request())).rejects.toThrow(/quote construction is broken/)
  })

  it('answers a lost race without logging it as a failure', async () => {
    const failures: unknown[] = []
    const { service, store } = await harness({ onError: (_id, error) => failures.push(error) })
    vi.spyOn(store, 'insertQuote').mockRejectedValueOnce(
      new UniqueConstraintError('UNIQUE constraint failed: asset_rfq_swap.rfq_id'),
    )
    expect(await service.quote(request())).toMatchObject({ accepted: false, reason: 'duplicate_swap' })
    expect(failures).toEqual([])
  })

  it('lets a non-constraint failure whose message says UNIQUE surface', async () => {
    const { service, store } = await harness()
    vi.spyOn(store, 'insertQuote').mockRejectedValueOnce(new TypeError('UNIQUE quote construction failed'))
    await expect(service.quote(request())).rejects.toThrow(TypeError)
  })

  it('does not record a row when it refuses', async () => {
    const { service, store } = await harness()
    await service.quote(request({ pair: 'arkade:BTC->arkade:BTC' }))
    expect(await store.listNonTerminal()).toHaveLength(0)
  })
})

describe('tick — driving a negotiation', () => {
  it('leaves a quoted row alone while nothing is funded and the quote is live', async () => {
    const { service, store } = await harness()
    await service.quote(request())
    await service.tick('swap-1')
    expect((await store.get('swap-1')).state).toBe('quoted')
  })

  /**
   * § 5: a quote that lapses unfunded expires. Nothing was ever at stake, so
   * the row is `refused` rather than stuck — and no refund is owed, because
   * nothing was deposited.
   */
  it('expires a quote nobody funded', async () => {
    const { service, store, tick } = await harness()
    await service.quote(request())
    tick(1_031)
    await service.tick('swap-1')
    expect(await store.get('swap-1')).toMatchObject({ state: 'refused' })
    expect((await store.get('swap-1')).failureReason).toMatch(/expired/)
  })

  it('records the deposit and moves to funded when one appears', async () => {
    const { service, store } = await harness({ depositAt: async () => deposit() })
    await service.quote(request())
    await service.tick('swap-1')
    expect(await store.get('swap-1')).toMatchObject({ state: 'funded', depositTxid: 'ff'.repeat(32), depositVout: 0 })
  })

  it('re-points the row at the outpoint it decided about before filling', async () => {
    const spent: (string | null)[] = []
    let live = deposit({ txid: 'aa'.repeat(32) })
    const { service, store } = await harness({
      depositAt: async () => live,
      settle: async (row) => {
        spent.push(row.depositTxid)
        return 'fa'.repeat(32)
      },
    })
    await service.quote(request())
    await service.tick('swap-1')
    expect((await store.get('swap-1')).depositTxid).toBe('aa'.repeat(32))
    live = deposit({ txid: 'bb'.repeat(32), vout: 3, sats: 200_000_000n })
    await service.tick('swap-1')
    expect(spent).toEqual(['bb'.repeat(32)])
    expect(await store.get('swap-1')).toMatchObject({ depositTxid: 'bb'.repeat(32), depositVout: 3 })
  })

  it('fills a funded row and records the fill txid', async () => {
    const { service, store, settled } = await harness({ depositAt: async () => deposit() })
    await service.quote(request())
    await service.tick('swap-1')
    await service.tick('swap-1')
    expect(settled).toEqual(['swap-1'])
    expect(await store.get('swap-1')).toMatchObject({ state: 'filled', fillTxid: 'fa'.repeat(32) })
  })

  /**
   * THE ACTION-TIME GATE, and the reason it cannot be inherited from quote
   * time. The covenant obliges the full payout whatever was deposited, so
   * filling against a short deposit pays the quoted amount for less than the
   * quoted input — out of this solver's own float.
   */
  it('never fills against a deposit short of the quoted amount', async () => {
    const { service, store, settled } = await harness({
      depositAt: async () => deposit({ sats: 99_999_999n }),
    })
    await service.quote(request())
    await service.tick('swap-1')
    await service.tick('swap-1')
    expect(settled).toEqual([])
    expect((await store.get('swap-1')).state).toBe('refused')
  })

  /**
   * § 5's late-funding rule, which bites hardest on a cross-asset pair: the
   * solver is short the market for the whole window, so filling a lapsed quote
   * is filling at a price the market has already left. The client is not
   * stranded — it reclaims with `cancel`, a 2-of-2 needing no solver signature.
   */
  it('never fills a deposit that arrived after the quote expired', async () => {
    const { service, store, settled, tick } = await harness({ depositAt: async () => deposit() })
    await service.quote(request())
    tick(1_031)
    await service.tick('swap-1')
    expect(settled).toEqual([])
    expect((await store.get('swap-1')).state).toBe('refused')
  })

  it('refuses to fill when the float has drained since quoting', async () => {
    let held = 10n ** 18n
    const { service, store, settled } = await harness({
      depositAt: async () => deposit(),
      balance: async () => new Map([[ASSET_A, held]]),
    })
    await service.quote(request())
    await service.tick('swap-1')
    held = 1n
    await service.tick('swap-1')
    expect(settled).toEqual([])
    expect((await store.get('swap-1')).state).toBe('refused')
  })

  /**
   * Stuck-over-silence (§ 8). A `settle` that threw may still have been
   * submitted, so the row must land somewhere a human looks — never in a state
   * a later sweep would retry, which is how a solver double-spends its float.
   */
  it('parks a fill that threw as stuck, not as a retryable failure', async () => {
    const { service, store } = await harness({
      depositAt: async () => deposit(),
      settle: async () => {
        throw new Error('emulator refused')
      },
    })
    await service.quote(request())
    await service.tick('swap-1')
    await service.tick('swap-1')
    expect(await store.get('swap-1')).toMatchObject({ state: 'stuck' })
    expect((await store.get('swap-1')).failureReason).toMatch(/emulator refused/)
  })

  it('escalates a row found still filling to stuck rather than resubmitting', async () => {
    // A crash between submitting and recording leaves `filling`. Whether the
    // spend landed is not knowable from here, and guessing either way risks
    // paying twice.
    const { service, store, settled } = await harness({ depositAt: async () => deposit() })
    await service.quote(request())
    await service.tick('swap-1')
    await store.transition('swap-1', 'funded', 'filling')
    await service.tick('swap-1')
    expect(settled).toEqual([])
    expect((await store.get('swap-1')).state).toBe('stuck')
  })

  it('is re-entrant on a terminal row', async () => {
    const { service, store } = await harness()
    await service.quote(request())
    await store.fail('swap-1', 'quoted', 'declined')
    await service.tick('swap-1')
    expect((await store.get('swap-1')).state).toBe('refused')
  })
})

describe('tickAll — the periodic pass', () => {
  it('drives every non-terminal row and answers which', async () => {
    const { service, store, tick } = await harness({
      newId: sequentialIds(),
      deriveOffer: perClientOffer,
    })
    await service.quote(request())
    await service.quote(request({ rfqId: 'f'.repeat(64), makerPublicKey: 'c'.repeat(64) }))
    tick(1_031)
    expect((await service.tickAll()).sort()).toEqual(['swap-1', 'swap-2'])
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  /**
   * The reason `tickAll` is required rather than `findRecoverable` + `tick` in
   * a loop: a row waiting on a DEADLINE sees no script activity, so only a
   * periodic pass moves it. Without this, a quote nobody funded would sit in
   * `quoted` for ever.
   */
  it('expires a lapsed quote that no script activity would ever wake', async () => {
    const { service, store, tick } = await harness()
    await service.quote(request())
    tick(9_999)
    await service.tickAll()
    expect((await store.get('swap-1')).state).toBe('refused')
  })

  it('isolates one failing row from the rest of the sweep', async () => {
    let calls = 0
    const { service, store } = await harness({
      newId: sequentialIds(),
      deriveOffer: perClientOffer,
      depositAt: async () => {
        calls += 1
        if (calls === 1) throw new Error('indexer blip')
        return null
      },
    })
    await service.quote(request())
    await service.quote(request({ rfqId: 'f'.repeat(64), makerPublicKey: 'c'.repeat(64) }))
    await expect(service.tickAll()).resolves.toBeDefined()
    // The second row was still visited despite the first throwing.
    expect(calls).toBe(2)
    expect(await store.listNonTerminal()).toHaveLength(2)
  })
})

describe('the market mark', () => {
  it('records the price the quote FIXED, not the feed it came from', async () => {
    const { service, store } = await harness()
    await service.quote(request())

    const row = await store.get('swap-1')
    // 1 BTC in, 99,500 USDA out at 50bps against a feed of 100,000 — carried at
    // the feed's scale plus the headroom that keeps a coarse feed from
    // quantising the price into nonsense.
    expect(row.quoteImpliedScale).toBe(0 + IMPLIED_PRICE_HEADROOM)
    expect(row.quoteImpliedMantissa).toBe(99_500n * 10n ** BigInt(IMPLIED_PRICE_HEADROOM))
    expect(row.quoteGivesBase).toBe(true)
    // Storing the feed instead is the tautology this replaced: the payout is
    // derived FROM it, so the two can never disagree by more than the spread.
    expect(row.quoteImpliedMantissa).not.toBe(100_000n)
  })

  it('records the same price whether or not the carrier is priced', async () => {
    const struck = async (carrierSats: bigint) => {
      const { service, store } = await harness({ markets: [{ ...MARKET, carrierSats }] })
      await service.quote(request({ amount: 50_000n }))
      return store.get('swap-1')
    }
    const off = await struck(0n)
    const on = await struck(330n)
    expect(on.quoteImpliedMantissa).toBe(off.quoteImpliedMantissa)
    expect(on.quoteImpliedMantissa).toBe(99_500n * 10n ** BigInt(IMPLIED_PRICE_HEADROOM))
    expect(on.toAmount).not.toBe(off.toAmount)
  })

  it('reads the feed again when the fill lands, and keeps that second number', async () => {
    let reads = 0
    const { service, store } = await harness({
      depositAt: async () => deposit(),
      fetchPrice: async () => {
        reads += 1
        return reads === 1 ? { mantissa: 100_000n, scale: 0 } : { mantissa: 90_000n, scale: 0 }
      },
    })
    await service.quote(request())
    await service.tick('swap-1')
    await service.tick('swap-1')

    expect(await store.get('swap-1')).toMatchObject({
      state: 'filled',
      quoteImpliedMantissa: 99_500n * 10n ** BigInt(IMPLIED_PRICE_HEADROOM),
      fillPriceMantissa: 90_000n,
      fillPriceScale: 0,
    })
  })

  // Quoting reads the live list and the mark read the boot one, so a market added
  // after boot quoted correctly and then went unmarked forever — a P&L loss, not a money one.
  it('marks a fill on a market added live, not only one present at boot', async () => {
    const errors: unknown[][] = []
    const { service, store } = await harness({
      markets: [],
      depositAt: async () => deposit(),
      onError: (id, error) => errors.push([id, error]),
    })
    await service.replaceMarkets([MARKET])
    await service.quote(request())
    await service.tick('swap-1')
    await service.tick('swap-1')

    expect(errors).toEqual([])
    expect(await store.get('swap-1')).toMatchObject({ state: 'filled', fillPriceMantissa: 100_000n })
  })

  /**
   * The property that must never regress. A price feed is a third party, and a
   * swap whose money has already moved must not be reported as anything other
   * than filled because that third party was unreachable.
   *
   * The ERROR CHANNEL is what makes this test discriminating, and the row state
   * is not: an unguarded read throws into the fill's own catch, whose
   * `fail(id, 'filling', …)` is a compare-and-swap that no-ops against a row
   * already `filled`. The state therefore looks identical either way, and only
   * the reported fault distinguishes a feed being down from a swap going wrong.
   */
  it('still FILLS when the feed cannot be read as the fill lands, and blames the FEED', async () => {
    let reads = 0
    const errors: unknown[][] = []
    const { service, store, settled } = await harness({
      depositAt: async () => deposit(),
      onError: (id, error) => errors.push([id, error]),
      fetchPrice: async () => {
        reads += 1
        if (reads > 1) throw new Error('the feed is down')
        return { mantissa: 100_000n, scale: 0 }
      },
    })
    await service.quote(request())
    await service.tick('swap-1')
    await service.tick('swap-1')

    expect(settled).toEqual(['swap-1'])
    expect(await store.get('swap-1')).toMatchObject({
      state: 'filled',
      fillTxid: 'fa'.repeat(32),
      // Unmeasured, never zero.
      fillPriceMantissa: null,
    })
    expect(errors.map(([id]) => id)).toEqual(['price'])
  })

  /**
   * `updated_at` is settlement time on this corridor — `assetRfqEconomics` reads
   * it as `settledAt`, so it sets `durationSeconds`, the x-axis of the very
   * chart the mark is plotted on. Bumping it by the feed's latency would stretch
   * every MARKED fill's duration and only the marked ones, biasing exactly the
   * rows being compared against each other. It also windows `ledgerRows` and is
   * published to the client in `rfq_status`.
   */
  it('does not move settlement time when it records the mark', async () => {
    let reads = 0
    const { service, store, tick } = await harness({
      depositAt: async () => deposit(),
      fetchPrice: async () => {
        reads += 1
        // The clock advances while the feed is being read, as a real one does.
        if (reads > 1) tick(9_999)
        return { mantissa: 100_000n, scale: 0 }
      },
    })
    await service.quote(request())
    await service.tick('swap-1')
    await service.tick('swap-1')

    const row = await store.get('swap-1')
    expect(row.fillPriceMantissa).toBe(100_000n)
    expect(row.updatedAt).not.toBe(9_999)
  })

  it('does not mark a fill against a price of zero', async () => {
    let reads = 0
    const { service, store } = await harness({
      depositAt: async () => deposit(),
      fetchPrice: async () => {
        reads += 1
        return reads === 1 ? { mantissa: 100_000n, scale: 0 } : { mantissa: 0n, scale: 0 }
      },
    })
    await service.quote(request())
    await service.tick('swap-1')
    await service.tick('swap-1')

    expect(await store.get('swap-1')).toMatchObject({ state: 'filled', fillPriceMantissa: null })
  })
})

describe('replaceMarkets', () => {
  it('starts quoting a market that was empty at construction', async () => {
    const { service } = await harness({ markets: [] })
    expect(await service.quote(request())).toMatchObject({ accepted: false, reason: 'unsupported_pair' })
    await service.replaceMarkets([MARKET])
    expect(await service.quote(request())).toMatchObject({ accepted: true })
  })

  it('refuses new quotes after the market is dropped, and fills the in-flight one at quoted terms', async () => {
    const { service, store, settled } = await harness({ depositAt: async () => deposit() })
    const quoted = await service.quote(request())
    if (!quoted.accepted) throw new Error('expected a quote')
    const { fromAmount, toAmount } = quoted.swap
    await service.replaceMarkets([])
    expect(await service.quote(request({ rfqId: 'f'.repeat(64) }))).toMatchObject({
      accepted: false,
      reason: 'unsupported_pair',
    })
    await service.tick('swap-1')
    await service.tick('swap-1')
    expect(settled).toEqual(['swap-1'])
    expect(await store.get('swap-1')).toMatchObject({ state: 'filled', fromAmount, toAmount })
  })

  it('does not restate an issued outcome when the serve list is swapped behind it', async () => {
    const { service } = await harness({
      markets: [{ ...MARKET, carrierSats: 330n }],
      newId: sequentialIds(),
      deriveOffer: perClientOffer,
    })
    const quoted = service.quote(request())
    const swapping = service.replaceMarkets([{ ...MARKET, carrierSats: 0n }])
    const outcome = await quoted
    expect(outcome.accepted && outcome.carrierSats).toBe(330n)
    await swapping
    // Premise: the swap really landed, so the 330n above is a captured figure and not a no-op.
    const next = await service.quote(request({ rfqId: 'f'.repeat(64), makerPublicKey: 'c'.repeat(64) }))
    expect(next.accepted && next.carrierSats).toBe(0n)
  })

  it('waits for an in-flight quote before swapping the list', async () => {
    let release!: (price: { mantissa: bigint; scale: number }) => void
    const blocked = new Promise<{ mantissa: bigint; scale: number }>((resolve) => {
      release = resolve
    })
    const { service } = await harness({ fetchPrice: () => blocked })
    const quoting = service.quote(request())
    let replaced = false
    const replacing = service.replaceMarkets([]).then(() => {
      replaced = true
    })
    await Promise.resolve()
    expect(replaced).toBe(false)
    release({ mantissa: 100_000n, scale: 0 })
    expect(await quoting).toMatchObject({ accepted: true })
    await replacing
    expect(replaced).toBe(true)
    expect(await service.quote(request({ rfqId: 'f'.repeat(64) }))).toMatchObject({
      accepted: false,
      reason: 'unsupported_pair',
    })
  })
})

/**
 * The OPTIONAL `profile.carrier` mode, and the internal Taxi adapter behind
 * `recycle`.
 *
 * The mode is a statement about WHICH carrier the client wants, so it is
 * answered before the price is read and its own terms are never derived from a
 * client-supplied flag. `recycle` is priced off the internal adapter alone —
 * an absent one refuses rather than quoting the market pass-through, which
 * would price a carrier nothing can fund.
 */
const RECEIVER_QUOTE: ReceiveCarrierQuote = {
  quoteId: 'q-1',
  makerPkScript: PK_SCRIPT,
  makerPublicKey: XONLY,
  assetId: ASSET_A,
  physicalSats: 330n,
  loanSats: 329n,
  receiptSats: 1n,
  serviceFareSats: 0n,
  inputExpiryFloor: { kind: 'height', value: 1_000_000n },
  expiresAt: 5_000,
}

/** A recycle whose receipt and service do NOT divide the dust evenly. */
const RAGGED_RECEIVER_QUOTE: ReceiveCarrierQuote = {
  ...RECEIVER_QUOTE,
  loanSats: 325n,
  receiptSats: 5n,
  serviceFareSats: 7n,
  expiresAt: 6_000,
}

const adapter = (
  over: Partial<ReceiveCarrierQuote> = {},
  calls?: unknown[],
  actions: Partial<Pick<ReceiveCarrierQuotes, 'available' | 'settle' | 'reconcile'>> = {},
) => ({
  resolve: async (request: unknown) => {
    calls?.push(request)
    return { ...RECEIVER_QUOTE, ...over }
  },
  available: actions.available ?? (async () => new Map([[ASSET_A, 10n ** 18n]])),
  settle: actions.settle ?? (async () => 'fb'.repeat(32)),
  reconcile: actions.reconcile ?? (async () => ({ status: 'pending' as const })),
})

const ONE_SAT_RECEIVE: ReceiveCarrierQuote = {
  ...RECEIVER_QUOTE,
  loanSats: 329n,
  receiptSats: 1n,
  serviceFareSats: 0n,
}

const BOUNDARY_MARKET = {
  ...MARKET,
  feeBps: 0,
  sellBase: { min: 1_000n, max: 10n ** 24n },
  buyBase: { min: 1n, max: 10n ** 24n },
}

describe('profile.carrier — explicit modes', () => {
  it('prices the physical dust on a purchase, even where the market waived it', async () => {
    const { service, store } = await harness({ markets: [{ ...MARKET, carrierSats: 0n }] })
    const outcome = await service.quote(request({ carrier: { mode: 'purchase' } }))
    expect(outcome.accepted && outcome.carrierSats).toBe(330n)
    expect((outcome as { swap: { toAmount: bigint } }).swap.toAmount).toBe(99_499_671_650n)
    // The terms ARE persisted: a purchase still acquires sats, and the fill
    // adapter needs to know which carrier it was authorized to buy.
    expect((await store.get('swap-1')).carrierTerms).toMatchObject({
      mode: 'purchase',
      physicalSats: 330n,
      // Bought, not borrowed: no returnable principal is recorded.
      loanSats: 0n,
      pricedSats: 330n,
    })
  })

  it('prices the receipt and service, not the returnable loan, on a recycle', async () => {
    const { service, store } = await harness({
      markets: [{ ...MARKET, carrierSats: 0n }],
      receiveCarrierQuotes: adapter({ serviceFareSats: 4n }),
    })
    const outcome = await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))
    expect(outcome).toMatchObject({ accepted: true })
    // 5 sats bought (1 receipt + 4 service), NOT 330 — the loan is Taxi's
    // principal and arrives at claim. The published carrier_sats is still the
    // PHYSICAL dust, because that is what the client attaches to the deposit.
    expect(outcome.accepted && outcome.carrierSats).toBe(330n)
    expect((outcome as { swap: { toAmount: bigint } }).swap.toAmount).toBe(99_499_995_025n)
    expect((await store.get('swap-1')).carrierTerms).toMatchObject({
      mode: 'recycle',
      quoteId: 'q-1',
      physicalSats: 330n,
      loanSats: 329n,
      receiptSats: 1n,
      serviceFareSats: 4n,
      pricedSats: 5n,
      expiresAt: 5_000,
    })
  })

  it.each([
    ['height', { kind: 'height', value: 499_999_999n }],
    ['time', { kind: 'time', value: 500_000_000n }],
    ['maximum time', { kind: 'time', value: 4_294_967_295n }],
  ] as const)('accepts a recycle with a valid %s input expiry floor', async (_why, inputExpiryFloor) => {
    const { service } = await harness({ receiveCarrierQuotes: adapter({ inputExpiryFloor }) })
    expect(await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))).toMatchObject({
      accepted: true,
    })
  })

  it('uses request-bound carrier inventory after pricing without reading generic balance', async () => {
    let clock = 1_000
    const asks: unknown[] = []
    const available = vi.fn(async (ask: unknown) => {
      asks.push(ask)
      return new Map([[ASSET_A, 10n ** 18n]])
    })
    const balance = vi.fn(async () => new Map([[ASSET_A, 0n]]))
    const { service } = await harness({
      now: () => clock,
      fetchPrice: async () => {
        clock = 1_005
        return { mantissa: 100_000n, scale: 0 }
      },
      balance,
      receiveCarrierQuotes: adapter({}, undefined, { available }),
    })

    expect(await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))).toMatchObject({
      accepted: true,
    })
    expect(asks).toEqual([
      {
        quoteId: 'q-1',
        makerPkScript: PK_SCRIPT,
        makerPublicKey: XONLY,
        assetId: ASSET_A,
        now: 1_005,
        admission: true,
      },
    ])
    expect(balance).not.toHaveBeenCalled()
  })

  it('refuses a recycle when carrier inventory is empty despite a rich generic balance', async () => {
    const balance = vi.fn(async () => new Map([[ASSET_A, 10n ** 18n]]))
    const { service, store } = await harness({
      balance,
      receiveCarrierQuotes: adapter({}, undefined, { available: async () => new Map() }),
    })

    expect(await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))).toMatchObject({
      accepted: false,
      reason: 'insufficient_inventory',
    })
    expect(balance).not.toHaveBeenCalled()
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('refuses and reports a carrier inventory read failure at quote admission', async () => {
    const errors: { id: string; error: unknown }[] = []
    const failure = new Error('carrier inventory unavailable')
    const { service, store } = await harness({
      receiveCarrierQuotes: adapter({}, undefined, {
        available: async () => Promise.reject(failure),
      }),
      onError: (id, error) => errors.push({ id, error }),
    })

    expect(await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))).toMatchObject({
      accepted: false,
      reason: 'price_unavailable',
    })
    expect(errors).toEqual([{ id: 'carrier', error: failure }])
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it.each([
    ['purchase exact-in consumed by the 330-sat carrier', { mode: 'purchase' }, 330n, 'from', 'fee_consumes_swap'],
    ['purchase exact-out below the 1,000-unit asset minimum', { mode: 'purchase' }, 999n, 'to', 'amount_out_of_range'],
    [
      'recycle exact-in consumed by its 1-sat receipt price',
      { mode: 'recycle', quoteId: 'q-1' },
      1n,
      'from',
      'fee_consumes_swap',
    ],
    [
      'recycle exact-out below the 1,000-unit asset minimum',
      { mode: 'recycle', quoteId: 'q-1' },
      999n,
      'to',
      'amount_out_of_range',
    ],
  ] as const)('refuses %s', async (_why, carrier, amount, amountSide, reason) => {
    const { service } = await harness({
      markets: [{ ...BOUNDARY_MARKET, carrierSats: 0n }],
      receiveCarrierQuotes: adapter(ONE_SAT_RECEIVE),
    })
    expect(await service.quote(request({ amount, amountSide, carrier }))).toMatchObject({ accepted: false, reason })
  })

  it.each([
    ['purchase exact-in', { mode: 'purchase' }, 331n, 'from', 331n],
    ['purchase exact-out', { mode: 'purchase' }, 1_000n, 'to', 331n],
  ] as const)('prices %s at the asset minimum', async (_why, carrier, amount, amountSide, fromAmount) => {
    const { service, store } = await harness({ markets: [{ ...BOUNDARY_MARKET, carrierSats: 0n }] })
    const outcome = await service.quote(request({ amount, amountSide, carrier }))
    expect(outcome).toMatchObject({ accepted: true, carrierSats: 330n })
    expect((outcome as { swap: { fromAmount: bigint; toAmount: bigint } }).swap).toMatchObject({
      fromAmount,
      toAmount: 1_000n,
    })
    expect((await store.get('swap-1')).carrierTerms).toEqual({
      mode: 'purchase',
      physicalSats: 330n,
      loanSats: 0n,
      receiptSats: 0n,
      serviceFareSats: 0n,
      pricedSats: 330n,
      expiresAt: 1_030,
    })
  })

  it.each([
    ['recycle exact-in', 2n, 'from'],
    ['recycle exact-out', 1_000n, 'to'],
  ] as const)('prices %s at the asset minimum', async (_why, amount, amountSide) => {
    const { service, store } = await harness({
      markets: [{ ...BOUNDARY_MARKET, carrierSats: 0n }],
      receiveCarrierQuotes: adapter(ONE_SAT_RECEIVE),
    })
    const outcome = await service.quote(request({ amount, amountSide, carrier: { mode: 'recycle', quoteId: 'q-1' } }))
    expect(outcome).toMatchObject({ accepted: true, carrierSats: 330n })
    expect((outcome as { swap: { fromAmount: bigint; toAmount: bigint } }).swap).toMatchObject({
      fromAmount: 2n,
      toAmount: 1_000n,
    })
    expect((await store.get('swap-1')).carrierTerms).toEqual({
      mode: 'recycle',
      quoteId: 'q-1',
      physicalSats: 330n,
      loanSats: 329n,
      receiptSats: 1n,
      serviceFareSats: 0n,
      pricedSats: 1n,
      expiresAt: 5_000,
    })
  })

  it('prices a recycle on exact-out, binding the payout the client named', async () => {
    const { service, store } = await harness({
      markets: [{ ...MARKET, carrierSats: 0n }],
      receiveCarrierQuotes: adapter({ serviceFareSats: 4n }),
    })
    const outcome = await service.quote(
      request({ amount: 1_000_000n, amountSide: 'to', carrier: { mode: 'recycle', quoteId: 'q-1' } }),
    )
    expect(outcome).toMatchObject({ accepted: true })
    expect(outcome.accepted && outcome.carrierSats).toBe(330n)
    expect((outcome as { swap: { toAmount: bigint } }).swap.toAmount).toBe(1_000_000n)
    expect((await store.get('swap-1')).carrierTerms).toMatchObject({ mode: 'recycle', pricedSats: 5n })
  })

  it.each([
    ['exact-in', 1_000_000n, 'from', 994_988_060n],
    ['exact-out', 1_000_000n, 'to', 1_000_000n],
  ] as const)('prices a recycle with an odd receipt split on %s', async (_why, amount, side, toAmount) => {
    const { service, store } = await harness({
      receiveCarrierQuotes: adapter(RAGGED_RECEIVER_QUOTE),
      newId: sequentialIds(),
    })
    const outcome = await service.quote(
      request({ amount, amountSide: side, carrier: { mode: 'recycle', quoteId: 'q-1' } }),
    )
    expect(outcome).toMatchObject({ accepted: true })
    expect(outcome.accepted && outcome.carrierSats).toBe(330n)
    expect((outcome as { swap: { toAmount: bigint } }).swap.toAmount).toBe(toAmount)
    expect((await store.get('swap-1')).carrierTerms).toMatchObject({
      physicalSats: 330n,
      loanSats: 325n,
      receiptSats: 5n,
      serviceFareSats: 7n,
      pricedSats: 12n,
    })
  })

  it('caps valid_until at the carrier quote expiry', async () => {
    const { service } = await harness({ receiveCarrierQuotes: adapter({ expiresAt: 1_010 }) })
    const outcome = await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))
    expect(outcome.accepted && outcome.swap.validUntil).toBe(1_010)
  })

  it('re-reads the clock after the adapter answers, and refuses terms that expired meanwhile', async () => {
    const { service, store, tick } = await harness({
      receiveCarrierQuotes: {
        ...adapter(),
        resolve: async () => {
          tick(1_005)
          return RECEIVER_QUOTE
        },
      },
    })
    // The adapter reported 5_000 at the OLD clock; by the time it answered the
    // quote was still live, so this must quote and cap against the NEW clock.
    const outcome = await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))
    expect(outcome.accepted && outcome.swap.validUntil).toBe(1_035)
    expect((await store.get('swap-1')).carrierTerms?.expiresAt).toBe(5_000)
  })

  it('fails an expired recycle before creating a row', async () => {
    const { service, store, tick } = await harness({
      receiveCarrierQuotes: {
        ...adapter(),
        resolve: async () => {
          tick(5_001)
          return RECEIVER_QUOTE
        },
      },
    })
    const outcome = await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))
    expect(outcome).toMatchObject({ accepted: false, reason: 'price_unavailable' })
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('fails a recycle the clock expired while the feed was read', async () => {
    const { service, store, tick } = await harness({
      receiveCarrierQuotes: adapter({ expiresAt: 1_004 }),
      fetchPrice: async () => {
        tick(1_004)
        return { mantissa: 100_000n, scale: 0 }
      },
    })
    const outcome = await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))
    expect(outcome).toMatchObject({ accepted: false, reason: 'price_unavailable' })
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('fails an expired recycle that the carrier inventory read outlived', async () => {
    const { service, store, tick } = await harness({
      receiveCarrierQuotes: adapter({ expiresAt: 1_004 }, undefined, {
        available: async () => {
          tick(1_004)
          return new Map([[ASSET_A, 10n ** 18n]])
        },
      }),
    })
    const outcome = await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))
    expect(outcome).toMatchObject({ accepted: false, reason: 'price_unavailable' })
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('keeps a purchase valid on the clock it was priced at', async () => {
    const { service, tick } = await harness({
      markets: [{ ...MARKET, carrierSats: 0n }],
      quoteValiditySeconds: 60,
      fetchPrice: async () => {
        tick(1_040)
        return { mantissa: 100_000n, scale: 0 }
      },
    })
    const outcome = await service.quote(request({ carrier: { mode: 'purchase' } }))
    expect(outcome.accepted && outcome.swap.validUntil).toBe(1_060)
  })

  it('leaves valid_until at the configured window when the quote outlives it', async () => {
    const { service } = await harness({ receiveCarrierQuotes: adapter({ expiresAt: 9_999 }) })
    const outcome = await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))
    expect(outcome.accepted && outcome.swap.validUntil).toBe(1_030)
  })

  it('does not touch the adapter for a purchase, which buys rather than borrows', async () => {
    const calls: unknown[] = []
    const { service } = await harness({ receiveCarrierQuotes: adapter({}, calls) })
    await service.quote(request({ carrier: { mode: 'purchase' } }))
    expect(calls).toEqual([])
  })

  it('leaves a legacy quote byte-identical, with no terms and no adapter call', async () => {
    const calls: unknown[] = []
    const { service, store } = await harness({
      markets: [{ ...MARKET, carrierSats: 330n }],
      receiveCarrierQuotes: adapter({}, calls),
    })
    const outcome = await service.quote(request())
    expect(outcome.accepted && outcome.carrierSats).toBe(330n)
    expect((outcome as { swap: { toAmount: bigint } }).swap.toAmount).toBe(99_499_671_650n)
    expect((await store.get('swap-1')).carrierTerms).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('profile.carrier — persisted settlement mode', () => {
  const recycleRequest = () => request({ carrier: { mode: 'recycle', quoteId: 'q-1' } })

  it('settles a persisted recycle from request-bound carrier inventory without reading generic balance', async () => {
    let clock = 1_000
    const direct = vi.fn(async () => 'fa'.repeat(32))
    const settle = vi.fn<ReceiveCarrierQuotes['settle']>(async () => 'fb'.repeat(32))
    const asks: unknown[] = []
    const available = vi.fn(async (ask: unknown) => {
      asks.push(ask)
      return new Map([[ASSET_A, 10n ** 18n]])
    })
    const balance = vi.fn(async () => new Map([[ASSET_A, 0n]]))
    const receiveCarrierQuotes = adapter({}, undefined, { available, settle })
    const { service, store } = await harness({
      now: () => clock,
      depositAt: async () => deposit(),
      balance,
      settle: direct,
      receiveCarrierQuotes,
    })
    const mark = vi.spyOn(store, 'recordFillMark')

    await service.quote(recycleRequest())
    await service.tick('swap-1')
    clock = 1_010
    await service.tick('swap-1')
    await service.tick('swap-1')

    // Admission on the quote, the exact anchored floor on the funded row's read.
    expect(asks).toEqual([
      {
        quoteId: 'q-1',
        makerPkScript: PK_SCRIPT,
        makerPublicKey: XONLY,
        assetId: ASSET_A,
        now: 1_000,
        admission: true,
      },
      {
        quoteId: 'q-1',
        makerPkScript: PK_SCRIPT,
        makerPublicKey: XONLY,
        assetId: ASSET_A,
        now: 1_010,
      },
    ])
    expect(balance).not.toHaveBeenCalled()
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle.mock.calls[0]![0].carrierTerms?.mode).toBe('recycle')
    expect(direct).not.toHaveBeenCalled()
    expect(mark).toHaveBeenCalledTimes(1)
    expect(await store.get('swap-1')).toMatchObject({ state: 'filled', fillTxid: 'fb'.repeat(32) })
  })

  it('keeps purchase and legacy rows on direct settlement', async () => {
    for (const carrier of [undefined, { mode: 'purchase' as const }]) {
      const direct = vi.fn(async () => 'fa'.repeat(32))
      const dedicated = vi.fn(async () => 'fb'.repeat(32))
      const available = vi.fn(async () => new Map([[ASSET_A, 10n ** 18n]]))
      const balance = vi.fn(async () => new Map([[ASSET_A, 10n ** 18n]]))
      const receiveCarrierQuotes = adapter({}, undefined, { available, settle: dedicated })
      const { service, store } = await harness({
        depositAt: async () => deposit(),
        balance,
        settle: direct,
        receiveCarrierQuotes,
      })

      await service.quote(request(carrier === undefined ? {} : { carrier }))
      await service.tick('swap-1')
      await service.tick('swap-1')

      expect(direct).toHaveBeenCalledTimes(1)
      expect(dedicated).not.toHaveBeenCalled()
      expect(balance).toHaveBeenCalledTimes(2)
      expect(available).not.toHaveBeenCalled()
      expect((await store.get('swap-1')).state).toBe('filled')
    }
  })

  it('refuses a funded recycle when carrier inventory drained despite a rich generic balance', async () => {
    const direct = vi.fn(async () => 'fa'.repeat(32))
    const dedicated = vi.fn(async () => 'fb'.repeat(32))
    const available = vi
      .fn<ReceiveCarrierQuotes['available']>()
      .mockResolvedValueOnce(new Map([[ASSET_A, 10n ** 18n]]))
      .mockResolvedValue(new Map())
    const balance = vi.fn(async () => new Map([[ASSET_A, 10n ** 18n]]))
    const { service, store } = await harness({
      depositAt: async () => deposit(),
      balance,
      settle: direct,
      receiveCarrierQuotes: adapter({}, undefined, { available, settle: dedicated }),
    })

    await service.quote(recycleRequest())
    await service.tick('swap-1')
    await service.tick('swap-1')

    expect(balance).not.toHaveBeenCalled()
    expect(direct).not.toHaveBeenCalled()
    expect(dedicated).not.toHaveBeenCalled()
    expect(await store.get('swap-1')).toMatchObject({
      state: 'refused',
      failureReason: 'not filled: insufficient_inventory',
    })
  })

  it('refuses and reports a carrier inventory read failure before filling', async () => {
    const failure = new Error('carrier inventory unavailable')
    const available = vi
      .fn<ReceiveCarrierQuotes['available']>()
      .mockResolvedValueOnce(new Map([[ASSET_A, 10n ** 18n]]))
      .mockRejectedValue(failure)
    const direct = vi.fn(async () => 'fa'.repeat(32))
    const dedicated = vi.fn(async () => 'fb'.repeat(32))
    const errors: { id: string; error: unknown }[] = []
    const { service, store } = await harness({
      depositAt: async () => deposit(),
      settle: direct,
      receiveCarrierQuotes: adapter({}, undefined, { available, settle: dedicated }),
      onError: (id, error) => errors.push({ id, error }),
    })

    await service.quote(recycleRequest())
    await service.tick('swap-1')
    await service.tick('swap-1')

    expect(errors).toEqual([{ id: 'swap-1', error: failure }])
    expect(direct).not.toHaveBeenCalled()
    expect(dedicated).not.toHaveBeenCalled()
    expect(await store.get('swap-1')).toMatchObject({ state: 'refused' })
  })

  it('refuses before filling when the deadline passes inside carrier inventory admission', async () => {
    let clock = 1_000
    const available = vi
      .fn<ReceiveCarrierQuotes['available']>()
      .mockResolvedValueOnce(new Map([[ASSET_A, 10n ** 18n]]))
      .mockImplementationOnce(async () => {
        clock = 1_031
        return new Map([[ASSET_A, 10n ** 18n]])
      })
    const direct = vi.fn(async () => 'fa'.repeat(32))
    const dedicated = vi.fn(async () => 'fb'.repeat(32))
    const { service, store } = await harness({
      now: () => clock,
      depositAt: async () => deposit(),
      settle: direct,
      receiveCarrierQuotes: adapter({}, undefined, { available, settle: dedicated }),
    })

    await service.quote(recycleRequest())
    await service.tick('swap-1')
    await service.tick('swap-1')

    expect(direct).not.toHaveBeenCalled()
    expect(dedicated).not.toHaveBeenCalled()
    expect(await store.get('swap-1')).toMatchObject({
      state: 'refused',
      failureReason: 'not filled: quote_expired',
    })
  })

  it('refuses a funded recycle when the adapter has only the former three methods', async () => {
    const direct = vi.fn(async () => 'fa'.repeat(32))
    const dedicated = vi.fn(async () => 'fb'.repeat(32))
    const complete = adapter({}, undefined, { settle: dedicated })
    const { service, store, deps } = await harness({
      depositAt: async () => deposit(),
      settle: direct,
      receiveCarrierQuotes: complete,
    })

    await service.quote(recycleRequest())
    await service.tick('swap-1')
    const { available: _available, ...threeMethods } = complete
    await new AssetRfqSwapService({
      ...deps,
      receiveCarrierQuotes: threeMethods as unknown as ReceiveCarrierQuotes,
    }).tick('swap-1')

    expect(direct).not.toHaveBeenCalled()
    expect(dedicated).not.toHaveBeenCalled()
    expect(await store.get('swap-1')).toMatchObject({ state: 'refused' })
  })

  it('refuses a funded recycle when the adapter disappeared before spending', async () => {
    const direct = vi.fn(async () => 'fa'.repeat(32))
    const dedicated = vi.fn(async () => 'fb'.repeat(32))
    const receiveCarrierQuotes = adapter({}, undefined, { settle: dedicated })
    const { service, store, deps } = await harness({
      depositAt: async () => deposit(),
      settle: direct,
      receiveCarrierQuotes,
    })

    await service.quote(recycleRequest())
    await service.tick('swap-1')
    await new AssetRfqSwapService({ ...deps, receiveCarrierQuotes: undefined }).tick('swap-1')

    expect(direct).not.toHaveBeenCalled()
    expect(dedicated).not.toHaveBeenCalled()
    expect(await store.get('swap-1')).toMatchObject({ state: 'refused' })
  })

  it('recreates the service on a submitted recycle and only observes pending outcomes', async () => {
    const direct = vi.fn(async () => 'fa'.repeat(32))
    const settle = vi.fn(async () => {
      throw new Error('submit outcome unknown')
    })
    const reconcile = vi.fn(async () => ({ status: 'pending' as const }))
    const errors: unknown[] = []
    const receiveCarrierQuotes = adapter({}, undefined, { settle, reconcile })
    const { service, store, deps } = await harness({
      depositAt: async () => deposit(),
      settle: direct,
      receiveCarrierQuotes,
      onError: (_id, error) => errors.push(error),
    })

    await service.quote(recycleRequest())
    await service.tick('swap-1')
    await service.tick('swap-1')
    const restarted = new AssetRfqSwapService(deps)
    await restarted.tick('swap-1')
    await restarted.tick('swap-1')

    expect(settle).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(direct).not.toHaveBeenCalled()
    expect(errors).toHaveLength(1)
    expect((await store.get('swap-1')).state).toBe('filling')
  })

  it('escalates a filling recycle that never reached an attempt, with the reason given', async () => {
    const settle = vi.fn(async () => {
      throw new Error('the recorded terms derive another offer script')
    })
    const reason = 'receive-carrier settlement stopped before preparing an attempt'
    const reconcile = vi.fn(async () => ({ status: 'stuck' as const, reason }))
    const receiveCarrierQuotes = adapter({}, undefined, { settle, reconcile })
    const errors: unknown[] = []
    const { service, store } = await harness({
      depositAt: async () => deposit(),
      receiveCarrierQuotes,
      onError: (_id, error) => errors.push(error),
    })

    await service.quote(recycleRequest())
    await service.tick('swap-1')
    await service.tick('swap-1')
    expect((await store.get('swap-1')).state).toBe('filling')

    await service.tick('swap-1')
    expect(await store.get('swap-1')).toMatchObject({ state: 'stuck', failureReason: reason })
    await service.tick('swap-1')
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
  })

  it('escalates on a stuck outcome that names no usable reason', async () => {
    const settle = vi.fn(async () => {
      throw new Error('gone')
    })
    const reconcile = vi.fn(async () => ({ status: 'stuck' })) as unknown as ReceiveCarrierQuotes['reconcile']
    const receiveCarrierQuotes = adapter({}, undefined, { settle, reconcile })
    const { service, store } = await harness({
      depositAt: async () => deposit(),
      receiveCarrierQuotes,
      onError: () => {},
    })

    await service.quote(recycleRequest())
    await service.tick('swap-1')
    await service.tick('swap-1')
    await service.tick('swap-1')

    expect((await store.get('swap-1')).state).toBe('stuck')
  })

  it('observes an expired filling recycle until exact proof completes and marks it once', async () => {
    const settle = vi.fn(async () => {
      throw new Error('submit outcome unknown')
    })
    const reconcile = vi
      .fn<ReceiveCarrierQuotes['reconcile']>()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValue({ status: 'settled', txid: 'fc'.repeat(32) })
    const receiveCarrierQuotes = adapter({}, undefined, { settle, reconcile })
    const { service, store, tick } = await harness({ depositAt: async () => deposit(), receiveCarrierQuotes })
    const mark = vi.spyOn(store, 'recordFillMark')

    await service.quote(recycleRequest())
    await service.tick('swap-1')
    await service.tick('swap-1')
    tick(9_999)
    await service.tick('swap-1')
    await service.tick('swap-1')
    await service.tick('swap-1')

    expect(settle).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(mark).toHaveBeenCalledTimes(1)
    expect(await store.get('swap-1')).toMatchObject({ state: 'filled', fillTxid: 'fc'.repeat(32) })
  })

  it.each([
    ['a read failure', async () => Promise.reject(new Error('indexer down'))],
    ['a malformed outcome', async () => ({ status: 'unknown' })],
    ['a non-canonical proof txid', async () => ({ status: 'settled', txid: 'FC'.repeat(32) })],
  ])('leaves filling on %s', async (_why, result) => {
    const reconcile = vi.fn(result) as unknown as ReceiveCarrierQuotes['reconcile']
    const receiveCarrierQuotes = adapter({}, undefined, { reconcile })
    const errors: unknown[] = []
    const { service, store } = await harness({
      depositAt: async () => deposit(),
      receiveCarrierQuotes,
      onError: (_id, error) => errors.push(error),
    })
    await service.quote(recycleRequest())
    await service.tick('swap-1')
    await store.transition('swap-1', 'funded', 'filling')

    await service.tick('swap-1')

    expect((await store.get('swap-1')).state).toBe('filling')
    expect(errors).toHaveLength(1)
  })

  it('leaves an invalid settle txid unknown and never submits it again', async () => {
    const settle = vi.fn(async () => 'not-a-txid')
    const reconcile = vi.fn(async () => ({ status: 'pending' as const }))
    const errors: unknown[] = []
    const receiveCarrierQuotes = adapter({}, undefined, { settle, reconcile })
    const { service, store } = await harness({
      depositAt: async () => deposit(),
      receiveCarrierQuotes,
      onError: (_id, error) => errors.push(error),
    })

    await service.quote(recycleRequest())
    await service.tick('swap-1')
    await service.tick('swap-1')
    await service.tick('swap-1')

    expect(settle).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
    expect((await store.get('swap-1')).state).toBe('filling')
  })

  it('keeps filling when the post-submit transition cannot be persisted', async () => {
    const settle = vi.fn(async () => 'fb'.repeat(32))
    const reconcile = vi.fn(async () => ({ status: 'pending' as const }))
    const errors: unknown[] = []
    const receiveCarrierQuotes = adapter({}, undefined, { settle, reconcile })
    const { service, store } = await harness({
      depositAt: async () => deposit(),
      receiveCarrierQuotes,
      onError: (_id, error) => errors.push(error),
    })
    const transition = store.transition.bind(store)
    vi.spyOn(store, 'transition').mockImplementation(async (id, from, to, fields) => {
      if (from === 'filling' && to === 'filled') throw new Error('disk write failed')
      return transition(id, from, to, fields)
    })

    await service.quote(recycleRequest())
    await service.tick('swap-1')
    await service.tick('swap-1')
    await service.tick('swap-1')

    expect(settle).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
    expect((await store.get('swap-1')).state).toBe('filling')
  })

  it('keeps a persisted filling recycle unknown when its adapter is missing', async () => {
    const direct = vi.fn(async () => 'fa'.repeat(32))
    const errors: unknown[] = []
    const { service, store, deps } = await harness({
      depositAt: async () => deposit(),
      settle: direct,
      receiveCarrierQuotes: adapter(),
      onError: (_id, error) => errors.push(error),
    })
    await service.quote(recycleRequest())
    await service.tick('swap-1')
    await store.transition('swap-1', 'funded', 'filling')

    await new AssetRfqSwapService({ ...deps, receiveCarrierQuotes: undefined }).tick('swap-1')

    expect(direct).not.toHaveBeenCalled()
    expect(errors).toHaveLength(1)
    expect((await store.get('swap-1')).state).toBe('filling')
  })
})

describe('profile.carrier — refusals', () => {
  it.each([
    ['resolve only', (resolve: ReceiveCarrierQuotes['resolve']) => ({ resolve })],
    [
      'resolve and settle only',
      (resolve: ReceiveCarrierQuotes['resolve']) => ({ resolve, settle: async () => 'fb'.repeat(32) }),
    ],
    [
      'resolve, settle, and reconcile only',
      (resolve: ReceiveCarrierQuotes['resolve']) => ({
        resolve,
        settle: async () => 'fb'.repeat(32),
        reconcile: async () => ({ status: 'pending' as const }),
      }),
    ],
  ])('refuses a %s adapter before any quote dependency is called', async (_why, partial) => {
    const resolve = vi.fn<ReceiveCarrierQuotes['resolve']>(async () => RECEIVER_QUOTE)
    const fetchPrice = vi.fn(async () => ({ mantissa: 100_000n, scale: 0 }))
    const balance = vi.fn(async () => new Map([[ASSET_A, 10n ** 18n]]))
    const deriveOffer = vi.fn(() => ({ pkScript: OFFER_SCRIPT, address: 'ark1qoffer' }))
    const { service, store } = await harness({
      receiveCarrierQuotes: partial(resolve) as unknown as ReceiveCarrierQuotes,
      fetchPrice,
      balance,
      deriveOffer,
    })
    const insert = vi.spyOn(store, 'insertQuote')

    expect(await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))).toMatchObject({
      accepted: false,
      reason: 'price_unavailable',
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(fetchPrice).not.toHaveBeenCalled()
    expect(balance).not.toHaveBeenCalled()
    expect(deriveOffer).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })

  it.each([
    ['a purchase on a BTC payout, which has no carrier', { mode: 'purchase' }],
    ['a recycle on a BTC payout', { mode: 'recycle', quoteId: 'q-1' }],
  ])('refuses %s before pricing or reading the float', async (_why, carrier) => {
    const balance = vi.fn(async () => new Map([[ASSET_A, 10n ** 18n]]))
    const { service, store } = await harness({ balance })
    const outcome = await service.quote(request({ pair: `arkade:${ASSET_A}->arkade:BTC`, carrier, amount: 10n ** 12n }))
    expect(outcome).toMatchObject({ accepted: false, reason: 'unsupported_payload' })
    expect(balance).not.toHaveBeenCalled()
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('refuses a recycle when no adapter is configured, and never prices the market carrier', async () => {
    const { service, store } = await harness({ markets: [{ ...MARKET, carrierSats: 0n }] })
    const outcome = await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))
    expect(outcome).toMatchObject({ accepted: false, reason: 'price_unavailable' })
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('refuses a recycle the adapter could not answer for', async () => {
    const { service } = await harness({
      receiveCarrierQuotes: {
        ...adapter(),
        resolve: async () => {
          throw new Error('taxi down')
        },
      },
    })
    expect(await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))).toMatchObject({
      accepted: false,
      reason: 'price_unavailable',
    })
  })

  it.each<[string, Partial<ReceiveCarrierQuote>]>([
    ['the quote id', { quoteId: 'other' }],
    ['the payout script', { makerPkScript: `5120${'9'.repeat(64)}` }],
    ['the signer key', { makerPublicKey: '9'.repeat(64) }],
    ['the asset', { assetId: ASSET_B }],
    ['the physical dust', { physicalSats: 331n, loanSats: 330n }],
    ['a zero receipt', { receiptSats: 0n, loanSats: 330n }],
    ['a zero loan', { loanSats: 0n, receiptSats: 330n }],
    ['a split that does not sum', { loanSats: 300n, receiptSats: 1n }],
    ['a negative service fare', { serviceFareSats: -1n }],
    ['an expiry at the current second', { expiresAt: 1_000 }],
  ])('refuses a recycle whose %s does not match the request', async (_why, over) => {
    const { service, store } = await harness({ receiveCarrierQuotes: adapter(over) })
    expect(await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))).toMatchObject({
      accepted: false,
      reason: 'price_unavailable',
    })
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it.each([
    ['missing', undefined],
    ['unknown kind', { kind: 'blocks', value: 1n }],
    ['non-bigint value', { kind: 'height', value: 1 }],
    ['zero height', { kind: 'height', value: 0n }],
    ['height in the time domain', { kind: 'height', value: 500_000_000n }],
    ['time in the height domain', { kind: 'time', value: 499_999_999n }],
    ['time above uint32', { kind: 'time', value: 4_294_967_296n }],
  ])('refuses a recycle with a %s input expiry floor', async (_why, inputExpiryFloor) => {
    const { service, store } = await harness({
      receiveCarrierQuotes: adapter({ inputExpiryFloor } as Partial<ReceiveCarrierQuote>),
    })
    expect(await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))).toMatchObject({
      accepted: false,
      reason: 'price_unavailable',
    })
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('calls the adapter only after the pair and market are known', async () => {
    const calls: unknown[] = []
    const { service } = await harness({ receiveCarrierQuotes: adapter({}, calls) })
    await service.quote(request({ pair: 'arkade:BTC->arkade:BTC', carrier: { mode: 'recycle', quoteId: 'q-1' } }))
    await service.quote(
      request({ pair: `arkade:BTC->arkade:${'ee'.repeat(34)}`, carrier: { mode: 'recycle', quoteId: 'q-1' } }),
    )
    expect(calls).toEqual([])
    await service.quote(request({ carrier: { mode: 'recycle', quoteId: 'q-1' } }))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      quoteId: 'q-1',
      makerPkScript: PK_SCRIPT,
      makerPublicKey: XONLY,
      assetId: ASSET_A,
      now: 1_000,
    })
  })
})

describe('profile.carrier — no per-market bleed', () => {
  it('quotes each market its own explicit mode', async () => {
    const { service } = await harness({
      markets: [
        { ...MARKET, carrierSats: 0n },
        { ...MARKET, symbol: 'USDB', quote: ASSET_B, carrierSats: 0n },
      ],
      balance: async () =>
        new Map([
          [ASSET_A, 10n ** 18n],
          [ASSET_B, 10n ** 18n],
        ]),
      newId: sequentialIds(),
      deriveOffer: perClientOffer,
      // Answers for whichever asset and signer the request names, so this test
      // measures the per-market price term rather than tripping a mismatch.
      receiveCarrierQuotes: {
        ...adapter(),
        resolve: async (ask: { assetId: string; makerPublicKey: string }) => ({
          ...RECEIVER_QUOTE,
          assetId: ask.assetId,
          makerPublicKey: ask.makerPublicKey,
        }),
        available: async (ask: { assetId: string }) => new Map([[ask.assetId, 10n ** 18n]]),
      },
    })
    const purchased = await service.quote(request({ carrier: { mode: 'purchase' } }))
    const recycled = await service.quote(
      request({
        pair: `arkade:BTC->arkade:${ASSET_B}`,
        rfqId: 'f'.repeat(64),
        // Distinct signer, so the second negotiation derives its own offer
        // address rather than colliding on the live-offer index.
        makerPublicKey: 'c'.repeat(64),
        carrier: { mode: 'recycle', quoteId: 'q-1' },
      }),
    )
    expect(purchased.accepted && purchased.carrierSats).toBe(330n)
    expect(recycled.accepted && recycled.carrierSats).toBe(330n)
    // The purchase buys 330; the recycle buys 1 receipt. Different markets,
    // different priced terms, neither bleeding into the other.
    expect((purchased as { swap: { toAmount: bigint } }).swap.toAmount).toBe(99_499_671_650n)
    expect((recycled as { swap: { toAmount: bigint } }).swap.toAmount).toBe(99_499_999_005n)
  })
})
