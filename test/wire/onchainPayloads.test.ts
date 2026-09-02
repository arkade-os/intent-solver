import { describe, it, expect } from 'vitest'
import {
  RFQ_PAIR_ONCHAIN_SEND,
  OnchainRfqRequest,
  onchainRfqQuotePayload,
  onchainRfqStatusPayload,
  onchainRfqStateFromRow,
} from '@arkade-os/solver-corridors/wire/onchainPayloads.js'
import type { OnchainSendSwapRow } from '@arkade-os/solver-corridors/db/onchainSwaps.js'

const row: OnchainSendSwapRow = {
  id: 'swap-1',
  state: 'quoted',
  createdAt: 1000,
  updatedAt: 1000,
  paymentHash: 'aa'.repeat(32),
  amountSats: 50_000,
  payoutSats: 50_000,
  refundLocktime: 1_800_000_000,
  providerPubkey: 'bb'.repeat(32),
  serverPubkey: 'cc'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  pkScript: 'dd'.repeat(34),
  lockupAddress: 'tark1example',
  refundPkScript: 'ee'.repeat(34),
  emulatorPubkey: 'ff'.repeat(33),
  clientRefundPubkey: '44'.repeat(32),
  receiverPkScript: '55'.repeat(34),
  nonInteractiveParameters: null,
  payoutPubkey: '11'.repeat(32),
  htlcPubkey: '22'.repeat(32),
  htlcLocktime: 1_800_000_500,
  minConfirmations: 1,
  onchainAddress: 'bcrt1pexample',
  onchainPkScript: '33'.repeat(34),
  onchainLockupTxid: null,
  onchainLockupVout: null,
  onchainLockupValue: null,
  fundingTxid: null,
  fundingVout: null,
  preimage: null,
  claimArkTxid: null,
  onchainRefundTxid: null,
  refundArkTxid: null,
  refundOutcome: null,
  failureReason: null,
  rfqId: null,
  fundStartedAt: null,
}

describe('RfqRequest for arkade:BTC->onchain:BTC', () => {
  it('parses a valid onchain send request', () => {
    const parsed = OnchainRfqRequest.safeParse({
      v: 1,
      type: 'rfq_request',
      rfq_id: 'a'.repeat(64),
      pair: RFQ_PAIR_ONCHAIN_SEND,
      amount_side: 'to',
      amount: 50_000,
      profile: {
        payment_hash: 'aa'.repeat(32),
        payout_pubkey: 'bb'.repeat(32),
        refund_address: 'tark1example',
        client_refund_pubkey: 'cc'.repeat(32),
      },
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts amount_side "from" too — unlike the BOLT11 profile, nothing implies the amount', () => {
    const parsed = OnchainRfqRequest.safeParse({
      v: 1,
      type: 'rfq_request',
      rfq_id: 'a'.repeat(64),
      pair: RFQ_PAIR_ONCHAIN_SEND,
      amount_side: 'from',
      amount: 50_000,
      profile: {
        payment_hash: 'aa'.repeat(32),
        payout_pubkey: 'bb'.repeat(32),
        refund_address: 'tark1example',
        client_refund_pubkey: 'cc'.repeat(32),
      },
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects unknown fields (strict)', () => {
    const parsed = OnchainRfqRequest.safeParse({
      v: 1,
      type: 'rfq_request',
      rfq_id: 'a'.repeat(64),
      pair: RFQ_PAIR_ONCHAIN_SEND,
      amount_side: 'to',
      amount: 50_000,
      profile: {
        payment_hash: 'aa'.repeat(32),
        payout_pubkey: 'bb'.repeat(32),
        refund_address: 'tark1example',
        extra: 1,
      },
    })
    expect(parsed.success).toBe(false)
  })
})

describe('onchainRfqQuotePayload', () => {
  it('carries the binding fields at the top level, and both addresses distinctly in profile', () => {
    const payload = onchainRfqQuotePayload(row, 1_800_000_900, 'r1')
    expect(payload).toMatchObject({
      v: 1,
      type: 'rfq_quote',
      rfq_id: 'r1',
      pair: RFQ_PAIR_ONCHAIN_SEND,
      from_amount: 50_000,
      to_amount: 50_000,
      solver_pubkey: row.providerPubkey,
      refund_locktime: row.refundLocktime,
      valid_until: 1_800_000_900,
      profile: {
        payment_hash: row.paymentHash,
        htlc_pubkey: row.htlcPubkey,
        htlc_locktime: row.htlcLocktime,
        min_confirmations: row.minConfirmations,
        lockup_address: row.lockupAddress,
        htlc_address: row.onchainAddress,
      },
    })
  })

  it('quotes to_amount as the PAYOUT (amount minus fee), not the amount the client locks', () => {
    const payload = onchainRfqQuotePayload({ ...row, payoutSats: 49_450 }, 1_800_000_900, 'r1')
    expect(payload.from_amount).toBe(50_000)
    expect(payload.to_amount).toBe(49_450)
  })
})

describe('onchainRfqStateFromRow', () => {
  it('maps every lifecycle state to the RFQ vocabulary', () => {
    expect(onchainRfqStateFromRow({ ...row, state: 'quoted' })).toBe('quoted')
    expect(onchainRfqStateFromRow({ ...row, state: 'funded' })).toBe('funded')
    expect(onchainRfqStateFromRow({ ...row, state: 'funding_onchain' })).toBe('filling')
    expect(onchainRfqStateFromRow({ ...row, state: 'awaiting_claim' })).toBe('filled')
    expect(onchainRfqStateFromRow({ ...row, state: 'claiming' })).toBe('filled')
    expect(onchainRfqStateFromRow({ ...row, state: 'claimed' })).toBe('settled')
    expect(onchainRfqStateFromRow({ ...row, state: 'refunding_onchain' })).toBe('filling')
    expect(onchainRfqStateFromRow({ ...row, state: 'refunded' })).toBe('refunded')
    expect(onchainRfqStateFromRow({ ...row, state: 'stuck' })).toBe('stuck')
    expect(onchainRfqStateFromRow({ ...row, state: 'refused' })).toBe('refused')
  })
})

describe('onchainRfqStatusPayload', () => {
  it('includes the preimage only once settled', () => {
    const pending = onchainRfqStatusPayload(row, 'r1')
    expect(pending.profile).not.toHaveProperty('preimage')

    const settled = onchainRfqStatusPayload({ ...row, state: 'claimed', preimage: 'ab'.repeat(32) }, 'r1')
    expect((settled.profile as Record<string, unknown>).preimage).toBe('ab'.repeat(32))
  })
})
