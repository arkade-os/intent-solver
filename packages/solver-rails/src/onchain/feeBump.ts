/** Replacing an L1 spend the mempool has not confirmed. Terms and reasoning: docs/deadlines.md. */

import type { OnchainBackend, OnchainTxOutcome } from '@arkade-os/solver-core/ports/onchain.js'

/** About two blocks, so an ordinary confirmation beats the replacement rather than racing it. */
export const FEE_BUMP_INTERVAL_SECONDS = 20 * 60

/** From here to the deadline, pay everything above dust: missing it costs the whole HTLC. Two intervals, so one all-in version always lands inside it. */
export const FEE_BUMP_ALL_IN_SECONDS = 2 * FEE_BUMP_INTERVAL_SECONDS

/** Further out than this, a version only keeps up with the estimate: a spend that is merely waiting has time to. */
export const FEE_BUMP_RAMP_SECONDS = 6 * FEE_BUMP_INTERVAL_SECONDS

const MIN_RELAY_FEE_RATE = 1

/** Asked before the fee estimate, so a waiting spend costs no backend call until a bump is due. */
export const bumpDue = (broadcastAt: number, now: number): boolean => now - broadcastAt >= FEE_BUMP_INTERVAL_SECONDS

/** What the time left calls for: the estimate far out, `capRate` at the deadline, geometric between. */
export const urgencyFeeRate = (estimateRate: number, capRate: number, deadline: number, now: number): number => {
  const estimate = Math.max(estimateRate, MIN_RELAY_FEE_RATE)
  const left = deadline - now
  if (capRate <= estimate || left <= FEE_BUMP_ALL_IN_SECONDS) return capRate
  if (left >= FEE_BUMP_RAMP_SECONDS) return estimate
  const progress = (FEE_BUMP_RAMP_SECONDS - left) / (FEE_BUMP_RAMP_SECONDS - FEE_BUMP_ALL_IN_SECONDS)
  return estimate * (capRate / estimate) ** progress
}

/** Capped to leave dust: a smaller payout confirms, a refusal never does. Null when even the cap cannot relay. */
export const affordableFee = (vsize: number, feeRate: number, valueSats: number, dustSats: number): number | null => {
  const cap = valueSats - dustSats
  if (cap < Math.ceil(vsize * MIN_RELAY_FEE_RATE)) return null
  return Math.min(Math.ceil(vsize * feeRate), cap)
}

/** `txid` only on `confirmed`: the caller records it, and `mempool` can be true of several at once. */
export type TrackedOutcome = { outcome: 'confirmed'; txid: string } | { outcome: 'mempool' | 'unknown'; txid: null }

/** Across every version broadcast: an older one confirming is the ordinary end of a bump. */
export const outcomeOfAny = async (
  onchain: Pick<OnchainBackend, 'transactionOutcome'>,
  txids: readonly string[],
): Promise<TrackedOutcome> => {
  let seen: OnchainTxOutcome = 'unknown'
  for (const txid of txids) {
    const outcome = await onchain.transactionOutcome(txid)
    if (outcome === 'confirmed') return { outcome, txid }
    if (outcome === 'mempool') seen = 'mempool'
  }
  return { outcome: seen === 'mempool' ? 'mempool' : 'unknown', txid: null }
}
