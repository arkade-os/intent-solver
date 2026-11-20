import type { ReceiveSwapRow } from '../db/receiveSwaps.js'
import type { CovenantScriptRow } from '../send/orchestrator.js'

/**
 * Maps this leg's row onto the shape `covenantScriptFromRow`
 * (`src/send/arkadeOps.ts`) needs — the receive-leg counterpart of
 * `src/send/onchainOrchestrator.ts`'s `covenantRowFor`.
 *
 * A ROLE INVERSION, not a rename: on this leg the CLIENT ultimately claims (they
 * generated `P`), so they play the covenant's `receiver`; the PROVIDER funds the
 * lockup and needs the "needs nobody" refund, so it plays `client`. The three delay
 * fields are NOT part of the inversion — they are operator-derived
 * (`deriveUnilateralDelays`) and mean the same thing whoever holds which key.
 *
 * Also consumed by `arkade/vtxoLifecycle.ts`'s `liveLockupRows`, aliased there against
 * the other receive corridor's same-named function.
 */
export const receiveCovenantRowFor = (row: ReceiveSwapRow): CovenantScriptRow => ({
  id: row.id,
  receiverPubkey: row.payoutPubkey,
  serverPubkey: row.serverPubkey,
  paymentHash: row.paymentHash,
  refundLocktime: row.refundLocktime,
  claimDelay: row.claimDelay,
  emulatorPubkey: row.emulatorPubkey,
  refundPkScript: row.solverRefundPkScript,
  pkScript: row.pkScript,
  clientRefundPubkey: row.solverPubkey,
  refundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
  refundDelay: row.refundDelay,
  receiverPkScript: row.payoutPkScript,
  nonInteractiveParameters: row.nonInteractiveParameters,
})
