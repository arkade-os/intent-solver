/**
 * The negotiation store for `arkade:<X>->arkade:<Y>` over RFQ.
 *
 * Two invariants here are § 8's "normative solver invariants", and both are
 * load-bearing rather than tidy: single-writer CAS over a CLOSED edge set, so
 * two ticks racing one row cannot both submit a fill; and stuck-over-silence,
 * so a row that may have spent money never lands in a state that reads clean.
 *
 * The third property is this corridor's own: there is no `refunded` state,
 * because § 7.2's refund is `cancel` — a 2-of-2 of the FUNDER and the Arkade
 * Service — which this solver has no key for and cannot perform.
 */

import { describe, it, expect } from 'vitest'
import { AssetRfqSwapStore, type AssetRfqQuoteRecord } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'

const ASSET_A = `${'aa'.repeat(32)}0100`
const PK_SCRIPT = `5120${'c'.repeat(64)}`
const OFFER_SCRIPT = `5120${'d'.repeat(64)}`

const quote = (over: Partial<AssetRfqQuoteRecord> = {}): AssetRfqQuoteRecord => ({
  id: 'swap-1',
  rfqId: 'a'.repeat(64),
  pair: `arkade:BTC->arkade:${ASSET_A}`,
  fromAssetId: null,
  fromAmount: 100_000_000n,
  toAssetId: ASSET_A,
  toAmount: 99_500_000_000n,
  makerPkScript: PK_SCRIPT,
  makerPublicKey: 'b'.repeat(64),
  offerPkScript: OFFER_SCRIPT,
  offerAddress: 'ark1qoffer',
  solverPubkey: 'e'.repeat(64),
  validUntil: 2_000,
  ...over,
})

const open = () => AssetRfqSwapStore.open(':memory:', () => 1_000)

describe('insertQuote', () => {
  it('records the terms as quoted, before anything is funded', async () => {
    const store = await open()
    const row = await store.insertQuote(quote())
    expect(row).toMatchObject({ state: 'quoted', offerPkScript: OFFER_SCRIPT, validUntil: 2_000 })
    await store.close()
  })

  /**
   * Amounts survive a round trip through the column exactly. They are TEXT
   * rather than INTEGER because an asset amount is 256-bit while SQLite's
   * INTEGER is a signed 64-bit — a value the protocol admits is one the column
   * would silently mangle.
   */
  it('round-trips an amount far beyond a 64-bit column', async () => {
    const store = await open()
    const huge = 10n ** 30n + 7n
    const row = await store.insertQuote(quote({ toAmount: huge }))
    expect(row.toAmount).toBe(huge)
    expect((await store.findById('swap-1'))?.toAmount).toBe(huge)
    await store.close()
  })

  /**
   * § 4.5's natural key. The atomic class has no payment hash and the spec says
   * so: "a profile without one — the atomic class today — is identified by
   * `rfq_id` alone."
   */
  it('refuses a second negotiation on the same rfq_id', async () => {
    const store = await open()
    await store.insertQuote(quote())
    await expect(store.insertQuote(quote({ id: 'swap-2', offerPkScript: `5120${'e'.repeat(64)}` }))).rejects.toThrow()
    await store.close()
  })

  /**
   * Identical terms derive an identical covenant (§ 7.2), so two negotiations
   * can legitimately land on one address — and a single deposit there would
   * then have two rows claiming it, of which at most one fill can succeed.
   */
  it('refuses a second LIVE negotiation watching the same offer script', async () => {
    const store = await open()
    await store.insertQuote(quote())
    await expect(store.insertQuote(quote({ id: 'swap-2', rfqId: 'f'.repeat(64) }))).rejects.toThrow()
    await store.close()
  })

  it('admits a later negotiation at an address whose earlier one lapsed', async () => {
    const store = await open()
    await store.insertQuote(quote())
    await store.fail('swap-1', 'quoted', 'quote expired')
    const second = await store.insertQuote(quote({ id: 'swap-2', rfqId: 'f'.repeat(64) }))
    expect(second.state).toBe('quoted')
    await store.close()
  })
})

describe('transition — single-writer CAS over a closed edge set', () => {
  it('moves a quoted row to funded when a deposit is observed', async () => {
    const store = await open()
    await store.insertQuote(quote())
    expect(await store.transition('swap-1', 'quoted', 'funded', { deposit_txid: 'ff', deposit_vout: 0 })).toBe(true)
    expect((await store.get('swap-1')).depositTxid).toBe('ff')
    await store.close()
  })

  it('lets exactly one of two racing writers win', async () => {
    const store = await open()
    await store.insertQuote(quote())
    const [a, b] = await Promise.all([
      store.transition('swap-1', 'quoted', 'funded'),
      store.transition('swap-1', 'quoted', 'funded'),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    await store.close()
  })

  /**
   * The edge that must not exist. Once `fulfill` is submitted its outcome is
   * either known or unknown — and "unknown" is `stuck`, never a retry, which is
   * how a solver double-spends its own float.
   */
  it('refuses to walk a filling row back to funded', async () => {
    const store = await open()
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'filling')
    await expect(store.transition('swap-1', 'filling', 'funded')).rejects.toThrow(/illegal transition/)
    await store.close()
  })

  it.each([
    ['quoted', 'filling'],
    ['quoted', 'filled'],
    ['funded', 'filled'],
    ['filled', 'stuck'],
    ['refused', 'quoted'],
  ] as const)('refuses the %s -> %s edge, which is not in the lifecycle', async (from, to) => {
    const store = await open()
    await store.insertQuote(quote())
    await expect(store.transition('swap-1', from, to)).rejects.toThrow(/illegal transition/)
    await store.close()
  })

  /**
   * The negotiated terms are what the covenant is DERIVED from, so a row that
   * could edit them could describe a contract that was never funded.
   */
  it.each(['to_amount', 'offer_pk_script', 'maker_pk_script', 'valid_until'])(
    'refuses to let a transition rewrite %s',
    async (column) => {
      const store = await open()
      await store.insertQuote(quote())
      await expect(store.transition('swap-1', 'quoted', 'funded', { [column]: '1' })).rejects.toThrow(
        /may not set column/,
      )
      await store.close()
    },
  )
})

describe('fail — routed by exposure, which is what an operator acts on', () => {
  it('sends an unfunded quote to refused, because nothing was ever at stake', async () => {
    const store = await open()
    await store.insertQuote(quote())
    await store.fail('swap-1', 'quoted', 'quote expired')
    expect(await store.get('swap-1')).toMatchObject({ state: 'refused', failureReason: 'quote expired' })
    await store.close()
  })

  /**
   * A deposit sitting at the offer address is the CLIENT's money, not this
   * solver's: nothing has been submitted, so a lapsed quote here is still
   * clean. The client reclaims with `cancel`, which needs no solver signature.
   */
  it('sends a funded-but-unsubmitted row to refused, not stuck', async () => {
    const store = await open()
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.fail('swap-1', 'funded', 'quote expired before fill')
    expect((await store.get('swap-1')).state).toBe('refused')
    await store.close()
  })

  /** Stuck-over-silence: `filling` may already have spent, so only a human can say. */
  it('sends a submitted row to stuck', async () => {
    const store = await open()
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'filling')
    await store.fail('swap-1', 'filling', 'emulator refused')
    expect(await store.get('swap-1')).toMatchObject({ state: 'stuck', failureReason: 'emulator refused' })
    await store.close()
  })

  it('refuses to fail a terminal row rather than reporting success', async () => {
    const store = await open()
    await store.insertQuote(quote())
    await store.fail('swap-1', 'quoted', 'declined')
    await expect(store.fail('swap-1', 'refused', 'again')).rejects.toThrow(/terminal/)
    await store.close()
  })
})

describe('committedSats — exposure the float dashboard reads', () => {
  it('reports nothing for a quote nobody has funded', async () => {
    const store = await open()
    await store.insertQuote(quote())
    expect(await store.committedSats()).toBe(0)
    await store.close()
  })

  /**
   * The payout leg here is an ASSET, so no sats are committed even mid-fill.
   * Summing its atomic units into a sats total would add two different units
   * into one number, which is worse than reporting nothing.
   */
  it('reports no sats for an asset payout in flight', async () => {
    const store = await open()
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'filling')
    expect(await store.committedSats()).toBe(0)
    await store.close()
  })

  it('reports the payout when the leg being paid IS sats', async () => {
    const store = await open()
    await store.insertQuote(
      quote({ pair: `arkade:${ASSET_A}->arkade:BTC`, fromAssetId: ASSET_A, toAssetId: null, toAmount: 99_500_000n }),
    )
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'filling')
    expect(await store.committedSats()).toBe(99_500_000)
    await store.close()
  })
})

describe('reads the sweep and the console depend on', () => {
  it('finds a negotiation by its rfq id', async () => {
    const store = await open()
    await store.insertQuote(quote())
    expect((await store.findByRfqId('a'.repeat(64)))?.id).toBe('swap-1')
    expect(await store.findByRfqId('0'.repeat(64))).toBeUndefined()
    await store.close()
  })

  it('finds the live negotiation watching an offer script', async () => {
    const store = await open()
    await store.insertQuote(quote())
    expect((await store.findLiveByOfferScript(OFFER_SCRIPT))?.id).toBe('swap-1')
    await store.close()
  })

  it('stops finding it once the negotiation is terminal', async () => {
    const store = await open()
    await store.insertQuote(quote())
    await store.fail('swap-1', 'quoted', 'expired')
    expect(await store.findLiveByOfferScript(OFFER_SCRIPT)).toBeUndefined()
    await store.close()
  })

  it('lists only non-terminal rows for the sweep', async () => {
    const store = await open()
    await store.insertQuote(quote())
    await store.insertQuote(quote({ id: 'swap-2', rfqId: 'f'.repeat(64), offerPkScript: `5120${'e'.repeat(64)}` }))
    await store.fail('swap-2', 'quoted', 'declined')
    expect((await store.listNonTerminal()).map((r) => r.id)).toEqual(['swap-1'])
    await store.close()
  })

  it('records a timeline a human can read', async () => {
    const store = await open()
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    expect((await store.history('swap-1')).map((e) => e.to)).toEqual(['quoted', 'funded'])
    await store.close()
  })

  it('throws on an id it does not hold, which is how fall-through reads it', async () => {
    const store = await open()
    await expect(store.get('nope')).rejects.toThrow(/no asset rfq swap/)
    await store.close()
  })
})
