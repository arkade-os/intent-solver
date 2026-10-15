/**
 * Replacing an L1 spend the mempool has not confirmed — the lever both
 * onchain corridors were missing. Terms and reasoning: docs/deadlines.md.
 */

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

/**
 * The rate a replacement must pay, or null while it is too early for one.
 *
 * The `+ MIN_RELAY_FEE_RATE` term is BIP125 rule 4: vsize is identical across
 * versions, so a factor that rounds to the same sat/vB relays as a duplicate.
 */
export const replacementFeeRate = (last: BroadcastVersion, estimate: number, now: number): number | null => {
  if (!bumpDue(last.broadcastAt, now)) return null
  return Math.max(estimate, last.feeRate * FEE_BUMP_FACTOR, last.feeRate + MIN_RELAY_FEE_RATE)
}

/**
 * The asked rate, capped so the spend still leaves a dust-sized output: a
 * smaller payout confirms, where refusing to broadcast never does. Null only
 * where even the cap cannot buy relay, and no later rate helps.
 */
export const affordableFee = (vsize: number, feeRate: number, valueSats: number, dustSats: number): number | null => {
  const cap = valueSats - dustSats
  if (cap < Math.ceil(vsize * MIN_RELAY_FEE_RATE)) return null
  return Math.min(Math.ceil(vsize * feeRate), cap)
}

/** Across every version broadcast: an older one confirming is the ordinary end of a bump. */
export const outcomeOfAny = async (
  onchain: Pick<OnchainBackend, 'transactionOutcome'>,
  txids: readonly string[],
): Promise<OnchainTxOutcome> => {
  let seen: OnchainTxOutcome = 'unknown'
  for (const txid of txids) {
    const outcome = await onchain.transactionOutcome(txid)
    if (outcome === 'confirmed') return 'confirmed'
    if (outcome === 'mempool') seen = 'mempool'
  }
  return seen
}
