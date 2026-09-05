/**
 * The Arkade covenant behind each EVM corridor, rebuilt from its row.
 *
 * Both legs use the SAME `CovenantSwapScript` the Lightning and onchain corridors
 * use — there is nothing EVM-specific about the Bitcoin side of an EVM swap. What
 * differs is WHO holds which role, and it differs BETWEEN THE TWO LEGS:
 *
 * - SEND (`arkade:BTC->ethereum:<token>`): the client locks sats and the SOLVER
 *   claims them, so the covenant's receiver is the solver's key.
 * - RECEIVE (`ethereum:<token>->arkade:BTC`): the solver locks sats and the
 *   CLIENT claims them, so the receiver is the client's payout key.
 *
 * Get that backwards and the script derives a different pkScript, so the lockup
 * is funded at an address the row cannot reconstruct — the same class of failure
 * as a wrong ERC20 lock field, and just as silent. Two named functions rather
 * than one parameterised by direction, for the reason `lockFromRow.ts` gives.
 *
 * The field mapping mirrors `covenantRowFor` and `receiveCovenantRowFor` exactly,
 * so a change to the covenant's shape lands on all four corridors at once rather
 * than leaving the EVM pair behind.
 */

import type { CovenantScriptRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'
import type { EvmSendSwapRow } from '../db/evmSendSwaps.js'
import type { EvmReceiveSwapRow } from '../db/evmReceiveSwaps.js'
import type { AssetEvmSendSwapRow } from '../db/assetEvmSendSwaps.js'

/** Send leg: the SOLVER claims the client's lockup, so it is the receiver. */
export const evmSendCovenantRowFor = (row: EvmSendSwapRow): CovenantScriptRow => ({
  id: row.id,
  receiverPubkey: row.providerPubkey,
  serverPubkey: row.serverPubkey,
  paymentHash: row.paymentHash,
  refundLocktime: row.refundLocktime,
  claimDelay: row.claimDelay,
  emulatorPubkey: row.emulatorPubkey,
  refundPkScript: row.refundPkScript,
  pkScript: row.pkScript,
  clientRefundPubkey: row.clientRefundPubkey,
  refundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
  refundDelay: row.refundDelay,
  receiverPkScript: row.receiverPkScript,
  nonInteractiveParameters: row.nonInteractiveParameters,
})

/**
 * Asset send leg: the send leg's roles, plus the DENOMINATION.
 *
 * `assetId` is the only field that differs, and omitting it would rebuild the
 * BTC script for a lockup funded at the asset one. @see CovenantScriptRow.assetId.
 */
export const assetEvmSendCovenantRowFor = (row: AssetEvmSendSwapRow): CovenantScriptRow => ({
  id: row.id,
  receiverPubkey: row.providerPubkey,
  serverPubkey: row.serverPubkey,
  paymentHash: row.paymentHash,
  refundLocktime: row.refundLocktime,
  claimDelay: row.claimDelay,
  emulatorPubkey: row.emulatorPubkey,
  refundPkScript: row.refundPkScript,
  pkScript: row.pkScript,
  clientRefundPubkey: row.clientRefundPubkey,
  refundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
  refundDelay: row.refundDelay,
  receiverPkScript: row.receiverPkScript,
  assetId: row.assetId,
  nonInteractiveParameters: row.nonInteractiveParameters,
})

/** Receive leg: the CLIENT claims the solver's lockup, so the client is the receiver. */
export const evmReceiveCovenantRowFor = (row: EvmReceiveSwapRow): CovenantScriptRow => ({
  id: row.id,
  receiverPubkey: row.payoutPubkey,
  serverPubkey: row.serverPubkey,
  paymentHash: row.paymentHash,
  refundLocktime: row.refundLocktime,
  claimDelay: row.claimDelay,
  emulatorPubkey: row.emulatorPubkey,
  refundPkScript: row.refundPkScript,
  pkScript: row.pkScript,
  clientRefundPubkey: row.clientRefundPubkey,
  refundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
  refundDelay: row.refundDelay,
  receiverPkScript: row.receiverPkScript,
  nonInteractiveParameters: row.nonInteractiveParameters,
})
