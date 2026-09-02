/**
 * Which matured EVM locks to refund now, and which to leave for later.
 *
 * WHAT THIS IS FOR. On `evmReceive` the CLIENT funds the lock, so the client is
 * `refundAddress`. If the swap does not complete, the solver refunds its own
 * Arkade lockup at `refundLocktime` and is whole — but the client's tokens sit
 * in the contract until `evmTimeout`, and today only the client can move them.
 * A client who has lost the device, the key, or interest never comes back, and
 * the funds stay there forever. Nobody is harmed except them, which is exactly
 * why nobody has an incentive to fix it.
 *
 * `refund(bytes32,uint256,address,address,address,uint256)` is `public` and
 * pays `refundAddress` from the lock, so anyone may submit it once the timelock
 * matures. The submitter chooses nothing and gains nothing.
 *
 * WHY THIS NEEDS NO DAEMON, unlike the claim side. covclaimd exists as a
 * separate process with its own key because it holds a PREIMAGE the solver must
 * never see. A refund needs no secret — only `preimageHash` and the lock
 * parameters, both of which the solver already stores, because it needs them to
 * compute the swap key at all. So this is an ordinary sweep the solver runs,
 * and the trust argument simply does not arise.
 *
 * PLANNING ONLY. This returns calls; it does not sign or broadcast, matching
 * the seam `backend.ts` documents. The caller holds the key.
 */

import type { EvmCall, EvmHtlcBackend } from './backend.js'
import type { Erc20SwapLock } from './erc20Swap.js'
import { priceTransaction, type FeeQuote } from './fees.js'

/** A lock the solver believes may be refundable, with its own id for reporting. */
export interface RefundCandidate {
  /** The solver's swap id. Opaque here; it only travels back out for logging. */
  id: string
  lock: Erc20SwapLock
}

export interface RefundSweepInputs {
  /** `baseFeePerGas` of the latest block. */
  baseFeePerGas: bigint
  /** What the chain currently wants as a tip. */
  tipPerGas: bigint
  /**
   * The affordability ceiling, in wei — the operator's answer to "how much is
   * recovering someone else's funds worth to me?".
   *
   * Unlike a claim, exceeding this is not a risk to be accepted. See
   * {@link planRefundSweep}.
   */
  maxFeeCeilingPerGas: bigint
}

/** Why a candidate was not included this pass. All are re-tried next sweep. */
export type RefundDeferral =
  /** The timelock has not matured; the contract would revert `SwapNotTimedOut`. */
  | 'not_matured'
  /** Already claimed or refunded — the contract deletes the flag on both. */
  | 'already_settled'
  /** Gas is above the ceiling right now. A refund can always wait. */
  | 'gas_above_ceiling'

export interface RefundSweepPlan {
  send: readonly { id: string; call: EvmCall; fee: FeeQuote }[]
  deferred: readonly { id: string; reason: RefundDeferral }[]
}

/**
 * A refund is priced for NOW, not for a deadline — the one place this differs
 * from every other transaction the corridor sends.
 *
 * `fees.ts` sizes `maxFeePerGas` to survive a whole window of base-fee rises,
 * because a claim that becomes unincludable mid-window loses the swap. A refund
 * has no such window: the tokens are already the client's, the timelock has
 * passed, and nothing competes for them. If the transaction does not land, the
 * next sweep re-prices and sends it again.
 *
 * So one block of headroom, and no cushion. Buying insurance against a rise
 * that costs nothing to sit out would be paying for a risk that does not exist.
 */
const REFUND_BLOCKS_OF_HEADROOM = 1

/**
 * Decide the sweep.
 *
 * Reads the tip height ONCE and compares every candidate against it, so a pass
 * cannot report two locks as matured against different chain states — the sort
 * of skew that turns into a transaction sent against an assumption that has
 * already moved.
 *
 * BEING CAPPED MEANS DEFER, NOT PROCEED. `priceTransaction` reports
 * `cappedByPolicy` when the honest price exceeds the ceiling. On a claim that is
 * a warning to weigh against losing the swap. Here it is simply "not now": the
 * funds are safe where they are, so paying above the operator's ceiling to move
 * them is a pure loss with no risk avoided. Deferred candidates come back every
 * sweep, so the effect is to wait for cheaper gas rather than to abandon.
 *
 * A DEFERRAL REASON IS THE FIRST TRUE ONE, NOT THE ONLY ONE — and one pairing
 * matters to whoever wires this. `isLocked` runs last because it is the only
 * per-candidate RPC, so while gas is above the ceiling a candidate that has
 * ALREADY BEEN SETTLED on chain is reported `gas_above_ceiling` rather than
 * `already_settled`: nothing asked the contract, because nothing was going to
 * act on the answer either way. The plan is still right — it sends nothing —
 * and the reason corrects itself on the first pass where gas fits.
 *
 * So a caller must not age a candidate out of its list on the REASON alone. A
 * settled lock can wear `gas_above_ceiling` for as long as a gas spike lasts,
 * and dropping it on that basis would drop a live one beside it. Age out on
 * chain state, or on `send` having succeeded, never on why a pass declined.
 *
 * The alternative — asking `isLocked` before pricing — buys a truer log line
 * for one RPC per matured candidate per pass, paid exactly when gas is high and
 * the answer changes nothing. Not worth it while no caller reads the reason;
 * revisit if one starts to.
 */
export const planRefundSweep = async (
  candidates: readonly RefundCandidate[],
  backend: EvmHtlcBackend,
  inputs: RefundSweepInputs,
): Promise<RefundSweepPlan> => {
  const send: { id: string; call: EvmCall; fee: FeeQuote }[] = []
  const deferred: { id: string; reason: RefundDeferral }[] = []
  if (candidates.length === 0) return { send, deferred }

  const priced = priceTransaction({
    baseFeePerGas: inputs.baseFeePerGas,
    tipPerGas: inputs.tipPerGas,
    blocksOfHeadroom: REFUND_BLOCKS_OF_HEADROOM,
    maxFeeCeilingPerGas: inputs.maxFeeCeilingPerGas,
  })

  const tip = await backend.currentBlock()

  for (const candidate of candidates) {
    if (tip < candidate.lock.timelock) {
      deferred.push({ id: candidate.id, reason: 'not_matured' })
      continue
    }
    // Priced once, but checked per candidate so the reason is reported against
    // each id rather than the whole pass silently producing nothing.
    if (priced.cappedByPolicy) {
      deferred.push({ id: candidate.id, reason: 'gas_above_ceiling' })
      continue
    }
    // Last, because it is the only check that costs an RPC round trip — a lock
    // that is not yet matured never needs one.
    if (!(await backend.isLocked(candidate.lock))) {
      deferred.push({ id: candidate.id, reason: 'already_settled' })
      continue
    }
    send.push({
      id: candidate.id,
      call: backend.refundForCall(candidate.lock),
      fee: { maxFeePerGas: priced.maxFeePerGas, maxPriorityFeePerGas: priced.maxPriorityFeePerGas },
    })
  }

  return { send, deferred }
}
