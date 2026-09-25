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
import {
  AssetRfqSwapStore,
  carrierTermsFromJson,
  carrierTermsToJson,
  type AssetRfqCarrierTerms,
  type AssetRfqQuoteRecord,
} from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'

const ASSET_A = `${'aa'.repeat(32)}0100`
const ASSET_B = `${'bb'.repeat(32)}0100`
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

/** A row mid-fill on a sats payout — the only shape `committedSats` counts. */
const fillingSats = async (store: AssetRfqSwapStore, id: string, pair: string, from: string, sats: bigint) => {
  await store.insertQuote(
    quote({
      id,
      pair,
      rfqId: id.padEnd(64, '0'),
      fromAssetId: from,
      toAssetId: null,
      toAmount: sats,
      offerPkScript: `5120${id.padEnd(64, 'd')}`,
    }),
  )
  await store.transition(id, 'quoted', 'funded')
  await store.transition(id, 'funded', 'filling')
}

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

  it('counts a single pair when asked for one', async () => {
    const store = await open()
    await fillingSats(store, 'swap-1', `arkade:${ASSET_A}->arkade:BTC`, ASSET_A, 99_500_000n)
    await fillingSats(store, 'swap-2', `arkade:${ASSET_B}->arkade:BTC`, ASSET_B, 40_000_000n)

    expect(await store.committedSats(`arkade:${ASSET_A}->arkade:BTC`)).toBe(99_500_000)
    expect(await store.committedSats(`arkade:${ASSET_B}->arkade:BTC`)).toBe(40_000_000)
    expect(await store.committedSats()).toBe(139_500_000)
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

/**
 * The immutable carrier terms an explicit mode records.
 *
 * Their job is to survive until the fill adapter settles them: `loanSats` is
 * Taxi's returnable principal and is never in the price, so a row that lost it
 * would describe a carrier nobody can repay. They are written once and never
 * moved, including across a reopen.
 */
const RECYCLE_TERMS: AssetRfqCarrierTerms = {
  mode: 'recycle',
  quoteId: 'q-1',
  physicalSats: 330n,
  loanSats: 329n,
  receiptSats: 1n,
  serviceFareSats: 4n,
  pricedSats: 5n,
  expiresAt: 5_000,
}

const PURCHASE_TERMS: AssetRfqCarrierTerms = {
  mode: 'purchase',
  physicalSats: 330n,
  // Bought, not advanced: no loan and no receipt reserve, so only the service
  // fare can lift the price above the dust.
  loanSats: 0n,
  receiptSats: 0n,
  serviceFareSats: 0n,
  pricedSats: 330n,
  expiresAt: 2_000,
}

/** The payee's own Taxi fronts the whole dust and is repaid at claim: no
 * receipt, no fare, nothing netted into the price. */
const RECEIVER_PAID_TERMS: AssetRfqCarrierTerms = {
  mode: 'recycle_receiver',
  quoteId: 'q1',
  physicalSats: 330n,
  loanSats: 330n,
  receiptSats: 0n,
  serviceFareSats: 0n,
  pricedSats: 0n,
  expiresAt: 5_000,
  taxiUrl: 'https://taxi.example',
  taxiKey: 'b'.repeat(64),
}

describe('carrier terms', () => {
  it('round-trips a recycle exactly, amounts included', async () => {
    const store = await open()
    const row = await store.insertQuote(quote({ carrierTerms: RECYCLE_TERMS }))
    expect(row.carrierTerms).toEqual(RECYCLE_TERMS)
    expect((await store.findById('swap-1'))?.carrierTerms).toEqual(RECYCLE_TERMS)
    await store.close()
  })

  it('round-trips a purchase, which is whole dust rather than a split', async () => {
    const store = await open()
    const row = await store.insertQuote(quote({ carrierTerms: PURCHASE_TERMS }))
    expect(row.carrierTerms).toEqual(PURCHASE_TERMS)
    await store.close()
  })

  it('round-trips a receiver-paid carrier, taxi identity included', async () => {
    const store = await open()
    const row = await store.insertQuote(quote({ carrierTerms: RECEIVER_PAID_TERMS }))
    expect(row.carrierTerms).toEqual(RECEIVER_PAID_TERMS)
    expect((await store.findById('swap-1'))?.carrierTerms).toEqual(RECEIVER_PAID_TERMS)
    await store.close()
  })

  it('leaves the column null for a row that named no mode', async () => {
    const store = await open()
    expect((await store.insertQuote(quote())).carrierTerms).toBeNull()
    await store.close()
  })

  it('carries amounts as canonical decimal strings on the wire form', () => {
    expect(carrierTermsToJson(RECYCLE_TERMS)).toEqual({
      mode: 'recycle',
      quote_id: 'q-1',
      physical_sats: '330',
      loan_sats: '329',
      receipt_sats: '1',
      service_fare_sats: '4',
      priced_sats: '5',
      expires_at: 5_000,
    })
  })

  it('serializes a purchase as a zero loan, never as a split', () => {
    expect(carrierTermsToJson(PURCHASE_TERMS)).toEqual({
      mode: 'purchase',
      physical_sats: '330',
      loan_sats: '0',
      receipt_sats: '0',
      service_fare_sats: '0',
      priced_sats: '330',
      expires_at: 2_000,
    })
  })

  it('persists and reads back the Taxi identity with the quote id', () => {
    const json = carrierTermsToJson(RECEIVER_PAID_TERMS)
    expect(json).toMatchObject({
      mode: 'recycle_receiver',
      quote_id: 'q1',
      taxi_url: 'https://taxi.example',
      taxi_key: 'b'.repeat(64),
      loan_sats: '330',
      receipt_sats: '0',
      service_fare_sats: '0',
      priced_sats: '0',
    })
    expect(carrierTermsFromJson(json)).toEqual(RECEIVER_PAID_TERMS)
  })

  it('rejects an unknown key in persisted receiver-paid terms', () => {
    expect(() => carrierTermsFromJson({ ...carrierTermsToJson(RECEIVER_PAID_TERMS), surprise: 1 })).toThrow(
      /unknown key/,
    )
  })

  /** `taxi_url` names no field on an ordinary recycle. */
  it('rejects a recycle row carrying a taxi url', () => {
    expect(() =>
      carrierTermsFromJson({ ...carrierTermsToJson(RECYCLE_TERMS), taxi_url: 'https://taxi.example' }),
    ).toThrow(/unknown key/)
  })

  it('keeps the terms across a transition, so a settled fill can still read them', async () => {
    const store = await open()
    await store.insertQuote(quote({ carrierTerms: RECYCLE_TERMS }))
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'filling')
    expect((await store.get('swap-1')).carrierTerms).toEqual(RECYCLE_TERMS)
    await store.close()
  })

  it.each([
    ['a non-object', 7],
    ['a missing mode', { physical_sats: '330' }],
    ['an unknown mode', { mode: 'recycled', physical_sats: '330' }],
    ['a recycle with no quote id', { mode: 'recycle', physical_sats: '330', loan_sats: '329', receipt_sats: '1' }],
    ['a purchase carrying a quote id', { mode: 'purchase', quote_id: 'q-1', physical_sats: '330' }],
    [
      'a purchase with an unknown key',
      {
        mode: 'purchase',
        physical_sats: '330',
        loan_sats: '0',
        receipt_sats: '0',
        service_fare_sats: '0',
        priced_sats: '330',
        expires_at: 9,
        carrier: 'x',
      },
    ],
    [
      'a purchase claiming a loan',
      {
        mode: 'purchase',
        physical_sats: '330',
        loan_sats: '330',
        receipt_sats: '0',
        service_fare_sats: '0',
        priced_sats: '330',
        expires_at: 9,
      },
    ],
    [
      'a purchase claiming a receipt',
      {
        mode: 'purchase',
        physical_sats: '330',
        loan_sats: '0',
        receipt_sats: '1',
        service_fare_sats: '0',
        priced_sats: '1',
        expires_at: 9,
      },
    ],
    [
      'a purchase whose price omits the physical carrier',
      {
        mode: 'purchase',
        physical_sats: '330',
        loan_sats: '0',
        receipt_sats: '0',
        service_fare_sats: '0',
        priced_sats: '0',
        expires_at: 9,
      },
    ],
    [
      'a recycle priced off the loan rather than the receipt',
      {
        mode: 'recycle',
        quote_id: 'q',
        physical_sats: '330',
        loan_sats: '329',
        receipt_sats: '1',
        service_fare_sats: '4',
        priced_sats: '333',
        expires_at: 9,
      },
    ],
    [
      'a split that does not sum',
      {
        mode: 'recycle',
        quote_id: 'q',
        physical_sats: '330',
        loan_sats: '300',
        receipt_sats: '1',
        service_fare_sats: '0',
        priced_sats: '1',
        expires_at: 9,
      },
    ],
    [
      'a zero receipt',
      {
        mode: 'recycle',
        quote_id: 'q',
        physical_sats: '330',
        loan_sats: '330',
        receipt_sats: '0',
        service_fare_sats: '0',
        priced_sats: '0',
        expires_at: 9,
      },
    ],
    [
      'a negative service fare',
      {
        mode: 'recycle',
        quote_id: 'q',
        physical_sats: '330',
        loan_sats: '329',
        receipt_sats: '1',
        service_fare_sats: '-1',
        priced_sats: '0',
        expires_at: 9,
      },
    ],
    [
      'a non-canonical amount',
      {
        mode: 'purchase',
        physical_sats: '0330',
        loan_sats: '0',
        receipt_sats: '0',
        service_fare_sats: '0',
        priced_sats: '330',
        expires_at: 9,
      },
    ],
    [
      'a fractional amount',
      {
        mode: 'purchase',
        physical_sats: '330.5',
        loan_sats: '0',
        receipt_sats: '0',
        service_fare_sats: '0',
        priced_sats: '330',
        expires_at: 9,
      },
    ],
    [
      'an expiry that is not a positive unix second',
      {
        mode: 'purchase',
        physical_sats: '330',
        loan_sats: '0',
        receipt_sats: '0',
        service_fare_sats: '0',
        priced_sats: '330',
        expires_at: 0,
      },
    ],
    ['a receiver-paid carrier with no quote id', { ...carrierTermsToJson(RECEIVER_PAID_TERMS), quote_id: undefined }],
    ['a receiver-paid carrier with no taxi url', { ...carrierTermsToJson(RECEIVER_PAID_TERMS), taxi_url: undefined }],
    [
      'a receiver-paid carrier whose taxi key is not 64 lowercase hex',
      { ...carrierTermsToJson(RECEIVER_PAID_TERMS), taxi_key: 'B'.repeat(64) },
    ],
    [
      'a receiver-paid carrier charging a receipt',
      { ...carrierTermsToJson(RECEIVER_PAID_TERMS), receipt_sats: '1', priced_sats: '1' },
    ],
    [
      'a receiver-paid carrier whose loan is not the whole dust',
      { ...carrierTermsToJson(RECEIVER_PAID_TERMS), loan_sats: '329' },
    ],
    ['a purchase carrying a taxi url', { ...carrierTermsToJson(PURCHASE_TERMS), taxi_url: 'https://taxi.example' }],
  ])('refuses to parse %s rather than half-read it', (_why, value) => {
    expect(() => carrierTermsFromJson(value)).toThrow()
  })

  it('round-trips the exact JSON form it wrote, including a purchase', () => {
    expect(carrierTermsFromJson(carrierTermsToJson(PURCHASE_TERMS))).toEqual(PURCHASE_TERMS)
    expect(carrierTermsFromJson(carrierTermsToJson(RECYCLE_TERMS))).toEqual(RECYCLE_TERMS)
    expect(carrierTermsFromJson(carrierTermsToJson(RECEIVER_PAID_TERMS))).toEqual(RECEIVER_PAID_TERMS)
  })

  /** Corruption must be refused at the READ, not silently reported as "no terms". */
  it('refuses a corrupted blob on read instead of reading it as absent', async () => {
    const store = await open()
    await store.driver.run(
      `INSERT INTO asset_rfq_swap (
      id, state, created_at, updated_at, rfq_id, pair, from_amount, to_amount,
      maker_pk_script, maker_public_key, offer_pk_script, offer_address, solver_pubkey, valid_until, carrier_terms
    ) VALUES ('bad', 'quoted', 1, 1, ?, 'arkade:BTC->arkade:USDA', '1', '2', '3', '4', '5', 'ark1q', '6', 9, ?)`,
      ['a'.repeat(64), '{"mode":"recycle"}'],
    )
    await expect(store.get('bad')).rejects.toThrow()
    await store.close()
  })

  it.each([
    ['a split that does not sum to the physical carrier', { loanSats: 300n }],
    ['an expiry that is not a whole unix second', { expiresAt: 9_000.5 }],
    ['a quote id no bound admits', { quoteId: 'q'.repeat(129) }],
  ])('refuses to insert %s', async (_why, over) => {
    const store = await open()
    const carrierTerms: AssetRfqCarrierTerms = { ...RECYCLE_TERMS, ...over }

    await expect(store.insertQuote(quote({ carrierTerms }))).rejects.toThrow(/carrier terms/)
    expect(await store.listNonTerminal()).toEqual([])
    await store.close()
  })

  it('refuses to insert a receiver-paid carrier whose loan is not the whole dust', async () => {
    const store = await open()
    const carrierTerms: AssetRfqCarrierTerms = { ...RECEIVER_PAID_TERMS, loanSats: 329n }

    await expect(store.insertQuote(quote({ carrierTerms }))).rejects.toThrow(/carrier terms/)
    expect(await store.listNonTerminal()).toEqual([])
    await store.close()
  })

  /** Empty string is corruption on a money column, not an absent term. */
  it('refuses an empty terms blob rather than reading it as legacy', async () => {
    const store = await open()
    await store.driver.run(
      `INSERT INTO asset_rfq_swap (
      id, state, created_at, updated_at, rfq_id, pair, from_amount, to_amount,
      maker_pk_script, maker_public_key, offer_pk_script, offer_address, solver_pubkey, valid_until, carrier_terms
    ) VALUES ('blank', 'quoted', 1, 1, ?, 'arkade:BTC->arkade:USDA', '1', '2', '3', '4', '5', 'ark1q', '6', 9, '')`,
      ['b'.repeat(64)],
    )
    await expect(store.get('blank')).rejects.toThrow()
    await store.close()
  })
})
