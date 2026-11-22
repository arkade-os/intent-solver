/**
 * What an `arkade:BTC->lightning:BTC` swap should do next, up to the moment it starts paying. Pure: the
 * orchestrator reads, this decides, the orchestrator acts. Same shape as `receivePlan.ts`: the planner asks
 * reads the outside world through `SendReads`, in the order the rules need it.
 *
 * Of `paying` and `paid`, the rules for a polled payment and for closing a failed one are here; the sends,
 * the crash recovery and `claiming` stay in the orchestrator for now.
 */

import { decodeInvoice } from '../invoice/decode.js'
import type { PaymentResult } from '../ports/lightning.js'
import { judgeClientLockup, type ClientLockup } from './clientLockup.js'
import { evaluateSendPayment, lockupDeadlineFor, refundWithoutReceiverDelayCovers } from './send.js'

export const SEND_KEY_ROTATED = 'provider key rotated since quote; refusing to pay an unclaimable lockup'
export const SEND_COUPLED_REFUSED = 'coupled receive refused before funding; client refund pending'

export interface SendPlanRow {
  state: string
  createdAt: number
  invoice: string
  invoiceExpiresAt: number
  amountSats: number
  lockupValue: number | null
  refundWithoutReceiverDelay: number
  quotedRefundDeadline: number | null
}

/** The receive swap of our own client on the same payment hash, when this solver minted the invoice. */
export interface SendPlanCoupledReceive {
  state: string
  pkScript: string
  invoice: string
  htlcExpiresAt: number | null
  fundStartedAt: number | null
  invoiceWalletFingerprint?: string | null
  invoiceBackendName?: string | null
}

export type { ClientLockup }

export interface SendReads {
  now(): number
  lockupTimeout(): number
  /** One claim spends at most this many outputs; the rest would stay for the client to refund. */
  maxLockupOutputs(): number
  providerKeyCurrent(): boolean
  /** How the node can be asked about an invoice it minted: directly, only after proving it is the same wallet, or not at all. */
  invoiceProbe(): 'own' | 'known' | 'none'
  backendName(): string | undefined
  routeCltvBudgetBlocks(): number
  enforcesRouteCltv(): boolean
  hintDenylist(): ReadonlySet<string>
  lockups(): Promise<ClientLockup>
  refundDeadline(): Promise<number>
  /** The live receive swap of our own client on the same payment hash. */
  coupledReceive(): Promise<SendPlanCoupledReceive | null>
  /** The preimage the client revealed by claiming the coupled payout. */
  coupledPreimage(receive: SendPlanCoupledReceive): Promise<string | null>
  /** Any receive swap on the hash, finished ones too. */
  failedReceive(): Promise<SendPlanCoupledReceive | null>
  currentWallet(): Promise<string | null>
  /** The status of our own invoice on the node, or null when it has none to give. */
  ownInvoice(): Promise<string | null>
  /** The refund deadline, pulled in by a lockup that is short or about to expire. */
  payDeadline(refundDeadline: number): Promise<number>
  approved(): Promise<boolean>
}

export type SendAction =
  | { do: 'wait'; alert?: string }
  | { do: 'adopt_lockup' }
  | { do: 'collect'; preimage: string }
  | { do: 'refuse_coupled' }
  | { do: 'start_paying' }
  /** `lockupValue`, when given, is written first so the refund sweep returns all of it. */
  | { do: 'fail'; reason: string; lockupValue?: number }
  /** A state whose rules are still in the orchestrator. */
  | { do: 'hand_over' }

const WAIT: SendAction = { do: 'wait' }
const fail = (reason: string): SendAction => ({ do: 'fail', reason })

export const planSend = (row: SendPlanRow, reads: SendReads): Promise<SendAction> => {
  switch (row.state) {
    case 'quoted':
      return whenQuoted(row, reads)
    case 'funded':
      return whenFunded(row, reads)
    case 'paying':
    case 'paid':
    case 'claiming':
      return Promise.resolve({ do: 'hand_over' })
    default:
      return Promise.resolve(WAIT)
  }
}

const whenQuoted = async (row: SendPlanRow, reads: SendReads): Promise<SendAction> => {
  const lockup = await reads.lockups()
  const now = reads.now()
  const tooLate =
    now >= lockupDeadlineFor(row.createdAt, row.invoiceExpiresAt, reads.lockupTimeout()) || now >= row.invoiceExpiresAt
  return judgeClientLockup(lockup, {
    amountSats: row.amountSats,
    maxOutputs: reads.maxLockupOutputs(),
    tooLate,
    // A full lockup that lands late is refused too: the refund locktime was fixed at the quote.
    lateReason: (claimable) => lateFundingReason(row, claimable, now),
    refusal: null,
  })
}

const lateFundingReason = (row: SendPlanRow, claimable: number, nowSeconds: number): string => {
  if (nowSeconds >= row.invoiceExpiresAt) return 'invoice expired before funding completed'
  if (claimable >= row.amountSats) return 'lockup arrived after the funding deadline'
  return claimable > 0 ? `lockup timeout with partial ${claimable} sats` : 'lockup timeout'
}

const sameInvoice = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

const whenFunded = async (row: SendPlanRow, reads: SendReads): Promise<SendAction> => {
  if (!reads.providerKeyCurrent()) return fail(SEND_KEY_ROTATED)
  const refundDeadline = await reads.refundDeadline()
  const clientCanRefundAloneInTime = refundWithoutReceiverDelayCovers(
    row.refundWithoutReceiverDelay,
    row.quotedRefundDeadline ?? refundDeadline,
    row.createdAt,
  )
  if (!clientCanRefundAloneInTime) return fail('refused to proceed: client solo refund opens before the quoted refund')

  const coupled = await reads.coupledReceive()
  if (coupled) return collectFromCoupledReceive(coupled, reads)

  const failed = await reads.failedReceive()
  if (failed && sameInvoice(failed.invoice, row.invoice) && failed.state === 'refused') {
    return afterCoupledReceiveRefused(failed, reads)
  }
  return payOrRefuse(row, refundDeadline, reads)
}

// The invoice is our own and a node cannot pay itself, so a coupled swap only collects: its preimage shows
// on Arkade when the client claims the payout of the receive leg.
const collectFromCoupledReceive = async (coupled: SendPlanCoupledReceive, reads: SendReads): Promise<SendAction> => {
  if (coupled.htlcExpiresAt !== null) return fail('refused to collect: receive took a real htlc')
  const preimage = await reads.coupledPreimage(coupled)
  return preimage === null ? WAIT : { do: 'collect', preimage }
}

const afterCoupledReceiveRefused = async (failed: SendPlanCoupledReceive, reads: SendReads): Promise<SendAction> => {
  const mayStillHavePaidOut = failed.fundStartedAt !== null || failed.htlcExpiresAt !== null
  if (mayStillHavePaidOut) return WAIT
  if (reads.invoiceProbe() === 'none') {
    return { do: 'wait', alert: 'coupled refund blocked: Lightning backend cannot probe its own invoice' }
  }
  if (reads.invoiceProbe() === 'known' && !mintedByThisNode(failed, await reads.currentWallet(), reads.backendName())) {
    return { do: 'wait', alert: 'coupled refund blocked: invoice wallet or backend identity unavailable or changed' }
  }
  const status = await reads.ownInvoice()
  const invoiceUnpaid = status === 'pending' || status === 'cancelled'
  return invoiceUnpaid ? { do: 'refuse_coupled' } : WAIT
}

const mintedByThisNode = (
  receive: SendPlanCoupledReceive,
  currentWallet: string | null,
  backendName: string | undefined,
): boolean => {
  const issuedBy = receive.invoiceWalletFingerprint
  const issuedThrough = receive.invoiceBackendName
  return Boolean(
    issuedBy && currentWallet && issuedBy === currentWallet && issuedThrough && issuedThrough === backendName,
  )
}

// Asked right before the money moves, which can be minutes after the quote. Approval comes last, so a
// held swap whose invoice lapses is refused here on a later tick.
const payOrRefuse = async (row: SendPlanRow, refundDeadline: number, reads: SendReads): Promise<SendAction> => {
  const invoice = decodeInvoice(row.invoice, reads.hintDenylist())
  const payDeadline = await reads.payDeadline(refundDeadline)
  const decision = evaluateSendPayment({
    invoiceExpiresAt: row.invoiceExpiresAt,
    refundLocktime: payDeadline,
    lockedSats: row.lockupValue ?? 0,
    expectedSats: row.amountSats,
    minFinalCltvBlocks: invoice.minFinalCltvBlocks,
    worstRouteHintCltvBlocks: invoice.worstRouteHintCltvBlocks,
    bestRouteHintCltvBlocks: invoice.bestRouteHintCltvBlocks,
    routeCltvBudgetBlocks: reads.routeCltvBudgetBlocks(),
    enforcesRouteCltv: reads.enforcesRouteCltv(),
    now: reads.now(),
  })
  if (!decision.pay) return fail(`refused to pay: ${decision.reason}`)
  return (await reads.approved()) ? { do: 'start_paying' } : WAIT
}

/**
 * `payInvoice` answers `pending` for an unrecognised error because the request may
 * still be executing, and a lookup inside that window reports "never heard of this
 * hash" either way — acting on it refunds a client whose payment then settles.
 */
export const NO_RECORD_GRACE_SECONDS = 60

/** Whether a submission is recent enough that a backend may not have recorded it yet. */
export const submittedWithinGrace = (payAttemptedAt: number | null, now: () => number): boolean =>
  payAttemptedAt !== null && now() - payAttemptedAt < NO_RECORD_GRACE_SECONDS

/** `advance`: not failed, so the row is `paid` and claims as soon as the poll carries a preimage. */
export type PolledPaymentAction = 'wait' | 'settle_failure' | 'advance'

/** What one poll of the payment means for a row that has a payment id. */
export const planPolledPayment = (
  row: { payAttemptedAt: number | null },
  polled: Pick<PaymentResult, 'status' | 'evidence'>,
  now: () => number,
): PolledPaymentAction => {
  if (polled.status !== 'failed') return 'advance'
  return polled.evidence === 'no_record' && submittedWithinGrace(row.payAttemptedAt, now) ? 'wait' : 'settle_failure'
}

/** Whether our own node, holding an invoice in this status, can still collect against the hash. */
export const ownNodeMayCollect = (ownInvoiceStatus: string): boolean =>
  ownInvoiceStatus !== 'pending' && ownInvoiceStatus !== 'cancelled'

/**
 * What the self-payment probe allows after a failed payment: `withhold` keeps the refund back, `not-ours`
 * is the probe's answer that the invoice is someone else's, `unknown` is a probe that could not be asked.
 */
export type FailedPaymentRecourse = 'withhold' | 'not-ours' | 'unknown'

/**
 * How a terminally failed payment closes. `refused` only when the client was refunded and the probe
 * said the invoice is not ours; every other case is left to a person, and says why.
 */
export const closeFailedPayment = (
  refunded: boolean,
  recourse: FailedPaymentRecourse,
): { do: 'refuse' | 'fail'; reason: string } => {
  const said = (why: string) => `lightning payment failed terminally; ${why}`
  if (refunded && recourse === 'not-ours') return { do: 'refuse', reason: said('client refunded') }
  // Most urgent first: withheld is money still in play, unlanded is a client still short.
  if (recourse === 'withhold') {
    return { do: 'fail', reason: said('refund withheld — our own node may still collect against this hash') }
  }
  if (!refunded) return { do: 'fail', reason: said('the refund did not land — see refund_attempt') }
  return { do: 'fail', reason: said('client refunded, but the self-payment probe could not be asked') }
}
