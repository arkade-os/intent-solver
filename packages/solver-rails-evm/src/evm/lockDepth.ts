/**
 * How buried a lock is, proven against the contract rather than assumed.
 *
 * WHY THIS IS NOT `isLocked`. That reads `latest`, so it goes true the instant
 * one block carries the lock: it answers whether the lock EXISTS, never how
 * deep it is. An acceptance policy fed from it is satisfied at depth one
 * however many confirmations the operator configured — the whole of the reorg
 * protection gone while the setting still reads as enforced.
 *
 * WHY NOT A RECEIPT LOOKUP. Because the receive leg has no transaction to look
 * up. There the CLIENT builds the lock and the solver learns it exists by
 * reading the contract, which carries no transaction hash — `evm_lock_txid` is
 * never written on that leg. A receipt-based probe would report depth zero
 * forever and the corridor would never fund, which is a worse failure than the
 * bug it replaced.
 *
 * So the question is asked the other way round: WAS IT ALREADY THERE `N` BLOCKS
 * AGO. That is the same question as "is it `N` deep" and needs nothing the
 * solver has to be told.
 */

import type { EvmHtlcBackend } from './backend.js'
import type { Erc20SwapLock } from './erc20Swap.js'

/** What the planner's two acceptance gates compare against. */
export interface LockDepth {
  confirmations: number
  ageSeconds: number
}

/** The reads this needs — narrower than the whole backend, so a test supplies two functions. */
export type DepthReader = Pick<EvmHtlcBackend, 'isLockedAt' | 'blockTimestampAt'>

export interface DepthQuestion {
  /** `isLocked` at the tip. A lock that is gone now cannot be deep. */
  present: boolean
  height: number
  minConfirmations: number
  nowSeconds: number
}

/** Nothing proven: the planner's `>=` gates both fail on these. */
const UNPROVEN: LockDepth = { confirmations: 0, ageSeconds: 0 }

/**
 * Prove the lock is at least `minConfirmations` deep, and bound its age.
 *
 * Reports `minConfirmations` exactly rather than the true count, because the
 * planner's gate is `>=` and one historical read answers that without a search
 * for the block the lock first appeared in.
 *
 * BOTH `present` AND the historical read are required, and the pair covers a
 * case neither does alone: a lock created and then CLAIMED between the probe
 * block and now would still read as present at the probe, but `present` goes
 * false the moment the contract clears its flag on claim.
 *
 * A FAILED READ IS "NOT PROVEN", NOT "ABSENT". `isLockedAt` is an `eth_call` at
 * a historical height, so a node that has pruned that far cannot answer it —
 * and the configured depth is therefore implicitly bounded by the node's state
 * retention. Letting the error escape would fail the whole tick over a question
 * whose honest answer is "I cannot tell yet"; swallowing it silently would
 * stall the corridor with nothing to read. So it is reported and treated as
 * not-yet-deep, which is the safe direction: the swap waits rather than
 * advancing on a depth nobody established.
 */
export const provenDepth = async (
  evm: DepthReader,
  lock: Erc20SwapLock,
  question: DepthQuestion,
  onError?: (error: unknown) => void,
): Promise<LockDepth> => {
  const probe = question.height - question.minConfirmations + 1
  // Underflow guard: a chain younger than the configured depth cannot yet prove
  // anything, and `eth_call` at a negative height is not a question.
  if (!question.present || probe < 1) return UNPROVEN

  try {
    if (!(await evm.isLockedAt(lock, BigInt(probe)))) return UNPROVEN
    // The probe block's own timestamp, not a local clock: the age half of the
    // policy is about how long the CHAIN has built on this lock, not how long
    // ago this process noticed it. The lock was already there at that block, so
    // this bounds its age from below.
    const at = await evm.blockTimestampAt(BigInt(probe))
    return { confirmations: question.minConfirmations, ageSeconds: question.nowSeconds - at }
  } catch (error) {
    onError?.(error)
    return UNPROVEN
  }
}
