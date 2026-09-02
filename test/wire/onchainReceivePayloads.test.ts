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
}

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
