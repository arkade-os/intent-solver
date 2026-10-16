/** Replacing an L1 spend the mempool has not confirmed. Terms and reasoning: docs/deadlines.md. */

import type { OnchainBackend, OnchainTxOutcome } from '@arkade-os/solver-core/ports/onchain.js'

/** About two blocks, so an ordinary confirmation beats the replacement rather than racing it. */
export const FEE_BUMP_INTERVAL_SECONDS = 20 * 60

export const FEE_BUMP_FACTOR = 1.5

const MIN_RELAY_FEE_RATE = 1

export interface BroadcastVersion {
  feeRate: number
  broadcastAt: number
}

/** Asked before the fee estimate, so a waiting spend costs no backend call until a bump is due. */
export const bumpDue = (broadcastAt: number, now: number): boolean => now - broadcastAt >= FEE_BUMP_INTERVAL_SECONDS

/** Null while too early. The `+ MIN_RELAY_FEE_RATE` is BIP125 rule 4: the vsize never changes between versions. */
export const replacementFeeRate = (last: BroadcastVersion, estimate: number, now: number): number | null => {
  if (!bumpDue(last.broadcastAt, now)) return null
  return Math.max(estimate, last.feeRate * FEE_BUMP_FACTOR, last.feeRate + MIN_RELAY_FEE_RATE)
}

/** Capped to leave dust: a smaller payout confirms, a refusal never does. Null when even the cap cannot relay. */
export const affordableFee = (vsize: number, feeRate: number, valueSats: number, dustSats: number): number | null => {
  const cap = valueSats - dustSats
  if (cap < Math.ceil(vsize * MIN_RELAY_FEE_RATE)) return null
  return Math.min(Math.ceil(vsize * feeRate), cap)
}

/**
 * A verdict over every version broadcast, naming WHICH one it is about: the
 * caller records that txid, and recording the latest instead would name a
 * version that never reached the chain. `txid` is set only on `confirmed`,
 * where there is one answer; `mempool` can be true of several at once.
 */
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
