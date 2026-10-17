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
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { covenantRowFor } from '@arkade-os/solver-corridors/lnasset/sendOrchestrator.js'
import { covenantScriptFromRow } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import type { LnAssetSendSwapRow } from '@arkade-os/solver-corridors/db/lnAssetSendSwaps.js'

const key = (fill: number): string => hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(fill)))
const p2tr = (fill: number): string => '5120' + hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(fill)))

const CLIENT_REFUND = p2tr(5)
const SOLVER_RECEIVER = p2tr(8)

const row = (over: Partial<LnAssetSendSwapRow> = {}): LnAssetSendSwapRow =>
  ({
    id: 's1',
    solverPubkey: key(1),
    serverPubkey: key(3),
    paymentHash: 'ff'.repeat(32),
    refundLocktime: 1_800_000_000,
    claimDelay: 512,
    refundDelay: 1024,
    refundWithoutReceiverDelay: 2048,
    emulatorPubkey: key(4),
    refundPkScript: CLIENT_REFUND,
    solverReceiverPkScript: SOLVER_RECEIVER,
    pkScript: p2tr(6),
    clientRefundPubkey: key(7),
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
    const mapped = covenantRowFor(row({ solverReceiverPkScript: p2tr(9) }))
    expect(mapped.receiverPkScript).toBe(p2tr(9))
    expect(mapped.refundPkScript).toBe(CLIENT_REFUND)
  })
})

describe('an EMPTY asset id is a broken row, not a sats one', () => {
  it('builds the asset covenant from an otherwise identical row', () => {
    expect(() => covenantScriptFromRow(covenantRowFor(row()))).not.toThrow()
  })

  it('names the empty id rather than silently deriving the sats pkScript', () => {
    expect(() => covenantScriptFromRow(covenantRowFor(row({ assetId: '' })))).toThrow(/68 lowercase hex/)
  })
})
