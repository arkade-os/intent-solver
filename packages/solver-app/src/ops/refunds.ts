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
import { findLockups, findSweptLockups, refundSwapScript } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { refundSweptSwapScript } from '@arkade-os/solver-arkade/arkade/sweptRefund.js'
import { covenantScriptFromRow } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { EXPOSED } from '@arkade-os/solver-corridors/db/swaps.js'
import { paymentVerdict } from './paymentVerdict.js'
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
  // An exposed or claimed row may have paid the client already; the backend
  // verdict below must also prove a refund is safe for any other state.
  if (EXPOSED.includes(row.state) || row.state === 'claimed') {
    throw new Error(
      `swap ${id} is ${row.state}: the Lightning payout is in flight or done, so refunding the lockup now would pay the client twice — resolve the payment, do not refund`,
    )
  }
  // The row state is only the fast guard; the payment is the authority. @see paymentVerdict.ts
  const { verdict } = await paymentVerdict(services, row)
  if (verdict !== 'not-paid-refund-is-safe' && verdict !== 'never-submitted') {
    throw new Error(
      `swap ${id}: payment verdict is ${verdict}, so refunding the lockup now could pay the client twice — resolve the payment, do not refund`,
    )
  }
  const script = covenantScriptFromRow(row)
  const pkScript = hex.encode(script.pkScript)
  const claimRefund = async (found: readonly { value: number }[]) => {
    if (row.state === 'refused') return
    // Claim before spending so a funded tick cannot start paying after the verdict.
    const observed = found.reduce((total, output) => total + output.value, 0)
    // Persist the observed value so the deadline sweep can retry a failed send.
    if (
      !(await services.store.transition(row.id, row.state, 'refused', {
        lockup_value: Math.max(row.lockupValue ?? 0, observed),
      }))
    )
      throw new Error(`swap ${id} state changed while preparing refund; recheck before retry`)
  }
  const outputs = await findLockups(services.arkade, pkScript)
  // A SWEPT lockup is invisible to `findLockups` and unspendable offchain, so
  // it goes through a batch round. Unattended, the float pass does the same
  // off the recovery guard. @see arkade/sweptRefund.ts
  if (outputs.length === 0) {
    const swept = await findSweptLockups(services.arkade, pkScript)
    if (swept.length === 0) return { skipped: NOTHING_AT_SCRIPT }
    await services.store.noteFundings(row.id, swept)
    await claimRefund(swept)
    const txid = await refundSweptSwapScript(
      services.arkade,
      services.config.emulatorUrl,
      script,
      swept,
      hex.decode(row.refundPkScript),
    )
    await services.store.patch(row.id, { refund_outcome: 'pushed', refund_ark_txid: txid })
    return { txid }
  }

  // Record what is ACTUALLY at the script before spending it — the force-check a second
  // funding needs. A lockup can be funded more than once, the lifecycle has only one
  // `-> funded` transition, and nothing watches a terminal row, so a later deposit is
  // swept by the refund below and otherwise leaves no trace. `noteFundings` skips
  // outpoints already recorded, so re-running is free.
  await services.store.noteFundings(row.id, outputs)
  await claimRefund(outputs)

  const txid = await refundSwapScript(
    services.arkade,
    services.config.emulatorUrl,
    script,
    outputs,
    hex.decode(row.refundPkScript),
  )
  await services.store.patch(row.id, { refund_outcome: 'pushed', refund_ark_txid: txid })

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
    throw new Error(
      'the arkade:BTC->onchain:BTC service is not available; build Services with allCorridors, or wait for LND to answer',
    )
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
    throw new Error(
      'the arkade:BTC->onchain:BTC service is not available; build Services with allCorridors, or wait for LND to answer',
    )
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
