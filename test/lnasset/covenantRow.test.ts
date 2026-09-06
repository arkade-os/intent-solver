/**
 * The row-to-covenant mapping on the asset send leg.
 *
 * Every field here is a term the lockup's script COMMITS to, so a wrong one
 * derives a different address than the client funded. That failure is silent
 * until the claim: the solver has already paid the invoice, and the asset it is
 * owed sits at a script it cannot open. The row goes `stuck` and the sats are
 * gone.
 */

import { describe, it, expect } from 'vitest'
import { covenantRowFor } from '@arkade-os/solver-corridors/lnasset/sendOrchestrator.js'
import type { LnAssetSendSwapRow } from '@arkade-os/solver-corridors/db/lnAssetSendSwaps.js'

const CLIENT_REFUND = '51' + 'aa'.repeat(33)
const SOLVER_RECEIVER = '51' + 'bb'.repeat(33)

const row = (over: Partial<LnAssetSendSwapRow> = {}): LnAssetSendSwapRow =>
  ({
    id: 's1',
    solverPubkey: 'dd'.repeat(32),
    serverPubkey: 'ee'.repeat(32),
    paymentHash: 'ff'.repeat(32),
    refundLocktime: 1_800_000_000,
    claimDelay: 512,
    refundDelay: 1024,
    refundWithoutReceiverDelay: 2048,
    emulatorPubkey: 'cc'.repeat(32),
    refundPkScript: CLIENT_REFUND,
    solverReceiverPkScript: SOLVER_RECEIVER,
    pkScript: '51' + '11'.repeat(33),
    clientRefundPubkey: 'ab'.repeat(32),
    assetId: '11'.repeat(34),
    ...over,
  }) as LnAssetSendSwapRow

describe('covenantRowFor', () => {
  it('names the SOLVER as the covenant receiver, never the client refund script', () => {
    // The one that cost money: mapping `refundPkScript` into `receiverPkScript`
    // rebuilds a covenant paying the client, so the claim derives a script the
    // deposit never landed at — after the invoice is already paid.
    const mapped = covenantRowFor(row())
    expect(mapped.receiverPkScript).toBe(SOLVER_RECEIVER)
    expect(mapped.receiverPkScript).not.toBe(CLIENT_REFUND)
  })

  it('keeps the client refund script on the refund leg', () => {
    expect(covenantRowFor(row()).refundPkScript).toBe(CLIENT_REFUND)
  })

  it('carries the asset id, which is what makes this an asset covenant', () => {
    expect(covenantRowFor(row()).assetId).toBe('11'.repeat(34))
  })

  it('takes the two scripts from different columns, so one cannot stand for both', () => {
    const mapped = covenantRowFor(row({ solverReceiverPkScript: '51' + '99'.repeat(33) }))
    expect(mapped.receiverPkScript).toBe('51' + '99'.repeat(33))
    expect(mapped.refundPkScript).toBe(CLIENT_REFUND)
  })
})
