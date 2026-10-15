/**
 * Replacing an L1 spend the mempool has not confirmed.
 *
 * Both onchain corridors broadcast once at the fee rate of the moment and then
 * wait. A wait that outlasts the counterparty's timelock does not cost the
 * swap, it costs the money: on the receive leg the client's CLTV opens and they
 * take back an HTLC whose preimage is already public; on the send leg the
 * claim leaf never expires, so an unconfirmed refund leaves the client able to
 * claim as well. Fee-bumping is the only lever, and these are its terms.
 */

import type { OnchainBackend, OnchainTxOutcome } from '@arkade-os/solver-core/ports/onchain.js'

/** About two blocks: long enough that an ordinary confirmation beats the replacement to the chain. */
export const FEE_BUMP_INTERVAL_SECONDS = 20 * 60

export const FEE_BUMP_FACTOR = 1.5

/** The relay floor a replacement is still measured against, same figure the send corridor prices its payout floor with. */
const MIN_RELAY_FEE_RATE = 1

/** What the last version of this spend went out at. */
export interface BroadcastVersion {
  feeRate: number
  broadcastAt: number
}

/**
 * The rate a replacement must pay, or null while it is too early to send one.
 *
 * `last.feeRate + 1` is not belt-and-braces: BIP125 rule 4 wants the
 * replacement to beat the old fee by at least the incremental relay fee, and
 * the vsize is identical across versions, so a factor that rounds to the same
 * sat/vB at the bottom of the range would be relayed as a duplicate rather
 * than a replacement.
 */
export const replacementFeeRate = (last: BroadcastVersion, estimate: number, now: number): number | null => {
  if (now - last.broadcastAt < FEE_BUMP_INTERVAL_SECONDS) return null
  return Math.max(estimate, last.feeRate * FEE_BUMP_FACTOR, last.feeRate + MIN_RELAY_FEE_RATE)
}

/**
 * What this output can actually pay a miner: the asked rate, capped so the
 * spend still leaves a dust-sized output.
 *
 * Capping rather than refusing is the whole point. Both legs used to park a
 * spend whose fee ate past dust, which hands the counterparty an output the
 * solver has already paid for elsewhere — a smaller payout confirms, a refusal
 * never does. Null only when even the cap cannot buy relay, where no rate helps.
 */
export const affordableFee = (vsize: number, feeRate: number, valueSats: number, dustSats: number): number | null => {
  const cap = valueSats - dustSats
  if (cap < Math.ceil(vsize * MIN_RELAY_FEE_RATE)) return null
  return Math.min(Math.ceil(vsize * feeRate), cap)
}

/**
 * The outcome of a spend across every version of it broadcast so far — an
 * older one confirming is the ordinary end of a bump, not an anomaly.
 */
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
