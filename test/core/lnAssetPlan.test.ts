/**
 * The ordering rules that cost money on `lightning:BTC<->arkade:<asset>`.
 *
 * Every test here names the rule from `lnAssetPlan.ts`'s header that it pins.
 * The reason these are pure-function tests and not orchestrator tests is the
 * one `evmSendPlan.ts` states: a fake wallet, a fake emulator and a fake node
 * can all agree with each other and still be wrong about the ORDER, and order
 * is the whole of what makes a preimage-revealing leg safe.
 */

import { describe, it, expect } from 'vitest'
import {
  planLnAssetReceive,
  planLnAssetSend,
  type LnAssetReceiveObservation,
  type LnAssetReceivePlanRow,
  type LnAssetSendObservation,
  type LnAssetSendPlanRow,
} from '@arkade-os/solver-core/core/lnAssetPlan.js'

const NOW = 1_800_000_000
const PREIMAGE = 'ab'.repeat(32)

const receiveRow = (over: Partial<LnAssetReceivePlanRow> = {}): LnAssetReceivePlanRow => ({
  state: 'armed',
  invoiceExpiresAt: NOW + 3600,
  preimage: null,
  ...over,
})

const seenReceive = (over: Partial<LnAssetReceiveObservation> = {}): LnAssetReceiveObservation => ({
  lockupOutpointFound: false,
  lockupHoldsQuotedAsset: false,
  funding: { fund: true },
  preimage: null,
  refundDeadlineReached: false,
  nowSeconds: NOW,
  ...over,
})

const sendRow = (over: Partial<LnAssetSendPlanRow> = {}): LnAssetSendPlanRow => ({
  state: 'quoted',
  lockupDeadline: NOW + 90,
  refundLocktime: NOW + 7200,
  preimage: null,
  ...over,
})

const seenSend = (over: Partial<LnAssetSendObservation> = {}): LnAssetSendObservation => ({
  lockupHoldsQuotedAsset: false,
  payment: { pay: true },
  paymentOutcome: 'none',
  preimage: null,
  nowSeconds: NOW,
  ...over,
})

describe('planLnAssetReceive — the solver funds the asset', () => {
  /**
   * R1. The crash window: `fund()` succeeded and the transition never
   * persisted. Funding again pays the same lockup twice out of the solver's own
   * asset float with only ONE claim possible, and the gates below cannot see it
   * because they are about whether to CREATE exposure.
   */
  it('R1: adopts an existing lockup before any funding gate is consulted', () => {
    // The funding gate says NO and the invoice has expired — the two conditions
    // that would otherwise refuse this row and strand the asset already sent.
    const action = planLnAssetReceive(
      receiveRow({ invoiceExpiresAt: NOW - 1 }),
      seenReceive({ lockupOutpointFound: true, funding: { fund: false, reason: 'invoice_expired' } }),
    )
    expect(action).toEqual({ do: 'adopt_funding' })
  })

  it('R2: refuses to fund when the funding gate declines, naming its reason', () => {
    const action = planLnAssetReceive(receiveRow(), seenReceive({ funding: { fund: false, reason: 'htlc_not_armed' } }))
    expect(action).toEqual({ do: 'refuse', reason: 'refused to fund: htlc_not_armed' })
  })

  it('R2: funds only once the gate passes and no lockup exists', () => {
    expect(planLnAssetReceive(receiveRow(), seenReceive())).toEqual({ do: 'fund_asset' })
  })

  /**
   * R3/R5. The asset has already left the solver's float, so the held HTLC is
   * the only way it is paid for. A refund here would race a spend that has
   * already happened, and losing that race means the solver has neither.
   */
  it('R3: a readable preimage outranks the refund deadline', () => {
    const action = planLnAssetReceive(
      receiveRow({ state: 'funded' }),
      seenReceive({ preimage: PREIMAGE, refundDeadlineReached: true }),
    )
    expect(action).toEqual({ do: 'record_claim', preimage: PREIMAGE })
  })

  it('R5: re-reads the preimage while refunding, so a late claim stops the push', () => {
    const action = planLnAssetReceive(
      receiveRow({ state: 'refunding' }),
      seenReceive({ preimage: PREIMAGE, lockupHoldsQuotedAsset: true }),
    )
    expect(action).toEqual({ do: 'record_claim', preimage: PREIMAGE })
  })

  it('R6: refunds only once the deadline has opened', () => {
    expect(planLnAssetReceive(receiveRow({ state: 'funded' }), seenReceive())).toEqual({ do: 'wait' })
    expect(planLnAssetReceive(receiveRow({ state: 'funded' }), seenReceive({ refundDeadlineReached: true }))).toEqual({
      do: 'refund_asset',
    })
  })

  /**
   * R4. `claimed` without a preimage is a corrupt row, and the cost of guessing
   * is settling a held HTLC — collecting the client's sats — for an asset
   * nobody ever claimed.
   */
  it('R4: never settles the HTLC without a preimage', () => {
    expect(planLnAssetReceive(receiveRow({ state: 'claimed' }), seenReceive())).toEqual({
      do: 'stick',
      reason: 'claimed state with no preimage',
    })
    expect(planLnAssetReceive(receiveRow({ state: 'claimed', preimage: PREIMAGE }), seenReceive())).toEqual({
      do: 'settle_htlc',
      preimage: PREIMAGE,
    })
  })

  /**
   * R7. Until the row dies it holds capacity against the house cap, so it is
   * refused at its own deadline rather than at a refund locktime hours later.
   */
  it('R7: refuses an unarmed quote at the invoice deadline, not later', () => {
    expect(planLnAssetReceive(receiveRow({ state: 'quoted' }), seenReceive())).toEqual({ do: 'wait' })
    expect(planLnAssetReceive(receiveRow({ state: 'quoted' }), seenReceive({ nowSeconds: NOW + 3600 }))).toEqual({
      do: 'refuse',
      reason: 'invoice expired before it was ever armed',
    })
  })

  it('reports an empty lockup with no readable claim as needing a human', () => {
    const action = planLnAssetReceive(receiveRow({ state: 'refunding' }), seenReceive())
    expect(action).toEqual({
      do: 'stick',
      reason: 'lockup empty during refunding with no matching claim found',
    })
  })

  it('does nothing in every terminal state', () => {
    for (const state of ['settled', 'refunded', 'refused', 'stuck'] as const) {
      expect(planLnAssetReceive(receiveRow({ state }), seenReceive({ preimage: PREIMAGE }))).toEqual({ do: 'wait' })
    }
  })
})

describe('planLnAssetSend — the client funds the asset, the solver pays sats', () => {
  /**
   * S1. THE rule this leg exists to enforce, and the one a sats-shaped gate
   * cannot ask: a lockup carrying the correct sats carrier and the wrong asset
   * amount reads as funded to every `.value` sum in this repo.
   */
  it('S1: never pays against a lockup that does not hold the quoted asset amount', () => {
    expect(planLnAssetSend(sendRow(), seenSend({ lockupHoldsQuotedAsset: false }))).toEqual({ do: 'wait' })
    expect(planLnAssetSend(sendRow(), seenSend({ lockupHoldsQuotedAsset: true }))).toEqual({ do: 'pay_invoice' })
  })

  it('S1: re-asks at funded rather than inheriting the earlier observation', () => {
    const action = planLnAssetSend(sendRow({ state: 'funded' }), seenSend({ lockupHoldsQuotedAsset: false }))
    expect(action).toEqual({ do: 'refuse', reason: 'asset lockup no longer holds the quoted amount' })
  })

  it('S1: honours the payment gate at funded, naming its reason', () => {
    const action = planLnAssetSend(
      sendRow({ state: 'funded' }),
      seenSend({ lockupHoldsQuotedAsset: true, payment: { pay: false, reason: 'claim_window_too_short' } }),
    )
    expect(action).toEqual({ do: 'refuse', reason: 'refused to pay: claim_window_too_short' })
  })

  /**
   * S2. Once the preimage exists the lockup is collectable, and a branch that
   * checked the payment outcome first could refuse a row whose asset is sitting
   * there for the taking.
   */
  it('S2: a preimage outranks a payment reported as failed', () => {
    const action = planLnAssetSend(
      sendRow({ state: 'paying' }),
      seenSend({ preimage: PREIMAGE, paymentOutcome: 'failed' }),
    )
    expect(action).toEqual({ do: 'record_payment', preimage: PREIMAGE })
  })

  it('S2: claims once the payment is recorded', () => {
    expect(planLnAssetSend(sendRow({ state: 'paid', preimage: PREIMAGE }), seenSend())).toEqual({
      do: 'claim_asset',
      preimage: PREIMAGE,
    })
  })

  /**
   * S3. Past the locktime the client's own refund is live, so a claim races it.
   * The honest answer is a human, not a claim that may already have lost.
   */
  it('S3: never claims at or after the refund locktime', () => {
    const at = planLnAssetSend(sendRow({ state: 'paid', preimage: PREIMAGE }), seenSend({ nowSeconds: NOW + 7200 }))
    expect(at).toEqual({ do: 'stick', reason: 'preimage revealed but the asset refund window has closed' })

    const before = planLnAssetSend(sendRow({ state: 'paid', preimage: PREIMAGE }), seenSend({ nowSeconds: NOW + 7199 }))
    expect(before).toEqual({ do: 'claim_asset', preimage: PREIMAGE })
  })

  /**
   * S4. Every second past the quote the fixed asset/BTC rate decays against the
   * solver, so a late lockup is refused rather than filled at a stale rate. § 5
   * forbids re-pricing it silently and permits refusing it.
   */
  it('S4: refuses a lockup funded after the quote expired, rather than filling it', () => {
    const action = planLnAssetSend(sendRow(), seenSend({ lockupHoldsQuotedAsset: true, nowSeconds: NOW + 91 }))
    expect(action).toEqual({ do: 'refuse', reason: 'asset lockup funded after the quote expired' })
  })

  it('S4: refuses an unfunded quote at its own deadline', () => {
    expect(planLnAssetSend(sendRow(), seenSend({ nowSeconds: NOW + 91 }))).toEqual({
      do: 'refuse',
      reason: 'quote expired before the client funded the asset lockup',
    })
  })

  /**
   * S5. A payment in flight whose outcome is unknown must never be retried:
   * guessing "it did not land" pays the invoice twice out of the solver's float.
   */
  it('S5: waits on an in-flight payment and never re-issues it', () => {
    expect(planLnAssetSend(sendRow({ state: 'paying' }), seenSend({ paymentOutcome: 'in_flight' }))).toEqual({
      do: 'wait',
    })
    expect(planLnAssetSend(sendRow({ state: 'paying' }), seenSend({ paymentOutcome: 'none' }))).toEqual({ do: 'wait' })
  })

  it('S5: refuses only on a payment that provably failed', () => {
    expect(planLnAssetSend(sendRow({ state: 'paying' }), seenSend({ paymentOutcome: 'failed' }))).toEqual({
      do: 'refuse',
      reason: 'the outbound payment failed and nothing left the node',
    })
  })

  /** Success without a preimage is not a receipt this leg can collect against. */
  it('S5: sticks on a success it has no preimage for', () => {
    expect(planLnAssetSend(sendRow({ state: 'paying' }), seenSend({ paymentOutcome: 'succeeded' }))).toEqual({
      do: 'stick',
      reason: 'the payment reports success with no preimage to claim against',
    })
    for (const state of ['paid', 'claiming'] as const) {
      expect(planLnAssetSend(sendRow({ state }), seenSend())).toEqual({
        do: 'stick',
        reason: 'the payment settled but no preimage is recorded to claim with',
      })
    }
  })

  /**
   * S6. The client funded and the covenant's non-interactive refund needs no
   * solver signature, so no plan this function returns may be a refund.
   */
  it('S6: never plans a refund, in any state', () => {
    const states = ['quoted', 'funded', 'paying', 'paid', 'claiming', 'claimed', 'refused', 'stuck'] as const
    for (const state of states) {
      for (const preimage of [null, PREIMAGE]) {
        for (const outcome of ['none', 'in_flight', 'succeeded', 'failed'] as const) {
          const action = planLnAssetSend(
            sendRow({ state, preimage }),
            seenSend({ paymentOutcome: outcome, lockupHoldsQuotedAsset: true }),
          )
          expect(action.do).not.toMatch(/refund/)
        }
      }
    }
  })

  it('does nothing in every terminal state', () => {
    for (const state of ['claimed', 'refused', 'stuck'] as const) {
      expect(planLnAssetSend(sendRow({ state, preimage: PREIMAGE }), seenSend())).toEqual({ do: 'wait' })
    }
  })
})
