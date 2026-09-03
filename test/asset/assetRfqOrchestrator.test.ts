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

import { describe, it, expect } from 'vitest'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import {
  AssetRfqSwapService,
  type AssetRfqDeps,
  type ObservedDeposit,
} from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'

const ASSET_A = `${'aa'.repeat(32)}0100`
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

  it('refuses exact-out, which would invert a rounded directional rate', async () => {
    const { service } = await harness()
    expect(await service.quote(request({ amountSide: 'to' }))).toMatchObject({
      accepted: false,
      reason: 'exact_out_unsupported',
    })
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

  it('does not record a row when it refuses', async () => {
    const { service, store } = await harness()
    await service.quote(request({ amountSide: 'to' }))
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
