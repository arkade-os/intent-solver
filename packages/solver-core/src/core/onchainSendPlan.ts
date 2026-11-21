/**
 * What an `arkade:BTC->onchain:BTC` swap should do next. The orchestrator hands over the row and a way to
 * read the outside world; this decides; the orchestrator acts. Nothing here writes or sends.
 *
 * Reads are made in the order the rules need them, and only when a rule needs them.
 *
 * Covers the payout on Bitcoin. `claiming`, the claim of the client's Arkade lockup, keeps its rules in
 * the orchestrator until that leg is shared with the Lightning send corridor.
 */

import { hex } from '@scure/base'
import type { OnchainTxOutcome } from '../ports/onchain.js'
import { judgeClientLockup } from './clientLockup.js'
import {
  ARKADE_CLAIM_WINDOW_SECONDS,
  DEFAULT_ONCHAIN_LOCKUP_TIMEOUT,
  HTLC_REFUND_MTP_MARGIN,
  arkadeClaimTimeLeft,
  evaluateOnchainSendFunding,
  expiryBeforeClaimDeadline,
  lockupExpiryFloor,
} from './onchainSend.js'
import { paymentHashFromPreimage } from './preimage.js'

export const ONCHAIN_KEY_ROTATED = 'provider key rotated since quote; refusing to fund an unclaimable lockup'
export const ONCHAIN_FOREIGN_SPEND = 'onchain HTLC spent by something other than a matching claim'
/** An unconfirmed funding blocks every later spend and its fee is fixed, so past this a human is told. */
export const FUNDING_STUCK_ALERT_SECONDS = 20 * 60

export interface OnchainSendPlanRow {
  id: string
  state: string
  createdAt: number
  paymentHash: string
  amountSats: number
  payoutSats: number
  refundLocktime: number
  htlcLocktime: number
  minConfirmations: number
  onchainLockupValue: number | null
  fundingTxid: string | null
  fundingVout: number | null
  /** The signed funding, recorded before it is broadcast. */
  fundingTx: string | null
  fundStartedAt: number | null
  onchainRefundTxid: string | null
  onchainRefundPriorTxids: readonly string[]
}

export interface ClientLockup {
  /** Every output at the lockup script. */
  held: number
  /** The outputs a claim can spend: those not on an asset vtxo. */
  spendable: readonly { value: number; expiresAt?: number }[]
}

export interface OnchainSendReads {
  now(): number
  providerKeyCurrent(): boolean
  /** False on regtest, whose batches expire sooner than any claim deadline. */
  checksLockupExpiry(): boolean
  /** One claim spends at most this many outputs; the rest would stay for the client to refund. */
  maxLockupOutputs(): number
  lockups(): Promise<ClientLockup>
  approved(): Promise<boolean>
  lockupHeld(): Promise<number>
  /** Outputs at this swap's own HTLC address. */
  payoutOutputs(): Promise<readonly { txid: string; vout: number; valueSats: number }[]>
  /** The spend of our HTLC output, or null while it is unspent. */
  spend(): Promise<{ preimage: Uint8Array | null } | null>
  fundingOutcome(): Promise<OnchainTxOutcome>
  /** The best outcome among our own earlier refund attempts. */
  refundOutcome(): Promise<{ outcome: OnchainTxOutcome; txid: string | null }>
}

export type OnchainSendAction =
  | { do: 'wait'; alert?: string }
  | { do: 'adopt_lockup' }
  | { do: 'enter_funding' }
  | { do: 'record_funded' }
  | { do: 'publish_recorded' }
  | { do: 'adopt_funding'; txid: string; vout: number }
  | { do: 'submit_funding' }
  | { do: 'record_claim'; preimage: string; alert?: string }
  | { do: 'claim_lockup' }
  | { do: 'start_refund' }
  | { do: 'record_refund'; txid: string | null }
  | { do: 'bump_refund' }
  | { do: 'push_refund' }
  /** `lockupValue`, when given, is written first so the refund sweep returns all of it. */
  | { do: 'fail'; reason: string; lockupValue?: number }
  | { do: 'throw'; message: string }

const WAIT: OnchainSendAction = { do: 'wait' }
const fail = (reason: string): OnchainSendAction => ({ do: 'fail', reason })

export const planOnchainSend = (row: OnchainSendPlanRow, reads: OnchainSendReads): Promise<OnchainSendAction> => {
  switch (row.state) {
    case 'quoted':
      return whenQuoted(row, reads)
    case 'funded':
      return whenFunded(row, reads)
    case 'funding_onchain':
      return whenFundingOnchain(row, reads)
    case 'awaiting_claim':
      return whenAwaitingClaim(row, reads)
    case 'claiming':
      return Promise.resolve({ do: 'claim_lockup' })
    case 'refunding_onchain':
      return whenRefundingOnchain(row, reads)
    default:
      return Promise.resolve(WAIT)
  }
}

/** Why the payout must not be funded now, or null. Asked again at every step that could still fund. */
export const onchainFundingRefusal = (
  row: OnchainSendPlanRow,
  at: { providerKeyCurrent: boolean; nowSeconds: number },
): string | null => {
  if (!at.providerKeyCurrent) return ONCHAIN_KEY_ROTATED
  const decision = evaluateOnchainSendFunding({
    refundLocktime: row.refundLocktime,
    htlcLocktime: row.htlcLocktime,
    minConfirmations: row.minConfirmations,
    now: at.nowSeconds,
  })
  return decision.fund ? null : decision.reason
}

/** The client can unroll or spend the lockup while we wait, so it is weighed again right before money moves. */
export const lockupShortfall = (row: OnchainSendPlanRow, held: number): string | null => {
  const funded = row.onchainLockupValue ?? row.amountSats
  return held < funded ? `lockup holds ${held} of ${funded} sats at funding: unrolled, swept or spent` : null
}

const whenQuoted = async (row: OnchainSendPlanRow, reads: OnchainSendReads): Promise<OnchainSendAction> => {
  const lockup = await reads.lockups()
  const expiresTooSoon = reads.checksLockupExpiry()
    ? expiryBeforeClaimDeadline(lockup.spendable, row.htlcLocktime)
    : null
  return judgeClientLockup(lockup, {
    amountSats: row.amountSats,
    maxOutputs: reads.maxLockupOutputs(),
    tooLate: reads.now() >= row.createdAt + DEFAULT_ONCHAIN_LOCKUP_TIMEOUT,
    lateReason: (claimable) => (claimable > 0 ? `lockup timeout with partial ${claimable} sats` : 'lockup timeout'),
    refusal:
      expiresTooSoon === null
        ? null
        : `lockup expires at ${expiresTooSoon}, before ${lockupExpiryFloor(row.htlcLocktime)} — the last moment ` +
          'a claim answering this swap could still need it',
  })
}

const whenFunded = async (row: OnchainSendPlanRow, reads: OnchainSendReads): Promise<OnchainSendAction> => {
  // Before the approval: a held swap still reaches its deadline and is refused.
  const refusal = onchainFundingRefusal(row, {
    providerKeyCurrent: reads.providerKeyCurrent(),
    nowSeconds: reads.now(),
  })
  if (refusal) return fail(refusal)
  if (!(await reads.approved())) return WAIT
  const shortfall = lockupShortfall(row, await reads.lockupHeld())
  return shortfall ? fail(shortfall) : { do: 'enter_funding' }
}

const whenFundingOnchain = async (row: OnchainSendPlanRow, reads: OnchainSendReads): Promise<OnchainSendAction> => {
  // On the txid alone. A row with a txid and no vout is failed by `awaiting_claim` on the next tick.
  if (row.fundingTxid) return { do: 'record_funded' }
  // No txid on disk: the process died around the broadcast. A recorded funding is resent, never re-signed.
  if (row.fundingTx) return { do: 'publish_recorded' }
  // A row from before that column. A blind resubmit would be a second funding, so the chain is asked.
  // The address is this swap's own, and public: only an output of exactly the payout is ours. Adopting
  // any other would let a dust payment stop the funding and still let the client claim the dust.
  const ours = (await reads.payoutOutputs()).find((output) => output.valueSats === row.payoutSats)
  return ours ? { do: 'adopt_funding', txid: ours.txid, vout: ours.vout } : { do: 'submit_funding' }
}

const matchingPreimage = (row: OnchainSendPlanRow, spend: { preimage: Uint8Array | null }): string | null => {
  const { preimage } = spend
  return preimage && paymentHashFromPreimage(preimage) === row.paymentHash ? hex.encode(preimage) : null
}

const whenAwaitingClaim = async (row: OnchainSendPlanRow, reads: OnchainSendReads): Promise<OnchainSendAction> => {
  if (!row.fundingTxid || row.fundingVout === null) return fail('awaiting_claim state with no funding txid/vout')
  const spend = await reads.spend()
  if (spend === null) return waitForClaim(row, reads)

  // A spend that is not a matching claim is most likely our own refund. Either way a human looks.
  const preimage = matchingPreimage(row, spend)
  if (preimage === null) return fail(ONCHAIN_FOREIGN_SPEND)
  // TLA+ F7: after downtime the claim may be on chain with the deadline nearly spent. Claiming anyway is
  // the only recourse and collects in full if it lands, so the row moves on; someone is told of the squeeze.
  const timeLeft = arkadeClaimTimeLeft(row.refundLocktime, reads.now())
  if (timeLeft >= ARKADE_CLAIM_WINDOW_SECONDS) return { do: 'record_claim', preimage }
  return {
    do: 'record_claim',
    preimage,
    alert:
      `claim race: ${timeLeft}s left to claim the arkade lockup, under the ${ARKADE_CLAIM_WINDOW_SECONDS}s budget ` +
      `(refund_locktime ${row.refundLocktime}, htlc_locktime ${row.htlcLocktime}) — claiming anyway`,
  }
}

const waitForClaim = async (row: OnchainSendPlanRow, reads: OnchainSendReads): Promise<OnchainSendAction> => {
  if (reads.now() >= row.htlcLocktime + HTLC_REFUND_MTP_MARGIN) return { do: 'start_refund' }
  const { fundStartedAt } = row
  const fundingLooksStuck = fundStartedAt !== null && reads.now() - fundStartedAt >= FUNDING_STUCK_ALERT_SECONDS
  if (fundStartedAt === null || !fundingLooksStuck) return WAIT
  if ((await reads.fundingOutcome()) === 'confirmed') return WAIT
  // A confirm past refund_locktime pays both sides, and only a human can bump or CPFP it.
  return {
    do: 'wait',
    alert:
      `funding ${row.fundingTxid} unconfirmed ${reads.now() - fundStartedAt}s after broadcast — ` +
      `bump or CPFP before refund_locktime ${row.refundLocktime} (the client reclaims the Arkade lockup ` +
      `after it, so a later confirm pays both sides); htlc_locktime ${row.htlcLocktime}`,
  }
}

const whenRefundingOnchain = async (row: OnchainSendPlanRow, reads: OnchainSendReads): Promise<OnchainSendAction> => {
  if (!row.fundingTxid || row.fundingVout === null) return fail('refunding_onchain state with no funding txid/vout')

  // Our own earlier attempts first: a CONFIRMED refund of this output means no claim can exist, and
  // knowing them by name stops one that went out before a crash being read as a foreign spend below.
  const refundedBefore = row.onchainRefundTxid !== null || row.onchainRefundPriorTxids.length > 0
  if (refundedBefore) {
    const { outcome, txid } = await reads.refundOutcome()
    if (outcome === 'confirmed') return { do: 'record_refund', txid }
    // Until it confirms the claim leaf stays open.
    if (outcome === 'mempool') return { do: 'bump_refund' }
  }

  // A late claim is still valid. Refunding over it would retry a failing double spend for ever, never
  // learn the preimage, and lose the Arkade lockup as well as the payout.
  const spend = await reads.spend()
  if (spend === null) return { do: 'push_refund' }
  const preimage = matchingPreimage(row, spend)
  return preimage === null ? fail(ONCHAIN_FOREIGN_SPEND) : { do: 'record_claim', preimage }
}

/** What to do when this tick's refund could not be built or would not relay. */
export const planRefundNotSent = (
  row: OnchainSendPlanRow,
  nowSeconds: number,
  attempt: { reason: string; retry: boolean },
): OnchainSendAction =>
  // Giving up before refund_locktime would end both the late-claim check and the retry.
  attempt.retry && nowSeconds < row.refundLocktime ? { do: 'throw', message: attempt.reason } : fail(attempt.reason)
