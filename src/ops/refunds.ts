/**
 * Operator refunds — the manual overrides.
 *
 * They live here so the admin console and the CLI drive the SAME code: two
 * implementations of a refund that must agree is the defect this module prevents.
 *
 * Every function takes an already-built {@link Services} and RETURNS its outcome
 * rather than logging it. `skipped` is a value rather than an error — "nothing at the
 * script" means already spent or never funded, a normal answer to a question an
 * operator asked.
 *
 * None of these are safe to fire without thinking; see each one.
 */

import { hex } from '@scure/base'
import { findLockups, refundSwapScript } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { covenantScriptFromRow } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import type { Services } from './services.js'

/** A pushed refund, or the reason nothing was pushed. */
export type RefundOutcome = { txid: string } | { skipped: string }

/** Nothing at the covenant script: already spent, or never funded. */
export const NOTHING_AT_SCRIPT = 'nothing-at-script'

/**
 * Push the covenant refund for ONE Lightning-corridor swap now, bypassing
 * `refundSweep`'s deadline gate.
 *
 * That gate excludes any swap that was ever exposed, because a backend's "failed"
 * verdict is trusted there and a false negative would mean paying out over Lightning
 * AND refunding the same lockup. This is the human's next step once they have read a
 * `stuck` row and decided a refund is warranted; the non-interactive refund leaf needs
 * no timelock, so there is nothing left to wait for.
 */
export const refundNow = async (services: Services, id: string): Promise<RefundOutcome> => {
  const row = await services.store.get(id)
  if (!row.refundPkScript || !row.emulatorPubkey) {
    throw new Error(`swap ${id} is not a covenant swap: missing refund destination or emulator key`)
  }
  const script = covenantScriptFromRow(row)
  const outputs = await findLockups(services.arkade, hex.encode(script.pkScript))
  if (outputs.length === 0) return { skipped: NOTHING_AT_SCRIPT }

  // Record what is ACTUALLY at the script before spending it — the force-check a second
  // funding needs. A lockup can be funded more than once, the lifecycle has only one
  // `-> funded` transition, and nothing watches a terminal row, so a later deposit is
  // swept by the refund below and otherwise leaves no trace. `noteFundings` skips
  // outpoints already recorded, so re-running is free.
  await services.store.noteFundings(row.id, outputs)

  const txid = await refundSwapScript(
    services.arkade,
    services.config.emulatorUrl,
    script,
    outputs,
    hex.decode(row.refundPkScript),
  )
  // Recorded BEFORE the row is closed. If the process dies between the two, the order
  // that survives must be the one with the txid on disk: a closed row with no recorded
  // refund is evidence nobody can reconstruct.
  await services.store.patch(row.id, { refund_outcome: 'pushed', refund_ark_txid: txid })

  // A refunded `stuck` row is finished, so take it out of the queue that state means.
  // Only from `stuck` — this also runs against `refused` rows and from the sweep, where
  // a blind transition would turn a successful refund into a reported failure.
  // Compare-and-swap, so a row that moved in flight is left as it is. Nothing is closed
  // on the `nothing-at-script` path, where no refund happened.
  if (row.state === 'stuck') await services.store.transition(row.id, 'stuck', 'refused')

  return { txid }
}

/**
 * {@link refundNow} for the onchain corridor, and the only path out of `stuck` there.
 * See `OnchainSendSwapService.refundNow` for why refunding a `stuck` row is correct in
 * some cases and A DOUBLE-PAYOUT IN OTHERS — a judgement call, not a button, so every
 * caller must put real friction in front of it.
 *
 * REFUNDS THE ARKADE LOCKUP, TO THE CLIENT. The `onchain` prefix names which STORE the
 * row lives in, not which leg is refunded; the solver's own L1 HTLC is
 * {@link reclaimL1Htlc}.
 *
 * Requires `onchainService`, so the caller must have built Services with
 * `allCorridors` if that corridor is disabled — this exists to unwind rows, including
 * a switched-off corridor's.
 */
export const onchainRefundNow = async (services: Services, id: string): Promise<RefundOutcome> => {
  if (!services.onchainService) {
    throw new Error('the arkade:BTC->onchain:BTC service is not available; build Services with allCorridors')
  }
  // Read first so the caller can report what it acted on.
  await services.onchainStore.get(id)
  const txid = await services.onchainService.refundNow(id)
  if (!txid) return { skipped: NOTHING_AT_SCRIPT }
  return { txid }
}

/**
 * The OTHER leg: {@link onchainRefundNow} gives the CLIENT their Arkade lockup back,
 * this reclaims the SOLVER's own L1 sats out of the HTLC it funded.
 *
 * Reach for it when a row is `stuck` with a `funding_txid`, meaning the L1 HTLC was
 * broadcast and the automatic refund gave up with no edge out of `stuck`.
 *
 * Safe to repeat, and against an already-spent output: both legs spend the SAME output,
 * so a redundant refund is a double-spend the network rejects rather than a second
 * payout — which is why this one is not a judgement call and
 * {@link onchainRefundNow} is.
 */
export const reclaimL1Htlc = async (services: Services, id: string): Promise<{ txid: string }> => {
  if (!services.onchainService) {
    throw new Error('the arkade:BTC->onchain:BTC service is not available; build Services with allCorridors')
  }
  await services.onchainStore.get(id)
  const txid = await services.onchainService.reclaimOnchainHtlc(id)
  return { txid }
}

/**
 * {@link refundNow} for the LIGHTNING RECEIVE leg — the solver's own Arkade lockup,
 * back to the solver.
 *
 * The direction is the thing to keep straight across this file: the two SEND corridors
 * give the CLIENT their lockup back and can therefore pay twice, while on the receive
 * corridors the solver funded out of its own float, so this recovers the solver's sats.
 *
 * A different caveat applies instead: refunding while the client can still claim spends
 * the output from under them and fails their held payment back. Nobody loses money —
 * both spend the SAME output — but a live swap dies. Read the row first.
 */
export const receiveRefundNow = async (services: Services, id: string): Promise<RefundOutcome> => {
  if (!services.receiveService) {
    throw new Error('the lightning:BTC->arkade:BTC service is not available; build Services with allCorridors')
  }
  // Read first so the caller reports what it acted on.
  await services.receiveStore.get(id)
  const txid = await services.receiveService.refundNow(id)
  if (!txid) return { skipped: NOTHING_AT_SCRIPT }
  return { txid }
}

/** {@link receiveRefundNow} for the onchain receive leg. Same money, same direction. */
export const onchainReceiveRefundNow = async (services: Services, id: string): Promise<RefundOutcome> => {
  if (!services.onchainReceiveService) {
    throw new Error('the onchain:BTC->arkade:BTC service is not available; build Services with allCorridors')
  }
  await services.onchainReceiveStore.get(id)
  const txid = await services.onchainReceiveService.refundNow(id)
  if (!txid) return { skipped: NOTHING_AT_SCRIPT }
  return { txid }
}

/**
 * NOT a refund — the onchain receive leg's fee-dust retry (TLA+ F4, #38). It lives here
 * because this is where the operator overrides live.
 *
 * A row at `claimed` has already paid the client out; if the fee then made the L1 claim
 * uneconomic, the solver is out the payout and holding a `stuck` row it cannot collect
 * on. The fee rate is the one lever, and this is it. `refused` is a normal outcome
 * carrying both numbers, so an operator knows to come back later.
 *
 * Distinct from {@link onchainReceiveRefundNow} in direction as well as leg: that
 * recovers the solver's Arkade lockup, which on a `claimed` row is already gone.
 */
export const onchainReceiveClaimNow = async (
  services: Services,
  id: string,
): Promise<{ txid: string } | { refused: string }> => {
  if (!services.onchainReceiveService) {
    throw new Error('the onchain:BTC->arkade:BTC service is not available; build Services with allCorridors')
  }
  await services.onchainReceiveStore.get(id)
  return services.onchainReceiveService.claimNow(id)
}
