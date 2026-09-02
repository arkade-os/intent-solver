import { describe, it, expect } from 'vitest'
import {
  RFQ_PAIR_RECEIVE,
  LightningReceiveRfqRequest,
  lightningReceiveRfqQuotePayload,
  lightningReceiveRfqStatusPayload,
  lightningReceiveRfqStateFromRow,
} from '@arkade-os/solver-corridors/wire/lightningReceivePayloads.js'
import type { ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'

const row: ReceiveSwapRow = {
  id: 'swap-1',
  state: 'quoted',
  createdAt: 1000,
  updatedAt: 1000,
  paymentHash: 'aa'.repeat(32),
  amountSats: 5_000,
  payoutSats: 5_000,
  invoice: 'lnbcrt50000n1...',
  invoiceExpiresAt: 1600,
  htlcExpiresAt: null,
  payoutAddress: 'tark1payoutexample',
  payoutPkScript: '11'.repeat(34),
  payoutPubkey: '22'.repeat(32),
  claimPacket: 'ZWFsZWQtY2lwaGVydGV4dA==',
  refundLocktime: 1_800_000_000,
  solverPubkey: '33'.repeat(32),
  serverPubkey: '44'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  emulatorPubkey: '55'.repeat(33),
  pkScript: '66'.repeat(34),
  lockupAddress: 'tark1lockupexample',
  solverRefundPkScript: '77'.repeat(34),
  nonInteractiveParameters: null,
  arkadeLockupTxid: null,
  arkadeLockupVout: null,
  arkadeLockupValue: null,
  revealedAt: null,
  settleAttemptedAt: null,
  preimage: null,
  refundArkTxid: null,
  failureReason: null,
  rfqId: null,
}

describe('RFQ_PAIR_RECEIVE', () => {
  it('is lightning:BTC->arkade:BTC, per docs/rfq-protocol.md §2 and §7.1.2', () => {
    expect(RFQ_PAIR_RECEIVE).toBe('lightning:BTC->arkade:BTC')
  })
})

describe('LightningReceiveRfqRequest', () => {
  const valid = {
    v: 1,
    type: 'rfq_request',
    rfq_id: 'a'.repeat(64),
    pair: RFQ_PAIR_RECEIVE,
    amount_side: 'to',
    amount: 5_000,
    profile: {
      payment_hash: 'aa'.repeat(32),
      payout_address: 'tark1payoutexample',
      payout_pubkey: 'bb'.repeat(32),
      claim_packet: 'ZWFsZWQtY2lwaGVydGV4dA==',
    },
  }

  it('parses a valid receive request', () => {
    expect(LightningReceiveRfqRequest.safeParse(valid).success).toBe(true)
  })

  it('requires amount — nothing implies it the way a BOLT11 does on the send leg', () => {
    const { amount: _amount, ...withoutAmount } = valid
    expect(LightningReceiveRfqRequest.safeParse(withoutAmount).success).toBe(false)
  })

  it('rejects unknown fields at the envelope level (strict)', () => {
    expect(LightningReceiveRfqRequest.safeParse({ ...valid, extra: 1 }).success).toBe(false)
  })

  it('rejects unknown fields inside profile (strict)', () => {
    expect(LightningReceiveRfqRequest.safeParse({ ...valid, profile: { ...valid.profile, extra: 1 } }).success).toBe(
      false,
    )
  })

  it('rejects a malformed payment_hash', () => {
    expect(
      LightningReceiveRfqRequest.safeParse({ ...valid, profile: { ...valid.profile, payment_hash: 'not-hex' } })
        .success,
    ).toBe(false)
  })

  it('rejects a malformed payout_pubkey', () => {
    expect(
      LightningReceiveRfqRequest.safeParse({ ...valid, profile: { ...valid.profile, payout_pubkey: 'zz'.repeat(32) } })
        .success,
    ).toBe(false)
  })

  it('never carries the preimage — only a sealed claim_packet the solver cannot read', () => {
    // Documents the protocol invariant (docs/rfq-protocol.md §6, §7.1.2): the
    // schema has no field named or shaped like a raw 32-byte preimage.
    expect(Object.keys(valid.profile)).not.toContain('preimage')
  })
})

describe('lightningReceiveRfqQuotePayload', () => {
  it('carries the binding fields at the top level, profile fields compare-only', () => {
    const payload = lightningReceiveRfqQuotePayload(row, 1_800_000_900, 'r1')
    expect(payload).toMatchObject({
      v: 1,
      type: 'rfq_quote',
      rfq_id: 'r1',
      pair: RFQ_PAIR_RECEIVE,
      from_amount: 5_000,
      to_amount: 5_000,
      solver_pubkey: row.solverPubkey,
      valid_until: 1_800_000_900,
      refund_locktime: row.refundLocktime,
      profile: {
        payment_hash: row.paymentHash,
        invoice: row.invoice,
        lockup_address: row.lockupAddress,
        solver_refund_pk_script: row.solverRefundPkScript,
      },
    })
  })

  it('quotes to_amount as the PAYOUT (amount minus fee), not the amount the client pays', () => {
    const payload = lightningReceiveRfqQuotePayload({ ...row, payoutSats: 4_900 }, 1_800_000_900, 'r1')
    expect(payload.from_amount).toBe(5_000)
    expect(payload.to_amount).toBe(4_900)
  })
})

describe('lightningReceiveRfqStateFromRow', () => {
  it('maps every lifecycle state to the RFQ vocabulary', () => {
    expect(lightningReceiveRfqStateFromRow({ ...row, state: 'quoted' })).toBe('quoted')
    expect(lightningReceiveRfqStateFromRow({ ...row, state: 'armed' })).toBe('funded')
    expect(lightningReceiveRfqStateFromRow({ ...row, state: 'funded' })).toBe('filling')
    expect(lightningReceiveRfqStateFromRow({ ...row, state: 'claimed' })).toBe('filled')
    expect(lightningReceiveRfqStateFromRow({ ...row, state: 'settled' })).toBe('settled')
    expect(lightningReceiveRfqStateFromRow({ ...row, state: 'refunding' })).toBe('filling')
    expect(lightningReceiveRfqStateFromRow({ ...row, state: 'refunded' })).toBe('refunded')
    expect(lightningReceiveRfqStateFromRow({ ...row, state: 'stuck' })).toBe('stuck')
    expect(lightningReceiveRfqStateFromRow({ ...row, state: 'refused' })).toBe('refused')
  })

  it('refines a refused row into expired when the failure reason says so', () => {
    expect(
      lightningReceiveRfqStateFromRow({ ...row, state: 'refused', failureReason: 'invoice expired unarmed' }),
    ).toBe('expired')
  })
})

describe('lightningReceiveRfqStatusPayload', () => {
  it('includes the preimage only once settled — never before, even once known at claimed', () => {
    const claimed = lightningReceiveRfqStatusPayload({ ...row, state: 'claimed', preimage: 'cc'.repeat(32) }, 'r1')
    expect(claimed.profile).not.toHaveProperty('preimage')

    const settled = lightningReceiveRfqStatusPayload({ ...row, state: 'settled', preimage: 'cc'.repeat(32) }, 'r1')
    expect((settled.profile as Record<string, unknown>).preimage).toBe('cc'.repeat(32))
  })

  it('includes the refund txid once refunded', () => {
    const payload = lightningReceiveRfqStatusPayload({ ...row, state: 'refunded', refundArkTxid: 'refund-txid' }, 'r1')
    expect((payload.profile as Record<string, unknown>).refund_txid).toBe('refund-txid')
  })
})
