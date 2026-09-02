/**
 * The operator's way out of `stuck` when the answer is "we DID pay".
 *
 * `stuck` is where a swap lands when the provider may have paid out and could
 * not finish on its own, and the sweep deliberately never revisits it — see
 * `findRefundable`, which considers only `refused`. The refund side of that
 * decision already has `refundNow`. This is the other side: the case where what
 * the human finds is a PREIMAGE, which is proof the payment settled and so
 * proof that refunding would be a double payout.
 *
 * It does not push anything. It records the preimage and puts the row back on
 * the ordinary claim path, so the money is moved by the same `whenClaiming`
 * that every other claim goes through — with its retries, its guards and its
 * accounting — rather than by a second implementation that would eventually
 * disagree with the first.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { NON_TERMINAL } from '@arkade-os/solver-corridors/db/swaps.js'
import { requireLn } from './rails.js'
import type { Services } from './services.js'

/** Where the row was left. `claiming` means the sweep will finish it. */
export type ClaimOutcome = { state: 'claiming' }

/** `sha256(P)` against the row's payment hash — the same check the orchestrator makes. */
export const preimageOpens = (preimageHex: string, paymentHashHex: string): boolean => {
  try {
    return hex.encode(sha256(hex.decode(preimageHex))) === paymentHashHex
  } catch {
    return false
  }
}

/**
 * Put ONE stuck Lightning-corridor swap back on the claim path.
 *
 * @param preimageHex the operator's own `P`, hex. Omitted, the backend is asked
 *   for the commitment it holds against this row's payment hash — which is
 *   where a payment that committed before its id was ever learned keeps it.
 *
 * Refuses unless the preimage hashes to the row's payment hash. That check is
 * the whole justification for the `stuck -> claiming` edge: possessing `P` for
 * this invoice proves the payee revealed it, and only a settled payment reveals.
 * Without it this would be a button that strands swaps in `claiming` with
 * nothing able to finish them.
 */
export const claimNow = async (services: Services, id: string, preimageHex?: string): Promise<ClaimOutcome> => {
  const row = await services.store.get(id)
  if (row.state !== 'stuck') {
    // Not an error about the operator's intent — about timing. A live row is
    // the sweep's to drive, and racing it here would fight the compare-and-swap
    // rather than cooperate with it.
    throw new Error(`swap ${id} is ${row.state}, not stuck; only a stuck row is recovered by hand`)
  }

  const preimage = preimageHex ?? (await requireLn(services.ln).getSendHtlcState?.(row.paymentHash))?.preimage
  if (!preimage) {
    throw new Error(
      `swap ${id} has no preimage: none was given and the backend holds none for ${row.paymentHash}. ` +
        'If the payment did not settle, the refund path is refund-now.',
    )
  }

  if (!preimageOpens(preimage, row.paymentHash)) {
    throw new Error(`preimage does not match the payment hash of swap ${id} (${row.paymentHash})`)
  }

  // The preimage hits disk in the same transition that changes state, exactly
  // as `claimWithPreimage` does it: from `claiming` on, the claim needs nothing
  // external, so a crash between here and the push still resolves.
  if (!(await services.store.transition(id, 'stuck', 'claiming', { preimage }))) {
    throw new Error(`swap ${id} moved out of stuck while being recovered; re-read it before trying again`)
  }
  return { state: 'claiming' }
}

/** Where the parked row landed. `fail` picks by whether the state was exposed. */
export type ParkOutcome = { state: 'stuck' | 'refused' }

/**
 * Stop driving ONE swap, and say why on the row.
 *
 * A row whose every tick throws is re-driven by the sweep forever, and nothing else an
 * operator can reach stops it: `refund-now` does not change state, `tick` drives it
 * again, and `stuck` is only reachable from inside the orchestrator.
 *
 * Deliberately NOT a repair — the "I have looked at this and it must stop" lever. The
 * reason is mandatory because a parked row with no explanation is a mystery for
 * whoever finds it next, including the operator who parked it.
 *
 * Terminal states are refused rather than re-parked: `fail` cannot transition out of
 * one, and answering "done" to an action that did nothing teaches an operator to
 * distrust the console.
 */
export const parkSwap = async (services: Services, id: string, reason: string): Promise<ParkOutcome> => {
  const trimmed = reason.trim()
  if (!trimmed) throw new Error('a reason is required: a parked row with no explanation is a mystery later')

  const row = await services.store.get(id)
  if (!NON_TERMINAL.includes(row.state)) {
    throw new Error(`swap ${id} is already ${row.state}; only a live swap can be parked`)
  }

  // `fail` routes by exposure: `paying`/`paid`/`claiming` land in `stuck` for a
  // human, everything else in `refused` because nothing of ours ever moved.
  await services.store.fail(id, row.state, trimmed)

  // Re-read and CHECK, because `fail` discards its compare-and-swap result. A
  // sweep that advanced the row between the read above and the write here
  // leaves the park a silent no-op, and reporting the state we happen to find
  // would tell an operator `PARKED -> paid` — nonsense at the exact moment they
  // are relying on it. Better to say the lever missed and let them re-read.
  const after = await services.store.get(id)
  if (after.state !== 'stuck' && after.state !== 'refused') {
    throw new Error(`swap ${id} moved to ${after.state} while being parked — the sweep raced us; re-read it and retry`)
  }
  return { state: after.state }
}
