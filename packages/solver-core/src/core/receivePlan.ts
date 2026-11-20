/**
 * What a `lightning:BTC->arkade:BTC` swap should do next. Pure: the orchestrator reads, this decides,
 * the orchestrator acts. The mirror of `evmReceivePlan.ts`.
 *
 * The planner asks for one fact at a time (`{ do: 'read' }`) and is called again once it is read.
 * So a fact is read only when a rule needs it, and the order of the rules is the order of the reads.
 */

import type { HoldState } from '../ports/lightning.js'
import { evaluateReceiveFunding } from './receive.js'
import { refundWithoutReceiverDelayCovers } from './send.js'

/**
 * How long `refunding` tolerates "the lockup is empty and no claim is readable" before it is called
 * inexplicable, seconds. The lockup reads as gone the moment a claim spends it, but the preimage needs
 * the spending transaction fetched back, and in that gap a COMPLETED swap looks exactly like a lost one.
 */
export const EMPTY_LOCKUP_GRACE = 120

/**
 * How long a refund may keep failing before the row is handed to a human (TLA+ F5). Measured from entry
 * into `refunding`, never from the refund locktime: a row only enters at or past its deadline, so a guard
 * against the deadline would escalate on the first failed push.
 */
export const REFUND_CENSORSHIP_GRACE = 6 * 60 * 60

export const RECEIVE_INVOICE_NEVER_ARMED = 'invoice expired before it was ever armed'
export const RECEIVE_FUNDING_LOST =
  'funding response lost; refund deadline reached with no lockup adopted — review for a stray lockup'
export const RECEIVE_LOCKUP_GONE = 'funded output gone during refunding with no matching claim found; needs review'

export interface ReceivePlanRow {
  state: string
  invoiceExpiresAt: number
  payoutSats: number
  fundStartedAt: number | null
  /** From the row, not live config: the lockup script was built from it. */
  refundWithoutReceiverDelay: number
  arkadeLockupTxid: string | null
  arkadeLockupVout: number | null
  preimage: string | null
  htlcExpiresAt: number | null
  /** As loaded, before this tick's own settle attempt is written down. */
  settleAttemptedAt: number | null
  /** Does not move while a row sits in `refunding`, so it is when the row entered it. */
  updatedAt: number
}

export interface ReceivePlanOutpoint {
  txid: string
  vout: number
  unrolled?: boolean
}

export interface ReceivePlanCoupledSend {
  state: string
  amountSats: number
  refundWithoutReceiverDelay: number
  createdAt: number
}

export type ReceiveRead =
  | 'hold'
  | 'coupled'
  | 'funding'
  | 'refund_deadline'
  | 'coupled_refund_deadline'
  | 'spendable'
  | 'refund_open'
  | 'claim'
  | 'own_refund'
  | 'hold_settled'

/** What has been read so far this tick. A field that is `undefined` has not been read. */
export interface ReceiveObservation {
  /** Taken again before every call, so a rule sees the time after the last read. */
  nowSeconds: number
  /** Live config, unlike the delay on the row: an operator who withdraws consent stops the next fund. */
  acceptUnilateralGap: boolean
  canRefundUnrolled: boolean
  hold?: HoldState
  /** A live send swap of our own client on the same payment hash. */
  coupled?: ReceivePlanCoupledSend | null
  /** An output of exactly the payout value that is already on the lockup, spent or not. */
  funding?: ReceivePlanOutpoint | null
  refundDeadlineSeconds?: number
  coupledRefundDeadlineSeconds?: number
  spendable?: readonly ReceivePlanOutpoint[]
  refundOpen?: boolean
  /** Every output the lockup ever had, and the preimage if any spend of them revealed it. */
  claim?: { history: readonly ReceivePlanOutpoint[]; preimage: string | null }
  /** Our own refund that was accepted before its answer reached us. Reading it finishes a pending one. */
  ownRefund?: string | null
  holdSettled?: boolean
  /** What the node said when `settle` failed this tick. */
  settleFailed?: string
  /** What arkd said when `refund` failed this tick, with the manual way out. */
  refundFailed?: string
}

export type ReceiveAction =
  | { do: 'read'; what: ReceiveRead }
  | { do: 'wait' }
  | { do: 'arm'; htlcExpiresAt: number | null }
  | { do: 'couple' }
  | { do: 'adopt' }
  | { do: 'fund'; coupled: boolean }
  | { do: 'record_claim'; preimage: string }
  | { do: 'start_refund' }
  | { do: 'settle' }
  | { do: 'record_settled' }
  | { do: 'refund' }
  | { do: 'refund_unrolled' }
  | { do: 'record_refund'; txid: string }
  /** The store decides between `refused` and `stuck` from the state. */
  | { do: 'fail'; reason: string }
  | { do: 'stuck'; reason: string }
  /** The send failed and it is too early to give up: the error goes to the caller. */
  | { do: 'rethrow' }

const WAIT: ReceiveAction = { do: 'wait' }
const read = (what: ReceiveRead): ReceiveAction => ({ do: 'read', what })
const fail = (reason: string): ReceiveAction => ({ do: 'fail', reason })

export const planReceive = (row: ReceivePlanRow, seen: ReceiveObservation): ReceiveAction => {
  switch (row.state) {
    case 'quoted':
      return whenQuoted(row, seen)
    case 'armed':
      return whenArmed(row, seen)
    case 'funded':
      return whenFunded(row, seen)
    case 'claimed':
      return whenClaimed(row, seen)
    case 'refunding':
      return whenRefunding(row, seen)
    default:
      return WAIT
  }
}

const isRecorded = (row: ReceivePlanRow) => (o: ReceivePlanOutpoint) =>
  o.txid === row.arkadeLockupTxid && o.vout === row.arkadeLockupVout

const whenQuoted = (row: ReceivePlanRow, seen: ReceiveObservation): ReceiveAction => {
  if (seen.hold === undefined) return read('hold')
  // A held payment always wins. A row funded against a coupled send while a payment it must settle is
  // also held would owe two payouts on one preimage.
  if (seen.hold.status === 'armed') return { do: 'arm', htlcExpiresAt: seen.hold.expiresAt }
  if (seen.coupled === undefined) return read('coupled')
  if (seen.coupled) return { do: 'couple' }
  if (seen.nowSeconds >= row.invoiceExpiresAt) return fail(RECEIVE_INVOICE_NEVER_ARMED)
  return WAIT
}

const whenArmed = (row: ReceivePlanRow, seen: ReceiveObservation): ReceiveAction => {
  // Before any gate: a crashed attempt may already have paid, and paying again pays twice for one claim.
  // The gates decide whether to create exposure; exposure that exists is adopted whatever they would say.
  if (seen.funding === undefined) return read('funding')
  if (seen.funding) return { do: 'adopt' }

  // A funding whose answer was lost is never refused on invoice expiry: a lockup may be out there.
  // It waits for the refund deadline, by which any real lockup has shown, and then needs a human.
  if (row.fundStartedAt !== null) {
    if (seen.refundDeadlineSeconds === undefined) return read('refund_deadline')
    return seen.nowSeconds >= seen.refundDeadlineSeconds ? { do: 'stuck', reason: RECEIVE_FUNDING_LOST } : WAIT
  }

  // Read again here, right before funding. Only an `armed` status gives a deadline that is trusted.
  if (seen.hold === undefined) return read('hold')
  const htlcExpiresAt = seen.hold.status === 'armed' ? seen.hold.expiresAt : null
  // The coupling is read, not inferred from the missing deadline: a missing deadline with no coupled
  // send left must still fail closed in the gates below.
  if (htlcExpiresAt === null && seen.coupled === undefined) return read('coupled')
  const coupled = htlcExpiresAt === null ? seen.coupled : null

  if (coupled) {
    if (coupled.state !== 'funded') {
      return fail(`refused to fund: coupled send swap is ${coupled.state}, not funded`)
    }
    if (seen.coupledRefundDeadlineSeconds === undefined) return read('coupled_refund_deadline')
    const covered = refundWithoutReceiverDelayCovers(
      coupled.refundWithoutReceiverDelay,
      seen.coupledRefundDeadlineSeconds,
      coupled.createdAt,
    )
    if (!covered) return fail('refused to fund: coupled send refund timing is unsafe')
    if (coupled.amountSats < row.payoutSats) {
      return fail(
        `refused to fund: coupled send lockup of ${coupled.amountSats} sats cannot cover a ${row.payoutSats} sat payout`,
      )
    }
    if (seen.nowSeconds >= row.invoiceExpiresAt) return fail('refused to fund: invoice_expired')
    return { do: 'fund', coupled: true }
  }

  if (seen.refundDeadlineSeconds === undefined) return read('refund_deadline')
  const decision = evaluateReceiveFunding({
    invoiceExpiresAt: row.invoiceExpiresAt,
    htlcExpiresAt,
    refundLocktime: seen.refundDeadlineSeconds,
    unilateralRefundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
    acceptUnilateralGap: seen.acceptUnilateralGap,
    now: seen.nowSeconds,
  })
  return decision.fund ? { do: 'fund', coupled: false } : fail(`refused to fund: ${decision.reason}`)
}

const whenFunded = (row: ReceivePlanRow, seen: ReceiveObservation): ReceiveAction => {
  if (seen.spendable === undefined) return read('spendable')
  if (row.arkadeLockupTxid === null || row.arkadeLockupVout === null) {
    return fail('funded state with no funded outpoint recorded')
  }
  // The recorded output, not "the script is empty": dust on the public lockup address must not put off
  // seeing the claim until the refund deadline.
  if (!seen.spendable.some(isRecorded(row))) {
    if (seen.claim === undefined) return read('claim')
    if (seen.claim.preimage !== null) return { do: 'record_claim', preimage: seen.claim.preimage }
    // Gone with no preimage readable yet may be plain read lag, so this waits for the deadline too.
  }
  if (seen.refundOpen === undefined) return read('refund_open')
  return seen.refundOpen ? { do: 'start_refund' } : WAIT
}

const whenClaimed = (row: ReceivePlanRow, seen: ReceiveObservation): ReceiveAction => {
  if (!row.preimage) return fail('claimed state with no preimage')
  // A coupled swap has nothing to settle: its invoice was cancelled when the coupling was recognised.
  // Read, not inferred from the missing deadline, which is also what a corrupt row looks like.
  if (row.htlcExpiresAt === null && seen.coupled === undefined) return read('coupled')
  if (row.htlcExpiresAt === null && seen.coupled) return { do: 'record_settled' }
  if (seen.settleFailed === undefined) return { do: 'settle' }

  // Only on a repeat can the error mean "already settled", and then the node is asked.
  if (row.settleAttemptedAt !== null) {
    if (seen.holdSettled === undefined) return read('hold_settled')
    if (seen.holdSettled) return { do: 'record_settled' }
  }
  if (row.htlcExpiresAt === null) return fail('claimed state with no htlcExpiresAt recorded')
  // Past its deadline the held payment is gone, so no retry can still succeed.
  if (seen.nowSeconds >= row.htlcExpiresAt) return fail(`settle failing past E: ${seen.settleFailed}`)
  return { do: 'rethrow' }
}

const whenRefunding = (row: ReceivePlanRow, seen: ReceiveObservation): ReceiveAction => {
  if (row.arkadeLockupTxid === null || row.arkadeLockupVout === null) {
    return fail('refunding state with no funded outpoint recorded')
  }
  if (seen.refundFailed !== undefined) {
    return seen.nowSeconds - row.updatedAt >= REFUND_CENSORSHIP_GRACE
      ? fail(`refund failing past the refund deadline: ${seen.refundFailed}`)
      : { do: 'rethrow' }
  }
  // A late claim can still land, and a refund pushed against it could only lose.
  if (seen.claim === undefined) return read('claim')
  if (seen.claim.preimage !== null) return { do: 'record_claim', preimage: seen.claim.preimage }
  // Before `spendable`, which reads an unrolled lockup as empty.
  if (seen.canRefundUnrolled && seen.claim.history.some((o) => o.unrolled === true && isRecorded(row)(o))) {
    return { do: 'refund_unrolled' }
  }
  if (seen.spendable === undefined) return read('spendable')
  if (seen.spendable.some(isRecorded(row))) return { do: 'refund' }

  if (seen.ownRefund === undefined) return read('own_refund')
  if (seen.ownRefund) return { do: 'record_refund', txid: seen.ownRefund }
  // Nothing to refund and no claim readable: read lag, or something this service cannot explain.
  // Only time tells them apart, and the claim is read again on every tick while this waits.
  if (seen.nowSeconds - row.updatedAt < EMPTY_LOCKUP_GRACE) return WAIT
  // `stuck` is swept by nothing, so giving up also stops the read that could still recover the swap.
  if (row.htlcExpiresAt !== null && seen.nowSeconds < row.htlcExpiresAt) return WAIT
  return fail(RECEIVE_LOCKUP_GONE)
}
