/**
 * The wire contract for `arkade:<X>->arkade:<Y>` — the atomic class over RFQ,
 * `docs/rfq-protocol.md` § 7.2.
 *
 * Two things here are different from every other corridor's wire, and both are
 * spec text rather than taste:
 *
 * - There is NO `refund_locktime`. § 4.2 makes it "HTLC-class quotes only
 *   (absent for atomic class)", and § 7.2 gives the reason: neither the
 *   `fulfill` nor the `cancel` program carries a timelock, so there is no
 *   deadline to publish. Emitting one would describe a recourse path that does
 *   not exist.
 * - Amounts are § 2.1 canonical decimal STRINGS carried as bigints, not JSON
 *   numbers. An Arkade asset leg is 256-bit, and one whole unit of an
 *   18-decimal asset is a hundred times what a double represents exactly.
 */

import { describe, it, expect } from 'vitest'
import {
  AssetRfqRequest,
  assetRfqQuotePayload,
  assetRfqStatusPayload,
  assetRfqStateFromRow,
  assetRfqPairFor,
} from '@arkade-os/solver-corridors/wire/assetRfqPayloads.js'
import type { AssetRfqSwapRow } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'

const ASSET_A = `${'aa'.repeat(32)}0100`
const RFQ_ID = 'a'.repeat(64)
const XONLY = 'b'.repeat(64)
const PK_SCRIPT = `5120${'c'.repeat(64)}` // 34 bytes: a P2TR scriptPubKey

const request = (over: Record<string, unknown> = {}, profileOver: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: RFQ_ID,
  pair: `arkade:BTC->arkade:${ASSET_A}`,
  amount_side: 'from',
  amount: '100000000',
  profile: { maker_pk_script: PK_SCRIPT, maker_public_key: XONLY, ...profileOver },
  ...over,
})

describe('AssetRfqRequest', () => {
  it('accepts a well-formed exact-in request', () => {
    const parsed = AssetRfqRequest.safeParse(request())
    expect(parsed.success).toBe(true)
    expect(parsed.data?.amount).toBe(100_000_000n)
  })

  it('carries an amount no double could hold, without rounding it', () => {
    const parsed = AssetRfqRequest.safeParse(request({ amount: '1000000000000000001' }))
    expect(parsed.data?.amount).toBe(1000000000000000001n)
  })

  it('accepts the longest pair the protocol admits', () => {
    // § 2: "A pair may therefore be as long as two full asset legs, which
    // implementations must accept." The pair is refused later, on its MEANING
    // (an asset on both legs cannot be an offer packet) — never here, as a
    // length fault, which would be an unreadable refusal.
    const long = `arkade:${ASSET_A}->arkade:${'bb'.repeat(32)}0000`
    expect(AssetRfqRequest.safeParse(request({ pair: long })).success).toBe(true)
  })

  it.each([
    ['a JSON-number amount, which cannot be checked lossless on an asset leg', { amount: 100000000 }],
    ['a missing amount', { amount: undefined }],
    ['an unknown envelope field', { nonce: 1 }],
    ['the wrong version', { v: 2 }],
    ['the wrong type', { type: 'rfq_open' }],
    ['a short rfq_id', { rfq_id: 'a'.repeat(63) }],
  ])('refuses %s', (_why, over) => {
    expect(AssetRfqRequest.safeParse(request(over)).success).toBe(false)
  })

  it.each([
    ['an unknown profile field', { extra: 1 }],
    ['a maker script that is not 34 bytes', { maker_pk_script: `5120${'c'.repeat(62)}` }],
    ['an upper-case maker script', { maker_pk_script: PK_SCRIPT.toUpperCase() }],
    ['a maker key that is not x-only', { maker_public_key: `02${XONLY}` }],
    ['a missing maker key', { maker_public_key: undefined }],
  ])('refuses %s', (_why, over) => {
    expect(AssetRfqRequest.safeParse(request({}, over)).success).toBe(false)
  })

  /**
   * Strictness is the § 1 rule for a DIRECTED request: "a directed request
   * containing unknown fields MUST be rejected with `unsupported_payload`". It
   * matters more here than elsewhere, because the two profile fields pin the
   * covenant — a client that misspells one and is quoted anyway funds an
   * address derived from a field the solver never read.
   */
  it('is strict at both levels, so a misspelled covenant field cannot be ignored', () => {
    expect(AssetRfqRequest.safeParse(request({}, { maker_pubkey: XONLY })).success).toBe(false)
  })
})

const row = (over: Partial<AssetRfqSwapRow> = {}): AssetRfqSwapRow => ({
  id: 'swap-1',
  state: 'quoted',
  createdAt: 1_000,
  updatedAt: 1_000,
  rfqId: RFQ_ID,
  pair: `arkade:BTC->arkade:${ASSET_A}`,
  fromAssetId: null,
  fromAmount: 100_000_000n,
  toAssetId: ASSET_A,
  toAmount: 99_500_000_000n,
  makerPkScript: PK_SCRIPT,
  makerPublicKey: XONLY,
  offerPkScript: `5120${'d'.repeat(64)}`,
  offerAddress: 'ark1qoffer',
  solverPubkey: XONLY,
  validUntil: 2_000,
  depositTxid: null,
  depositVout: null,
  fillTxid: null,
  failureReason: null,
  ...over,
})

describe('assetRfqQuotePayload', () => {
  it('resolves both amounts as canonical decimal strings', () => {
    const quote = assetRfqQuotePayload(row(), RFQ_ID)
    expect(quote).toMatchObject({
      v: 1,
      type: 'rfq_quote',
      rfq_id: RFQ_ID,
      from_amount: '100000000',
      to_amount: '99500000000',
      solver_pubkey: XONLY,
      valid_until: 2_000,
    })
  })

  /**
   * The absence that IS the contract. § 4.2: `refund_locktime` is present on
   * HTLC-class quotes and "absent for atomic class"; § 7.2 explains that
   * neither program carries a timelock, so there is no such deadline to name.
   * A client reading one here would size a recourse window against a number
   * describing nothing.
   */
  it('carries no refund_locktime, because this class has no timelock at all', () => {
    expect(assetRfqQuotePayload(row(), RFQ_ID)).not.toHaveProperty('refund_locktime')
  })

  it('publishes the offer address and script as the compare-only derivation', () => {
    // § 6: any contract identifier the solver sends is compare-only. The client
    // derives the same covenant from the quote's own amounts plus its own two
    // profile fields, and funds only its own derivation.
    const quote = assetRfqQuotePayload(row(), RFQ_ID) as { profile: Record<string, unknown> }
    expect(quote.profile).toMatchObject({
      offer_address: 'ark1qoffer',
      offer_pk_script: `5120${'d'.repeat(64)}`,
    })
  })

  it('echoes the pair it was quoted on', () => {
    expect(assetRfqQuotePayload(row(), RFQ_ID)).toMatchObject({ pair: `arkade:BTC->arkade:${ASSET_A}` })
  })
})

describe('assetRfqStateFromRow — the § 8 vocabulary', () => {
  it.each([
    ['quoted', 'quoted'],
    ['funded', 'funded'],
    ['filling', 'filling'],
    ['filled', 'settled'],
    ['refused', 'refused'],
    ['stuck', 'stuck'],
  ] as const)('maps %s to %s', (state, expected) => {
    expect(assetRfqStateFromRow(row({ state }))).toBe(expected)
  })

  /**
   * `filled` is `settled`, not `filled`, and that is the one mapping worth
   * arguing. § 7.2's `fulfill` pays the client and takes the deposit in ONE
   * transaction, so there is no interval where the outbound fill has landed and
   * the solver is still collecting — the state § 8 reserves `filled` for. When
   * that transaction confirms, both sides are done.
   */
  it('treats a confirmed fill as settled rather than as collection in progress', () => {
    expect(assetRfqStateFromRow(row({ state: 'filled' }))).toBe('settled')
  })
})

describe('assetRfqStatusPayload', () => {
  it('reports the state and the offer address', () => {
    expect(assetRfqStatusPayload(row(), RFQ_ID)).toMatchObject({
      v: 1,
      type: 'rfq_status',
      rfq_id: RFQ_ID,
      state: 'quoted',
      updated_at: 1_000,
      profile: { offer_address: 'ark1qoffer' },
    })
  })

  it('publishes the fill txid once there is one — the receipt this class has', () => {
    const status = assetRfqStatusPayload(row({ state: 'filled', fillTxid: 'ff'.repeat(32) }), RFQ_ID) as {
      profile: Record<string, unknown>
    }
    expect(status.profile.fill_txid).toBe('ff'.repeat(32))
  })

  it('omits the fill txid while there is none, rather than sending null', () => {
    const status = assetRfqStatusPayload(row(), RFQ_ID) as { profile: Record<string, unknown> }
    expect(status.profile).not.toHaveProperty('fill_txid')
  })

  it('carries the failure reason on a refused row', () => {
    const status = assetRfqStatusPayload(row({ state: 'refused', failureReason: 'quote expired' }), RFQ_ID) as {
      profile: Record<string, unknown>
    }
    expect(status.profile.failure_reason).toBe('quote expired')
  })
})

describe('assetRfqPairFor', () => {
  it('spells a BTC leg as the ticker and an asset leg as its id', () => {
    expect(assetRfqPairFor(null, ASSET_A)).toBe(`arkade:BTC->arkade:${ASSET_A}`)
    expect(assetRfqPairFor(ASSET_A, null)).toBe(`arkade:${ASSET_A}->arkade:BTC`)
  })
})
