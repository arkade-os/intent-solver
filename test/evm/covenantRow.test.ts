/**
 * Who holds which covenant role, checked against the pkScript the script derives.
 *
 * A swapped receiver is not a cosmetic error: the lockup gets funded at an
 * address the row cannot reconstruct, so it is neither claimable nor refundable.
 * Same class of silent failure as a wrong ERC20 lock field.
 */

import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { evmReceiveCovenantRowFor, evmSendCovenantRowFor } from '@arkade-os/solver-corridors-evm/evm/covenantRow.js'
import { covenantScriptFromRow } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import type { EvmSendSwapRow } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import type { EvmReceiveSwapRow } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'

const key = (fill: number): string => hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(fill)))
const p2tr = (fill: number): string => '5120' + hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(fill)))

const SOLVER = key(1)
const CLIENT = key(2)

const common = {
  id: 'swap-1',
  serverPubkey: key(3),
  paymentHash: 'aa'.repeat(32),
  refundLocktime: 1_800_090_000,
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  emulatorPubkey: key(4),
  refundPkScript: p2tr(5),
  pkScript: p2tr(6),
  clientRefundPubkey: key(7),
  receiverPkScript: p2tr(8),
}

const sendRow = { ...common, providerPubkey: SOLVER, payoutPubkey: CLIENT } as unknown as EvmSendSwapRow
const receiveRow = { ...common, providerPubkey: SOLVER, payoutPubkey: CLIENT } as unknown as EvmReceiveSwapRow

describe('the covenant receiver differs BETWEEN the two legs', () => {
  it('names the SOLVER on the send leg, because the solver claims', () => {
    expect(evmSendCovenantRowFor(sendRow).receiverPubkey).toBe(SOLVER)
  })

  it('names the CLIENT on the receive leg, because the client claims', () => {
    expect(evmReceiveCovenantRowFor(receiveRow).receiverPubkey).toBe(CLIENT)
  })

  it('derives DIFFERENT scripts for the two legs from otherwise identical rows', () => {
    // The assertion that matters: same everything except who claims, and the
    // resulting pkScript must differ. If it did not, the receiver would not be
    // part of the script and one party could spend the other's leg.
    const send = covenantScriptFromRow(evmSendCovenantRowFor(sendRow))
    const receive = covenantScriptFromRow(evmReceiveCovenantRowFor(receiveRow))
    expect(hex.encode(send.pkScript)).not.toBe(hex.encode(receive.pkScript))
  })

  it('builds a script at all, so the mapping satisfies the covenant contract', () => {
    // covenantScriptFromRow throws on a row missing the refund destination or
    // emulator key, so this failing would mean the mapping dropped a field.
    expect(() => covenantScriptFromRow(evmSendCovenantRowFor(sendRow))).not.toThrow()
    expect(() => covenantScriptFromRow(evmReceiveCovenantRowFor(receiveRow))).not.toThrow()
  })
})
