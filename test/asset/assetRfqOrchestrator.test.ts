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
import {
  AssetRfqSwapService,
  type AssetRfqDeps,
  type ObservedDeposit,
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
    vi.spyOn(store, 'insertQuote').mockRejectedValueOnce(new Error('UNIQUE constraint failed: asset_rfq_swap.rfq_id'))
    expect(await service.quote(request())).toMatchObject({ accepted: false, reason: 'duplicate_swap' })
    expect(failures).toEqual([])
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
