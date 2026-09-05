/**
 * The ordering rules that can lose funds on `onchain:BTC->arkade:<asset>`, one
 * describe block each.
 *
 * Pure inputs, no fixtures: that is the whole reason the decision was split out
 * of the service. Every case below costs real money if the branch order changes.
 */

import { describe, it, expect } from 'vitest'
import {
  planOnchainAssetReceive,
  onchainAssetFundingGate,
  MIN_ARKADE_FUND_WINDOW,
  type OnchainAssetReceiveObservation,
  type OnchainAssetReceivePlanRow,
} from '@arkade-os/solver-core/core/onchainAssetReceivePlan.js'
import { UNILATERAL_RECOURSE_MARGIN } from '@arkade-os/solver-core/core/receive.js'
import type { OnchainAssetReceiveState } from '@arkade-os/solver-core/core/onchainAssetSwapState.js'

const NOW = 1_800_000_000
const AMOUNT = 100_000
const PAYOUT = 250_000n
/** Far enough out that the funding gate passes by default. */
const REFUND_LOCKTIME = NOW + 4 * MIN_ARKADE_FUND_WINDOW
const HTLC_LOCKTIME = REFUND_LOCKTIME + 3 * UNILATERAL_RECOURSE_MARGIN

const row = (over: Partial<OnchainAssetReceivePlanRow> = {}): OnchainAssetReceivePlanRow => ({
  state: 'quoted' as OnchainAssetReceiveState,
  amountSats: AMOUNT,
  payoutUnits: PAYOUT,
  minConfirmations: 1,
  htlcLocktime: HTLC_LOCKTIME,
  refundLocktime: REFUND_LOCKTIME,
  refundWithoutReceiverDelay: 600,
  fundingDeadline: NOW + 900,
  preimage: null,
  onchainClaimTxid: null,
  ...over,
})

const seen = (over: Partial<OnchainAssetReceiveObservation> = {}): OnchainAssetReceiveObservation => ({
  htlcOutputs: [],
  lockupFunded: false,
  lockupEmpty: false,
  preimage: null,
  onchainClaimOutcome: 'unknown',
  priorSpend: null,
  inventorySufficient: true,
  nowSeconds: NOW,
  ...over,
})

const output = (over: Partial<OnchainAssetReceiveObservation['htlcOutputs'][number]> = {}) => ({
  txid: 'ab'.repeat(32),
  vout: 0,
  valueSats: AMOUNT,
  confirmations: 1,
  ...over,
})

describe('rule 1 - never fund the asset lockup before min_confirmations', () => {
  it('waits while the client funding is still unconfirmed', () => {
    const action = planOnchainAssetReceive(
      row({ state: 'awaiting_confirmations', minConfirmations: 2 }),
      seen({ htlcOutputs: [output({ confirmations: 1 })] }),
    )
    // One confirmation against a policy of two is a transaction that can still
    // be replaced; funding here pays out the asset against nothing.
    expect(action).toEqual({ do: 'wait' })
  })

  it('hands off to funding once the depth policy is met', () => {
    const action = planOnchainAssetReceive(
      row({ state: 'awaiting_confirmations', minConfirmations: 2 }),
      seen({ htlcOutputs: [output({ confirmations: 2 })] }),
    )
    expect(action).toEqual({ do: 'begin_funding' })
  })
})

describe('rule 2 - never fund once the arkade refund window is closing', () => {
  it('refuses while still waiting, rather than sitting until the deadline', () => {
    const action = planOnchainAssetReceive(
      row({ state: 'awaiting_confirmations' }),
      seen({ nowSeconds: REFUND_LOCKTIME - MIN_ARKADE_FUND_WINDOW }),
    )
    expect(action).toMatchObject({ do: 'refuse' })
    expect((action as { reason: string }).reason).toContain('arkade refund window closing')
  })

  it('refuses to fund a row whose window shut while it sat in funding_arkade', () => {
    const action = planOnchainAssetReceive(
      row({ state: 'funding_arkade' }),
      seen({ nowSeconds: REFUND_LOCKTIME - MIN_ARKADE_FUND_WINDOW }),
    )
    expect(action).toMatchObject({ do: 'refuse' })
  })

  it('funds with one second of window left', () => {
    const action = planOnchainAssetReceive(
      row({ state: 'funding_arkade' }),
      seen({ nowSeconds: REFUND_LOCKTIME - MIN_ARKADE_FUND_WINDOW - 1 }),
    )
    expect(action).toEqual({ do: 'fund_arkade' })
  })
})

describe('rule 3 - never fund when our unilateral recourse opens after the htlc timeout', () => {
  it('refuses when the solver could not reclaim before the client can', () => {
    // The trade #69 describes: the client lets the L1 HTLC time out, reclaims it,
    // and still takes the asset payout — both sides of one swap.
    const action = planOnchainAssetReceive(
      row({ state: 'funding_arkade', refundWithoutReceiverDelay: 10 * MIN_ARKADE_FUND_WINDOW }),
      seen(),
    )
    expect(action).toMatchObject({ do: 'refuse' })
    expect((action as { reason: string }).reason).toContain('unilateral recourse opens after')
  })

  it('is the gate, not a coincidence of the other bound', () => {
    const near = { refundLocktime: REFUND_LOCKTIME, htlcLocktime: HTLC_LOCKTIME, refundWithoutReceiverDelay: 600 }
    expect(onchainAssetFundingGate(near, NOW)).toEqual({ fund: true })
    expect(onchainAssetFundingGate({ ...near, refundWithoutReceiverDelay: 10 * MIN_ARKADE_FUND_WINDOW }, NOW)).toEqual({
      fund: false,
      reason: 'refused to fund: solver unilateral recourse opens after the onchain htlc timeout',
    })
  })
})

describe('rule 4 - exposure that already exists is adopted, never re-gated', () => {
  it('adopts a funded lockup even though the window has since shut', () => {
    // The asset is already out. Refusing here would discard the only record of
    // where it went, which loses the money rather than protecting it.
    const action = planOnchainAssetReceive(
      row({ state: 'funding_arkade' }),
      seen({ lockupFunded: true, nowSeconds: REFUND_LOCKTIME - 1 }),
    )
    expect(action).toEqual({ do: 'adopt_lockup' })
  })

  it('adopts even with the float drained, since the payment already happened', () => {
    const action = planOnchainAssetReceive(
      row({ state: 'funding_arkade' }),
      seen({ lockupFunded: true, inventorySufficient: false }),
    )
    expect(action).toEqual({ do: 'adopt_lockup' })
  })
})

describe('rule 5 - a revealed preimage outranks everything', () => {
  it('claims the L1 HTLC even past the arkade refund deadline', () => {
    const action = planOnchainAssetReceive(
      row({ state: 'claimed', preimage: 'cd'.repeat(32) }),
      seen({ nowSeconds: REFUND_LOCKTIME + 1 }),
    )
    expect(action).toEqual({ do: 'claim_onchain', preimage: 'cd'.repeat(32) })
  })

  it('beats the refund branch on a row already refunding', () => {
    // Checking the Arkade side first would send this to refund while a
    // claimable preimage sat on the row.
    const action = planOnchainAssetReceive(
      row({ state: 'refunding_arkade' }),
      seen({ preimage: 'cd'.repeat(32), lockupEmpty: false }),
    )
    expect(action).toEqual({ do: 'claim_onchain', preimage: 'cd'.repeat(32) })
  })

  it('records P on the row before deciding anything about settlement', () => {
    // `claimed` is the only legal edge in from `awaiting_claim`, and settling
    // straight from it would be a transition the store rejects.
    const action = planOnchainAssetReceive(
      row({ state: 'awaiting_claim' }),
      seen({ preimage: 'cd'.repeat(32), priorSpend: 'ours' }),
    )
    expect(action).toEqual({ do: 'claim_onchain', preimage: 'cd'.repeat(32) })
  })
})

describe('rule 6 - a broadcast claim is not a landed one', () => {
  const claimed = row({ state: 'claimed', preimage: 'cd'.repeat(32), onchainClaimTxid: 'ef'.repeat(32) })

  it('waits on a claim still in the mempool', () => {
    expect(planOnchainAssetReceive(claimed, seen({ onchainClaimOutcome: 'mempool' }))).toEqual({ do: 'wait' })
  })

  it('settles only once the claim confirmed', () => {
    expect(planOnchainAssetReceive(claimed, seen({ onchainClaimOutcome: 'confirmed' }))).toEqual({
      do: 'record_settled',
    })
  })

  it('rebuilds when the recorded claim never went out', () => {
    expect(planOnchainAssetReceive(claimed, seen({ onchainClaimOutcome: 'unknown' }))).toEqual({
      do: 'claim_onchain',
      preimage: 'cd'.repeat(32),
    })
  })

  it('reads our own prior spend as settled, not as the client refunding', () => {
    const action = planOnchainAssetReceive(
      row({ state: 'claimed', preimage: 'cd'.repeat(32) }),
      seen({ priorSpend: 'ours' }),
    )
    expect(action).toEqual({ do: 'record_settled' })
  })

  it('sticks when somebody else took the HTLC', () => {
    const action = planOnchainAssetReceive(
      row({ state: 'claimed', preimage: 'cd'.repeat(32) }),
      seen({ priorSpend: 'theirs' }),
    )
    expect(action).toMatchObject({ do: 'stick' })
  })
})

describe('rule 7 - a confirmed funding mismatch is refused, never adopted', () => {
  it('refuses a confirmed output for the wrong amount', () => {
    const action = planOnchainAssetReceive(row(), seen({ htlcOutputs: [output({ valueSats: AMOUNT - 1 })] }))
    expect(action).toMatchObject({ do: 'refuse' })
    expect((action as { reason: string }).reason).toContain('funding mismatch')
  })

  it('waits on an UNCONFIRMED mismatch, which can still be replaced or completed', () => {
    const action = planOnchainAssetReceive(
      row(),
      seen({ htlcOutputs: [output({ valueSats: AMOUNT - 1, confirmations: 0 })] }),
    )
    expect(action).toEqual({ do: 'wait' })
  })

  it('takes an exact match ahead of any mismatch present alongside it', () => {
    const action = planOnchainAssetReceive(
      row(),
      seen({ htlcOutputs: [output({ valueSats: AMOUNT - 1 }), output({ txid: 'cc'.repeat(32), vout: 1 })] }),
    )
    expect(action).toEqual({ do: 'await_confirmations', txid: 'cc'.repeat(32), vout: 1 })
  })

  it('refuses an unfunded quote at its own deadline', () => {
    expect(planOnchainAssetReceive(row(), seen({ nowSeconds: NOW + 900 }))).toEqual({
      do: 'refuse',
      reason: 'lockup timeout',
    })
  })
})

describe('rule 9 - inventory is re-checked immediately before funding', () => {
  it('refuses to fund once the float no longer covers the quoted payout', () => {
    const action = planOnchainAssetReceive(row({ state: 'funding_arkade' }), seen({ inventorySufficient: false }))
    expect(action).toMatchObject({ do: 'refuse' })
    expect((action as { reason: string }).reason).toContain('asset float no longer covers')
  })

  it('funds when the float still holds it', () => {
    expect(planOnchainAssetReceive(row({ state: 'funding_arkade' }), seen())).toEqual({ do: 'fund_arkade' })
  })
})

describe('the deadline backstop after funding', () => {
  it('waits while the window is open', () => {
    expect(planOnchainAssetReceive(row({ state: 'awaiting_claim' }), seen())).toEqual({ do: 'wait' })
  })

  it('refunds once the window shuts with no preimage in sight', () => {
    const action = planOnchainAssetReceive(
      row({ state: 'awaiting_claim' }),
      seen({ nowSeconds: REFUND_LOCKTIME - MIN_ARKADE_FUND_WINDOW }),
    )
    expect(action).toEqual({ do: 'refund_arkade' })
  })

  it('leaves an emptied lockup to the caller grace rather than deciding it here', () => {
    expect(planOnchainAssetReceive(row({ state: 'refunding_arkade' }), seen({ lockupEmpty: true }))).toEqual({
      do: 'wait',
    })
  })
})

describe('terminal states', () => {
  it.each(['settled', 'refunded', 'refused', 'stuck'] as const)('%s does nothing', (state) => {
    expect(planOnchainAssetReceive(row({ state }), seen({ preimage: 'cd'.repeat(32) }))).toEqual({ do: 'wait' })
  })

  it('a claimed row with no preimage anywhere is corrupt, not idle', () => {
    expect(planOnchainAssetReceive(row({ state: 'claimed' }), seen())).toMatchObject({ do: 'stick' })
  })
})
