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
import {
  assetEvmSendCovenantRowFor,
  evmReceiveCovenantRowFor,
  evmSendCovenantRowFor,
} from '@arkade-os/solver-corridors-evm/evm/covenantRow.js'
import { covenantScriptFromRow } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import type { EvmSendSwapRow } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import type { EvmReceiveSwapRow } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'
import type { AssetEvmSendSwapRow } from '@arkade-os/solver-corridors-evm/db/assetEvmSendSwaps.js'

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

describe('the asset send leg carries a DENOMINATION as well as the roles', () => {
  const ASSET = '11'.repeat(32) + '0000'
  const assetRow = { ...common, providerPubkey: SOLVER, assetId: ASSET } as unknown as AssetEvmSendSwapRow

  it('keeps the solver as receiver, since the solver still claims', () => {
    expect(assetEvmSendCovenantRowFor(assetRow).receiverPubkey).toBe(SOLVER)
    expect(assetEvmSendCovenantRowFor(assetRow).assetId).toBe(ASSET)
  })

  it('derives a DIFFERENT pkScript from the same row without the asset', () => {
    // The whole point of carrying the id: the asset is a parameter of the
    // script, so a rebuild that omitted it lands on the BTC address instead —
    // and `assertScriptMatchesRow` then refuses every claim and every refund of
    // a lockup only the original script could ever spend.
    const asset = covenantScriptFromRow(assetEvmSendCovenantRowFor(assetRow))
    const sats = covenantScriptFromRow(evmSendCovenantRowFor(sendRow))
    expect(hex.encode(asset.pkScript)).not.toBe(hex.encode(sats.pkScript))
  })

  it('moves the pkScript with the id, so two assets are two lockups', () => {
    const other = { ...assetRow, assetId: '22'.repeat(32) + '0000' } as AssetEvmSendSwapRow
    const first = covenantScriptFromRow(assetEvmSendCovenantRowFor(assetRow))
    const second = covenantScriptFromRow(assetEvmSendCovenantRowFor(other))
    expect(hex.encode(first.pkScript)).not.toBe(hex.encode(second.pkScript))
  })

  it('names an EMPTY id rather than reading it as a sats row', () => {
    // The dangerous direction: an empty id read as absent builds the BTC script
    // and derives an address the lockup was never funded at. Unreachable while
    // the column is NOT NULL and the market ids are validated, but this shape is
    // shared with every corridor and the failure is silent.
    const broken = { ...assetRow, assetId: '' } as AssetEvmSendSwapRow
    expect(() => covenantScriptFromRow(assetEvmSendCovenantRowFor(broken))).toThrow(/68 lowercase hex/)
  })
})
