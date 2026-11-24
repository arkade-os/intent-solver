/**
 * What a `lightning:BTC->arkade:BTC` swap should do next. The orchestrator hands over the row and a way to
 * read the outside world; this decides; the orchestrator acts. Nothing here writes or sends.
 *
 * Reads are made in the order the rules need them, and only when a rule needs them.
 */

import type { HoldState } from '../ports/lightning.js'
import { evaluateReceiveFunding } from './receive.js'
import { refundWithoutReceiverDelayCovers } from './send.js'

/**
 * How long `refunding` tolerates "the lockup is empty and no claim is readable", seconds. The lockup reads
 * as gone the moment a claim spends it, but the preimage needs the spending transaction fetched back, and
 * in that gap a COMPLETED swap looks exactly like a lost one.
 */
export const EMPTY_LOCKUP_GRACE = 120

/**
 * How long a refund may keep failing before the row is handed to a human (TLA+ F5). Measured from entry
 * into `refunding`, never from the refund locktime: a row only enters at or past its deadline, so a guard
 * against the deadline would give up on the first failed push.
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

export interface LockupOutpoint {
  txid: string
  vout: number
  unrolled?: boolean
}

export interface LockupFunding {
  txid: string
  vout: number
  value: number
}

/** A live send swap of our own client on the same payment hash. */
export interface CoupledSend {
  state: string
  pkScript: string
  amountSats: number
  refundLocktime: number
  refundWithoutReceiverDelay: number
  createdAt: number
}

export interface ReceiveReads {
  now(): number
  /** Live config: an operator who withdraws consent stops the next fund, not the next quote. */
  acceptsUnilateralGap(): boolean
  canRefundUnrolled(): boolean
  hold(): Promise<HoldState>
  coupledSend(): Promise<CoupledSend | null>
  coupledRefundDeadline(send: CoupledSend): Promise<number>
  /** Whether the coupled send's lockup holds an output of exactly its amount. */
  coupledLockupFunded(send: CoupledSend): Promise<boolean>
  /** An output of exactly the payout already on our lockup, spent or not. */
  earlierFunding(): Promise<LockupFunding | null>
  refundDeadline(): Promise<number>
  spendable(): Promise<readonly LockupOutpoint[]>
  refundOpen(): Promise<boolean>
  /** Every output the lockup ever had, and the preimage if a spend of any of them revealed it. */
  claim(): Promise<{ history: readonly LockupOutpoint[]; preimage: string | null }>
  /** Our own refund that was accepted before its answer reached us. Reading it finishes a pending one. */
  ownRefund(): Promise<string | null>
  holdSettled(): Promise<boolean>
}

export type ReceiveAction =
  | { do: 'wait' }
  | { do: 'arm'; htlcExpiresAt: number | null }
  | { do: 'arm_coupled' }
  | { do: 'adopt'; funding: LockupFunding }
  | { do: 'fund'; coupled: boolean }
  | { do: 'record_claim'; preimage: string }
  | { do: 'start_refund' }
  | { do: 'settle' }
  | { do: 'record_settled' }
  | { do: 'refund' }
  | { do: 'refund_unrolled' }
  | { do: 'record_refund'; txid: string }
  /** The store decides between `refused` and `stuck` from the state. */
  | { do: 'fail'; reason: string; retireInvoice?: true }
  | { do: 'stuck'; reason: string }
  /** The send failed and it is too early to give up: the error goes to the caller. */
  | { do: 'rethrow' }

const WAIT: ReceiveAction = { do: 'wait' }
const fail = (reason: string): ReceiveAction => ({ do: 'fail', reason })

export const planReceive = (row: ReceivePlanRow, reads: ReceiveReads): Promise<ReceiveAction> => {
  switch (row.state) {
    case 'quoted':
      return whenQuoted(row, reads)
    case 'armed':
      return whenArmed(row, reads)
    case 'funded':
      return whenFunded(row, reads)
    case 'claimed':
      return whenClaimed(row, reads)
    case 'refunding':
      return whenRefunding(row, reads)
    default:
      return Promise.resolve(WAIT)
  }
}

const hasNoRecordedOutpoint = (row: ReceivePlanRow): boolean =>
  row.arkadeLockupTxid === null || row.arkadeLockupVout === null

const isRecorded = (row: ReceivePlanRow) => (o: LockupOutpoint) =>
  o.txid === row.arkadeLockupTxid && o.vout === row.arkadeLockupVout

const sendTooSmall = (send: CoupledSend, row: ReceivePlanRow): string =>
  `refused to fund: coupled send lockup of ${send.amountSats} sats cannot cover a ${row.payoutSats} sat payout`

const sendCanBeRefundedAloneInTime = async (send: CoupledSend, reads: ReceiveReads): Promise<boolean> =>
  refundWithoutReceiverDelayCovers(
    send.refundWithoutReceiverDelay,
    await reads.coupledRefundDeadline(send),
    send.createdAt,
  )

const whenQuoted = async (row: ReceivePlanRow, reads: ReceiveReads): Promise<ReceiveAction> => {
  // A held payment always wins. A row funded against a coupled send while a payment it must settle is
  // also held would owe two payouts on one preimage.
  const hold = await reads.hold()
  if (hold.status === 'armed') return { do: 'arm', htlcExpiresAt: hold.expiresAt }

  const send = await reads.coupledSend()
  if (send) return armAgainstCoupledSend(row, send, reads)

  if (reads.now() >= row.invoiceExpiresAt) {
    return { do: 'fail', reason: RECEIVE_INVOICE_NEVER_ARMED, retireInvoice: true }
  }
  return WAIT
}

// No payment will ever be held on an invoice we minted ourselves. The client's send lockup stands in for
// it, but only once it is funded and holds what it promised, so we never go first.
const armAgainstCoupledSend = async (
  row: ReceivePlanRow,
  send: CoupledSend,
  reads: ReceiveReads,
): Promise<ReceiveAction> => {
  if (send.amountSats < row.payoutSats) return fail(sendTooSmall(send, row))
  if (send.state === 'refused') {
    return {
      do: 'fail',
      reason: 'coupled send was refused; the receive leg can never fund against it',
      retireInvoice: true,
    }
  }
  if (send.state !== 'funded') return WAIT
  if (!(await sendCanBeRefundedAloneInTime(send, reads))) {
    return fail('refused to fund: coupled send refund timing is unsafe')
  }
  return (await reads.coupledLockupFunded(send)) ? { do: 'arm_coupled' } : WAIT
}

const whenArmed = async (row: ReceivePlanRow, reads: ReceiveReads): Promise<ReceiveAction> => {
  // Before any gate: a crashed attempt may already have paid, and paying again pays twice for one claim.
  const funding = await reads.earlierFunding()
  if (funding) return { do: 'adopt', funding }

  // A funding whose answer was lost is never refused on invoice expiry: a lockup may be out there.
  const fundingAnswerLost = row.fundStartedAt !== null
  if (fundingAnswerLost) {
    const deadline = await reads.refundDeadline()
    return reads.now() >= deadline ? { do: 'stuck', reason: RECEIVE_FUNDING_LOST } : WAIT
  }

  // Read again here, right before funding. Only an `armed` status gives a deadline that is trusted.
  const hold = await reads.hold()
  const htlcExpiresAt = hold.status === 'armed' ? hold.expiresAt : null
  // Read, not inferred from the missing deadline: with no coupled send left the gates must fail closed.
  const send = htlcExpiresAt === null ? await reads.coupledSend() : null
  if (send) return fundAgainstCoupledSend(row, send, reads)

  const decision = evaluateReceiveFunding({
    invoiceExpiresAt: row.invoiceExpiresAt,
    htlcExpiresAt,
    refundLocktime: await reads.refundDeadline(),
    unilateralRefundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
    acceptUnilateralGap: reads.acceptsUnilateralGap(),
    now: reads.now(),
  })
  return decision.fund ? { do: 'fund', coupled: false } : fail(`refused to fund: ${decision.reason}`)
}

const fundAgainstCoupledSend = async (
  row: ReceivePlanRow,
  send: CoupledSend,
  reads: ReceiveReads,
): Promise<ReceiveAction> => {
  if (send.state !== 'funded') return fail(`refused to fund: coupled send swap is ${send.state}, not funded`)
  if (!(await sendCanBeRefundedAloneInTime(send, reads))) {
    return fail('refused to fund: coupled send refund timing is unsafe')
  }
  if (send.amountSats < row.payoutSats) return fail(sendTooSmall(send, row))
  if (reads.now() >= row.invoiceExpiresAt) return fail('refused to fund: invoice_expired')
  if (!(await reads.coupledLockupFunded(send))) return WAIT
  // Re-check: the lockup read above is time during which the invoice can expire.
  if (reads.now() >= row.invoiceExpiresAt) return fail('refused to fund: invoice_expired')
  return { do: 'fund', coupled: true }
}

const whenFunded = async (row: ReceivePlanRow, reads: ReceiveReads): Promise<ReceiveAction> => {
  const spendable = await reads.spendable()
  if (hasNoRecordedOutpoint(row)) return fail('funded state with no funded outpoint recorded')

  // Our recorded output, not "the script is empty": dust on the public lockup address must not put off
  // seeing the claim until the refund deadline.
  const ourOutputIsSpent = !spendable.some(isRecorded(row))
  if (ourOutputIsSpent) {
    const { preimage } = await reads.claim()
    if (preimage !== null) return { do: 'record_claim', preimage }
  }
  return (await reads.refundOpen()) ? { do: 'start_refund' } : WAIT
}

const whenClaimed = async (row: ReceivePlanRow, reads: ReceiveReads): Promise<ReceiveAction> => {
  if (!row.preimage) return fail('claimed state with no preimage')
  // A coupled swap has nothing to settle. Read, not inferred from the missing deadline, which is also
  // what a corrupt row looks like.
  const nothingToSettle = row.htlcExpiresAt === null && (await reads.coupledSend()) !== null
  return nothingToSettle ? { do: 'record_settled' } : { do: 'settle' }
}

/** What to do after `settle` threw. `detail` is what the node said. */
export const planSettleFailed = async (
  row: ReceivePlanRow,
  reads: ReceiveReads,
  detail: string,
): Promise<ReceiveAction> => {
  // Only on a repeat can the error mean "already settled", and then the node is asked.
  const isRepeat = row.settleAttemptedAt !== null
  if (isRepeat && (await reads.holdSettled())) return { do: 'record_settled' }
  if (row.htlcExpiresAt === null) return fail('claimed state with no htlcExpiresAt recorded')
  // Past its deadline the held payment is gone, so no retry can still succeed.
  if (reads.now() >= row.htlcExpiresAt) return fail(`settle failing past E: ${detail}`)
  return { do: 'rethrow' }
}

const whenRefunding = async (row: ReceivePlanRow, reads: ReceiveReads): Promise<ReceiveAction> => {
  if (hasNoRecordedOutpoint(row)) return fail('refunding state with no funded outpoint recorded')

  // A late claim can still land, and a refund pushed against it could only lose.
  const { history, preimage } = await reads.claim()
  if (preimage !== null) return { do: 'record_claim', preimage }

  // Before `spendable`, which reads an unrolled lockup as empty.
  const ourOutputIsUnrolled = history.some((o) => o.unrolled === true && isRecorded(row)(o))
  if (reads.canRefundUnrolled() && ourOutputIsUnrolled) return { do: 'refund_unrolled' }

  const spendable = await reads.spendable()
  if (spendable.some(isRecorded(row))) return { do: 'refund' }

  const ownRefund = await reads.ownRefund()
  if (ownRefund) return { do: 'record_refund', txid: ownRefund }

  // Nothing to refund and no claim readable: read lag, or something this service cannot explain. Only
  // time tells them apart, and the claim is read again on every tick while this waits.
  if (reads.now() - row.updatedAt < EMPTY_LOCKUP_GRACE) return WAIT
  // `stuck` is swept by nothing, so giving up also stops the read that could still recover the swap.
  const paymentStillHeld = row.htlcExpiresAt !== null && reads.now() < row.htlcExpiresAt
  return paymentStillHeld ? WAIT : fail(RECEIVE_LOCKUP_GONE)
}

/** What to do after `refund` threw. `detail` is what arkd said, with the manual way out. */
export const planRefundFailed = (row: ReceivePlanRow, nowSeconds: number, detail: string): ReceiveAction =>
  nowSeconds - row.updatedAt >= REFUND_CENSORSHIP_GRACE
    ? fail(`refund failing past the refund deadline: ${detail}`)
    : { do: 'rethrow' }
