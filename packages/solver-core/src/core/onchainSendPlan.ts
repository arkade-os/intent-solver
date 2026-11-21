/**
 * What an `arkade:BTC->onchain:BTC` swap should do next. Pure: the orchestrator reads, this decides,
 * the orchestrator acts. Same shape as `receivePlan.ts`: the planner asks for one fact at a time
 * (`{ do: 'read' }`), so the order of the rules is the order of the reads.
 *
 * Covers the payout on Bitcoin. `claiming`, the claim of the client's Arkade lockup, keeps its rules in
 * the orchestrator until that leg is shared with the Lightning send corridor.
 */

import { hex } from '@scure/base'
import type { OnchainTxOutcome } from '../ports/onchain.js'
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

export type OnchainSendRead =
  'lockups' | 'approval' | 'lockup_held' | 'payout_outputs' | 'spend_witness' | 'funding_outcome' | 'refund_outcome'

/** What has been read so far this tick. A field that is `undefined` has not been read. */
export interface OnchainSendObservation {
  /** Taken again before every call. */
  nowSeconds: number
  providerKeyCurrent: boolean
  /** False on regtest, whose batches expire sooner than any claim deadline. */
  checksLockupExpiry: boolean
  /** One claim spends at most this many outputs; the rest would stay for the client to refund. */
  maxLockupOutputs: number
  /** `held` counts every output; `spendable` leaves out those on an asset vtxo, which a claim cannot spend. */
  lockups?: { held: number; spendable: readonly { value: number; expiresAt?: number }[] }
  approved?: boolean
  lockupHeld?: number
  /** Outputs at this swap's own HTLC address. */
  payoutOutputs?: readonly { txid: string; vout: number; valueSats: number }[]
  /** The spend of our HTLC output, or null while it is unspent. */
  spend?: { preimage: Uint8Array | null } | null
  fundingOutcome?: OnchainTxOutcome
  /** The best outcome among our own earlier refund attempts. */
  refundOutcome?: { outcome: OnchainTxOutcome; txid: string | null }
  /** This tick's refund could not be built or would not relay. */
  refundNotSent?: { reason: string; retry: boolean }
}

export type OnchainSendAction =
  | { do: 'read'; what: OnchainSendRead }
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
const read = (what: OnchainSendRead): OnchainSendAction => ({ do: 'read', what })
const fail = (reason: string): OnchainSendAction => ({ do: 'fail', reason })

export const planOnchainSend = (row: OnchainSendPlanRow, seen: OnchainSendObservation): OnchainSendAction => {
  switch (row.state) {
    case 'quoted':
      return whenQuoted(row, seen)
    case 'funded':
      return whenFunded(row, seen)
    case 'funding_onchain':
      return whenFundingOnchain(row, seen)
    case 'awaiting_claim':
      return whenAwaitingClaim(row, seen)
    case 'claiming':
      return { do: 'claim_lockup' }
    case 'refunding_onchain':
      return whenRefundingOnchain(row, seen)
    default:
      return WAIT
  }
}

/** Why the payout must not be funded now, or null. Asked again at every step that could still fund. */
export const onchainFundingRefusal = (
  row: OnchainSendPlanRow,
  seen: Pick<OnchainSendObservation, 'providerKeyCurrent' | 'nowSeconds'>,
): string | null => {
  if (!seen.providerKeyCurrent) return ONCHAIN_KEY_ROTATED
  const decision = evaluateOnchainSendFunding({
    refundLocktime: row.refundLocktime,
    htlcLocktime: row.htlcLocktime,
    minConfirmations: row.minConfirmations,
    now: seen.nowSeconds,
  })
  return decision.fund ? null : decision.reason
}

/** The client can unroll or spend the lockup while we wait, so it is weighed again right before money moves. */
export const lockupShortfall = (row: OnchainSendPlanRow, held: number): string | null => {
  const funded = row.onchainLockupValue ?? row.amountSats
  return held < funded ? `lockup holds ${held} of ${funded} sats at funding: unrolled, swept or spent` : null
}

const whenQuoted = (row: OnchainSendPlanRow, seen: OnchainSendObservation): OnchainSendAction => {
  if (seen.lockups === undefined) return read('lockups')
  const { held, spendable } = seen.lockups
  const locked = spendable.reduce((sum, o) => sum + o.value, 0)
  const timedOut = seen.nowSeconds >= row.createdAt + DEFAULT_ONCHAIN_LOCKUP_TIMEOUT

  if (locked > row.amountSats) {
    return { do: 'fail', reason: `overfunded lockup: ${locked} > ${row.amountSats} sats`, lockupValue: held }
  }
  if (locked === row.amountSats && spendable.length > seen.maxLockupOutputs) {
    return fail(`lockup funded in ${spendable.length} outputs, over ${seen.maxLockupOutputs}`)
  }
  // Refused at once rather than at the timeout: the refund sweep returns the whole lockup either way.
  if (locked < row.amountSats && held >= row.amountSats) {
    return {
      do: 'fail',
      reason: `lockup funded on an asset vtxo a claim cannot spend: ${held} held, ${locked} spendable`,
      lockupValue: held,
    }
  }
  if (locked === row.amountSats && !timedOut) {
    const expiresTooSoon = seen.checksLockupExpiry ? expiryBeforeClaimDeadline(spendable, row.htlcLocktime) : null
    if (expiresTooSoon !== null) {
      return fail(
        `lockup expires at ${expiresTooSoon}, before ${lockupExpiryFloor(row.htlcLocktime)} — the last moment ` +
          'a claim answering this swap could still need it',
      )
    }
    return { do: 'adopt_lockup' }
  }
  if (timedOut) {
    const reason = locked > 0 ? `lockup timeout with partial ${locked} sats` : 'lockup timeout'
    return held > 0 ? { do: 'fail', reason, lockupValue: held } : fail(reason)
  }
  return WAIT
}

const whenFunded = (row: OnchainSendPlanRow, seen: OnchainSendObservation): OnchainSendAction => {
  // The gates come before the approval, and only then: a held swap still reaches its deadline and refuses,
  // and a slow approval does not get the gates asked a second time on this tick.
  if (seen.approved === undefined) {
    const refusal = onchainFundingRefusal(row, seen)
    return refusal ? fail(refusal) : read('approval')
  }
  if (!seen.approved) return WAIT
  if (seen.lockupHeld === undefined) return read('lockup_held')
  const shortfall = lockupShortfall(row, seen.lockupHeld)
  return shortfall ? fail(shortfall) : { do: 'enter_funding' }
}

const whenFundingOnchain = (row: OnchainSendPlanRow, seen: OnchainSendObservation): OnchainSendAction => {
  // On the txid alone, as before. A row with a txid and no vout is failed by `awaiting_claim` on the next tick.
  if (row.fundingTxid) return { do: 'record_funded' }
  // No txid on disk: the process died around the broadcast. A recorded funding is resent, never re-signed.
  if (row.fundingTx) return { do: 'publish_recorded' }
  // A row from before that column. A blind resubmit would be a second funding, so the chain is asked.
  // The address is this swap's own, and public: only an output of exactly the payout is ours. Adopting
  // any other would let a dust payment stop the funding and still let the client claim the dust.
  if (seen.payoutOutputs === undefined) return read('payout_outputs')
  const already = seen.payoutOutputs.find((output) => output.valueSats === row.payoutSats)
  return already ? { do: 'adopt_funding', txid: already.txid, vout: already.vout } : { do: 'submit_funding' }
}

const matchingPreimage = (row: OnchainSendPlanRow, spend: { preimage: Uint8Array | null }): string | null => {
  const { preimage } = spend
  return preimage && paymentHashFromPreimage(preimage) === row.paymentHash ? hex.encode(preimage) : null
}

const whenAwaitingClaim = (row: OnchainSendPlanRow, seen: OnchainSendObservation): OnchainSendAction => {
  if (!row.fundingTxid || row.fundingVout === null) return fail('awaiting_claim state with no funding txid/vout')
  if (seen.spend === undefined) return read('spend_witness')

  if (seen.spend === null) {
    if (seen.fundingOutcome === undefined) {
      if (seen.nowSeconds >= row.htlcLocktime + HTLC_REFUND_MTP_MARGIN) return { do: 'start_refund' }
      const sinceFunding = row.fundStartedAt === null ? null : seen.nowSeconds - row.fundStartedAt
      return sinceFunding !== null && sinceFunding >= FUNDING_STUCK_ALERT_SECONDS ? read('funding_outcome') : WAIT
    }
    if (seen.fundingOutcome === 'confirmed' || row.fundStartedAt === null) return WAIT
    // A confirm past refund_locktime pays both sides, and only a human can bump or CPFP it.
    return {
      do: 'wait',
      alert:
        `funding ${row.fundingTxid} unconfirmed ${seen.nowSeconds - row.fundStartedAt}s after broadcast — ` +
        `bump or CPFP before refund_locktime ${row.refundLocktime} (the client reclaims the Arkade lockup ` +
        `after it, so a later confirm pays both sides); htlc_locktime ${row.htlcLocktime}`,
    }
  }

  // A spend that is not a matching claim is most likely our own refund. Either way a human looks.
  const preimage = matchingPreimage(row, seen.spend)
  if (preimage === null) return fail(ONCHAIN_FOREIGN_SPEND)
  // TLA+ F7: after downtime the claim may be on chain with the deadline nearly spent. Claiming anyway is
  // the only recourse and collects in full if it lands, so the row moves on; someone is told of the squeeze.
  const timeLeft = arkadeClaimTimeLeft(row.refundLocktime, seen.nowSeconds)
  if (timeLeft >= ARKADE_CLAIM_WINDOW_SECONDS) return { do: 'record_claim', preimage }
  return {
    do: 'record_claim',
    preimage,
    alert:
      `claim race: ${timeLeft}s left to claim the arkade lockup, under the ${ARKADE_CLAIM_WINDOW_SECONDS}s budget ` +
      `(refund_locktime ${row.refundLocktime}, htlc_locktime ${row.htlcLocktime}) — claiming anyway`,
  }
}

const whenRefundingOnchain = (row: OnchainSendPlanRow, seen: OnchainSendObservation): OnchainSendAction => {
  if (!row.fundingTxid || row.fundingVout === null) return fail('refunding_onchain state with no funding txid/vout')

  // Our own earlier attempts first: a CONFIRMED refund of this output means no claim can exist, and
  // knowing them by name stops one that went out before a crash being read as a foreign spend below.
  if (row.onchainRefundTxid !== null || row.onchainRefundPriorTxids.length > 0) {
    if (seen.refundOutcome === undefined) return read('refund_outcome')
    if (seen.refundOutcome.outcome === 'confirmed') return { do: 'record_refund', txid: seen.refundOutcome.txid }
    // Until it confirms the claim leaf stays open.
    if (seen.refundOutcome.outcome === 'mempool') return { do: 'bump_refund' }
  }

  // A late claim is still valid. Refunding over it would retry a failing double spend for ever, never
  // learn the preimage, and lose the Arkade lockup as well as the payout.
  if (seen.spend === undefined) return read('spend_witness')
  if (seen.spend !== null) {
    const preimage = matchingPreimage(row, seen.spend)
    return preimage === null ? fail(ONCHAIN_FOREIGN_SPEND) : { do: 'record_claim', preimage }
  }

  if (seen.refundNotSent === undefined) return { do: 'push_refund' }
  // Giving up before refund_locktime would end both the claim check above and the retry.
  return seen.refundNotSent.retry && seen.nowSeconds < row.refundLocktime
    ? { do: 'throw', message: seen.refundNotSent.reason }
    : fail(seen.refundNotSent.reason)
}
