import { describe, it, expect } from 'vitest'
import {
  RFQ_PAIR_ONCHAIN_RECEIVE,
  OnchainReceiveRfqRequest,
  onchainReceiveRfqQuotePayload,
  onchainReceiveRfqStatusPayload,
  onchainReceiveRfqStateFromRow,
} from '@arkade-os/solver-corridors/wire/onchainReceivePayloads.js'
import type { OnchainReceiveSwapRow } from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'

const row: OnchainReceiveSwapRow = {
  id: 'swap-1',
  state: 'quoted',
  createdAt: 1000,
  updatedAt: 1000,
  paymentHash: 'aa'.repeat(32),
  amountSats: 50_000,
  payoutSats: 50_000,
  htlcLocktime: 1_800_000_500,
  refundLocktime: 1_800_000_000,
  minConfirmations: 1,
  providerPubkey: 'bb'.repeat(32),
  clientPayoutPubkey: 'dd'.repeat(32),
  serverPubkey: 'cc'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  emulatorPubkey: 'ff'.repeat(33),
  pkScript: 'dd'.repeat(34),
  lockupAddress: 'tark1example',
  refundPkScript: 'ee'.repeat(34),
  clientPayoutPkScript: '77'.repeat(34),
  nonInteractiveParameters: null,
  htlcPubkey: '22'.repeat(32),
  clientOnchainRefundPubkey: '11'.repeat(32),
  onchainAddress: 'bcrt1pexample',
  onchainPkScript: '33'.repeat(34),
  claimPacket: 'ZmFrZS1zZWFsZWQtcGFja2V0', // base64
  fundingTxid: null,
  fundingVout: null,
  arkadeFundTxid: null,
  preimage: null,
  arkadeClaimTxid: null,
  onchainClaimTxid: null,
  arkadeRefundTxid: null,
  refundOutcome: null,
  failureReason: null,
  rfqId: null,
  fundStartedAt: null,
  stampedAt: null,
  fundedValueSats: null,
  fundedPayoutSats: null,
  minFromSats: null,
  maxFromSats: null,
}

describe('the wire a client that declared no band still sees', () => {
  // Recorded by running 249ead5's own `onchainReceivePayloads.ts` against this
  // exact row in the same process, then pasting what it serialised. Key order
  // included: this is the bytes, not the shape. `toMatchObject` elsewhere in
  // this file passes happily when a key is ADDED, which is the one thing the
  // tolerance band could break for an existing client.
  const QUOTE_249EAD5 =
    '{"v":1,"type":"rfq_quote","rfq_id":"rfq-1","pair":"onchain:BTC->arkade:BTC","from_amount":50000,' +
    '"to_amount":49450,"solver_pubkey":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",' +
    '"valid_until":1800000900,"refund_locktime":1800000000,"profile":{"payment_hash":' +
    '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","claim_pubkey":' +
    '"2222222222222222222222222222222222222222222222222222222222222222","htlc_locktime":1800000500,' +
    '"min_confirmations":1,"lockup_address":"tark1example","htlc_address":"bcrt1pexample",' +
    '"solver_refund_pk_script":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}}'

  const QUOTED_STATUS_249EAD5 =
    '{"v":1,"type":"rfq_status","rfq_id":"rfq-1","state":"quoted","updated_at":1000,"profile":{"payment_hash":' +
    '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","lockup_address":"tark1example",' +
    '"htlc_address":"bcrt1pexample","funding_txid":null,"arkade_claim_txid":null,"settle_txid":null,' +
    '"refund_txid":null,"failure_reason":null}}'

  const noBand = { ...row, payoutSats: 49_450 }

  it('serialises the quote byte-for-byte as it did before the band existed', () => {
    expect(JSON.stringify(onchainReceiveRfqQuotePayload(noBand, 1_800_000_900, 'rfq-1'))).toBe(QUOTE_249EAD5)
  })

  it('serialises rfq_status byte-for-byte as it did before the band existed', () => {
    expect(JSON.stringify(onchainReceiveRfqStatusPayload(noBand, 'rfq-1'))).toBe(QUOTED_STATUS_249EAD5)
  })

  it('accepts a request that names no band, exactly as before', () => {
    const parsed = OnchainReceiveRfqRequest.safeParse({
      v: 1,
      type: 'rfq_request',
      rfq_id: 'a'.repeat(64),
      pair: RFQ_PAIR_ONCHAIN_RECEIVE,
      amount_side: 'from',
      amount: 50_000,
      profile: {
        payment_hash: 'aa'.repeat(32),
        refund_pubkey: '11'.repeat(32),
        payout_address: 'tark1example',
        payout_pubkey: 'dd'.repeat(32),
      },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.min_from_amount).toBeUndefined()
      expect(parsed.data.max_from_amount).toBeUndefined()
    }
  })
})

describe('the tolerance band on the wire', () => {
  const bandRequest = (over: Record<string, unknown>) => ({
    v: 1,
    type: 'rfq_request',
    rfq_id: 'a'.repeat(64),
    pair: RFQ_PAIR_ONCHAIN_RECEIVE,
    amount_side: 'from',
    amount: 50_000,
    profile: {
      payment_hash: 'aa'.repeat(32),
      refund_pubkey: '11'.repeat(32),
      payout_address: 'tark1example',
      payout_pubkey: 'dd'.repeat(32),
    },
    ...over,
  })

  it('accepts both bounds together, in the § 2.1 string form', () => {
    const parsed = OnchainReceiveRfqRequest.safeParse(
      bandRequest({ min_from_amount: '49000', max_from_amount: '51000' }),
    )
    expect(parsed.success).toBe(true)
    if (parsed.success) expect([parsed.data.min_from_amount, parsed.data.max_from_amount]).toEqual([49_000, 51_000])
  })

  it.each([
    ['min without max', { min_from_amount: 49_000 }],
    ['max without min', { max_from_amount: 51_000 }],
  ])('refuses %s', (_label, over) => {
    expect(OnchainReceiveRfqRequest.safeParse(bandRequest(over)).success).toBe(false)
  })

  it('refuses an inverted band', () => {
    expect(
      OnchainReceiveRfqRequest.safeParse(bandRequest({ min_from_amount: 51_000, max_from_amount: 49_000 })).success,
    ).toBe(false)
  })

  it('refuses a bound that is not a canonical amount', () => {
    expect(
      OnchainReceiveRfqRequest.safeParse(bandRequest({ min_from_amount: '4.9e4', max_from_amount: 51_000 })).success,
    ).toBe(false)
  })

  it('echoes the band the row was bound to, and only then', () => {
    const quote = onchainReceiveRfqQuotePayload(
      { ...row, minFromSats: 49_000, maxFromSats: 51_000 },
      1_800_000_900,
      'rfq-1',
    )
    expect(quote).toMatchObject({ min_from_amount: 49_000, max_from_amount: 51_000 })
    expect(onchainReceiveRfqQuotePayload(row, 1_800_000_900, 'rfq-1')).not.toHaveProperty('min_from_amount')
  })

  it('reports the amended amounts on rfq_status once a swap was re-sized', () => {
    const amended = onchainReceiveRfqStatusPayload(
      { ...row, state: 'awaiting_claim', fundedValueSats: 48_000, fundedPayoutSats: 47_450 },
      'rfq-1',
    )
    expect(amended.profile).toMatchObject({ funded_from_amount: 48_000, funded_to_amount: 47_450 })
    expect(onchainReceiveRfqStatusPayload(row, 'rfq-1').profile).not.toHaveProperty('funded_from_amount')
  })
})

describe('RfqRequest for onchain:BTC->arkade:BTC', () => {
  const validRequest = {
    v: 1,
    type: 'rfq_request',
    rfq_id: 'a'.repeat(64),
    pair: RFQ_PAIR_ONCHAIN_RECEIVE,
    amount_side: 'to',
    amount: 50_000,
    profile: {
      payment_hash: 'aa'.repeat(32),
      claim_packet: 'ZmFrZS1zZWFsZWQtcGFja2V0',
      refund_pubkey: '11'.repeat(32),
      payout_address: 'tark1clientaddress',
      payout_pubkey: '22'.repeat(32),
    },
  }

  it('parses a valid onchain receive request', () => {
    const parsed = OnchainReceiveRfqRequest.safeParse(validRequest)
    expect(parsed.success).toBe(true)
  })

  it('rejects unknown top-level fields (strict)', () => {
    const parsed = OnchainReceiveRfqRequest.safeParse({ ...validRequest, extra: 1 })
    expect(parsed.success).toBe(false)
  })

  it('accepts a request that omits claim_packet — a client with no covclaimd claims for itself', () => {
    const { claim_packet: _packet, ...withoutPacket } = validRequest.profile
    expect(OnchainReceiveRfqRequest.safeParse({ ...validRequest, profile: withoutPacket }).success).toBe(true)
  })

  it('still rejects an EMPTY claim_packet, so omission is the only way to say absent', () => {
    const parsed = OnchainReceiveRfqRequest.safeParse({
      ...validRequest,
      profile: { ...validRequest.profile, claim_packet: '' },
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown profile fields (strict)', () => {
    const parsed = OnchainReceiveRfqRequest.safeParse({
      ...validRequest,
      profile: { ...validRequest.profile, extra: 1 },
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a malformed payment_hash', () => {
    const parsed = OnchainReceiveRfqRequest.safeParse({
      ...validRequest,
      profile: { ...validRequest.profile, payment_hash: 'not-hex' },
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a malformed refund_pubkey', () => {
    const parsed = OnchainReceiveRfqRequest.safeParse({
      ...validRequest,
      profile: { ...validRequest.profile, refund_pubkey: 'short' },
    })
    expect(parsed.success).toBe(false)
  })

  it('requires amount_side to be "to" or "from"', () => {
    const parsed = OnchainReceiveRfqRequest.safeParse({ ...validRequest, amount_side: 'sideways' })
    expect(parsed.success).toBe(false)
  })
})

describe('onchainReceiveRfqQuotePayload', () => {
  it('carries the binding fields at the top level and profile fields client-verifiable locally', () => {
    const payload = onchainReceiveRfqQuotePayload(row, 1_800_000_900, 'rfq-1')
    expect(payload).toMatchObject({
      v: 1,
      type: 'rfq_quote',
      rfq_id: 'rfq-1',
      pair: RFQ_PAIR_ONCHAIN_RECEIVE,
      from_amount: 50_000,
      to_amount: 50_000,
      solver_pubkey: row.providerPubkey,
      valid_until: 1_800_000_900,
      refund_locktime: row.refundLocktime,
      profile: {
        payment_hash: row.paymentHash,
        claim_pubkey: row.htlcPubkey,
        htlc_locktime: row.htlcLocktime,
        min_confirmations: row.minConfirmations,
        lockup_address: row.lockupAddress,
        htlc_address: row.onchainAddress,
        solver_refund_pk_script: row.refundPkScript,
      },
    })
  })

  it('quotes to_amount as the PAYOUT (amount minus fee), not the amount the client funds', () => {
    const payload = onchainReceiveRfqQuotePayload({ ...row, payoutSats: 49_450 }, 1_800_000_900, 'rfq-1')
    expect(payload.from_amount).toBe(50_000)
    expect(payload.to_amount).toBe(49_450)
  })
})

describe('onchainReceiveRfqStateFromRow', () => {
  const at = (state: OnchainReceiveSwapRow['state'], extra: Partial<OnchainReceiveSwapRow> = {}) =>
    onchainReceiveRfqStateFromRow({ ...row, state, ...extra })

  it('maps every internal state onto the RFQ §8 vocabulary', () => {
    expect(at('quoted')).toBe('quoted')
    expect(at('awaiting_confirmations')).toBe('funded')
    expect(at('funding_arkade')).toBe('filling')
    expect(at('awaiting_claim')).toBe('filled')
    expect(at('claimed')).toBe('filled')
    expect(at('settled')).toBe('settled')
    expect(at('refunding_arkade')).toBe('filling')
    expect(at('refunded')).toBe('refunded')
    expect(at('stuck')).toBe('stuck')
  })

  it('maps a plain refused row to refused', () => {
    expect(at('refused', { failureReason: 'amount_out_of_range' })).toBe('refused')
  })

  it('maps a timed-out quote to expired', () => {
    expect(at('refused', { failureReason: 'lockup timeout' })).toBe('expired')
  })
})

describe('onchainReceiveRfqStatusPayload', () => {
  it('omits the preimage before settlement', () => {
    const payload = onchainReceiveRfqStatusPayload(row, 'rfq-1') as { profile: Record<string, unknown> }
    expect(payload.profile.preimage).toBeUndefined()
  })

  it('publishes the preimage only once settled', () => {
    const settledRow: OnchainReceiveSwapRow = { ...row, state: 'settled', preimage: 'ab'.repeat(32) }
    const payload = onchainReceiveRfqStatusPayload(settledRow, 'rfq-1') as {
      state: string
      profile: Record<string, unknown>
    }
    expect(payload.state).toBe('settled')
    expect(payload.profile.preimage).toBe('ab'.repeat(32))
  })

  it('never publishes a preimage that exists on disk but the row is not settled', () => {
    // claimed carries the preimage on disk (it is known) but the swap is not
    // done — the onchain side has not been claimed yet — so it must not leak.
    const claimedRow: OnchainReceiveSwapRow = { ...row, state: 'claimed', preimage: 'ab'.repeat(32) }
    const payload = onchainReceiveRfqStatusPayload(claimedRow, 'rfq-1') as { profile: Record<string, unknown> }
    expect(payload.profile.preimage).toBeUndefined()
  })
})
