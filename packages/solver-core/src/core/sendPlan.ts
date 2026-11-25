/**
 * What an `arkade:BTC->lightning:BTC` swap should do next, up to the moment it submits the payment. Pure: the
 * orchestrator reads, this decides, the orchestrator acts. Same shape as `receivePlan.ts`: the planner
 * reads the outside world through `SendReads`, in the order the rules need it.
 *
 * Of `paying` and `paid`: the gates in front of the payment (`planPayment`), what a polled payment means
 * and how a failed one closes. The sends, the crash recovery and `claiming` stay in the orchestrator for now.
 */

import { decodeInvoice } from '../invoice/decode.js'
import type { PaymentResult } from '../ports/lightning.js'
import { judgeClientLockup, LOCKUP_REFUSAL, type ClientLockup } from './clientLockup.js'
import { maxRoutingFeeSats } from './limits.js'
import {
  deadlineContainsHtlc,
  evaluateSendPayment,
  hintCltvBlocks,
  lockupDeadlineFor,
  payableCltvBlocks,
  refundWithoutReceiverDelayCovers,
} from './send.js'

export const SEND_KEY_ROTATED = 'provider key rotated since quote; refusing to pay an unclaimable lockup'
export const SEND_COUPLED_REFUSED = 'coupled receive refused before funding; client refund pending'
export const SEND_COUPLED_REFUNDED = 'coupled receive refunded its unclaimed payout; client refund pending'

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
  | { do: 'refuse_coupled'; reason: string }
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
  if (nowSeconds >= row.invoiceExpiresAt) return LOCKUP_REFUSAL.invoiceExpired
  if (claimable >= row.amountSats) return LOCKUP_REFUSAL.arrivedLate
  return claimable > 0 ? `${LOCKUP_REFUSAL.timeout} with partial ${claimable} sats` : LOCKUP_REFUSAL.timeout
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
  if (preimage !== null) return { do: 'collect', preimage }
  // `refunded`: our refund spent the payout, so the client can no longer claim it and reveal the preimage.
  return coupled.state === 'refunded' ? { do: 'refuse_coupled', reason: SEND_COUPLED_REFUNDED } : WAIT
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
  return invoiceUnpaid ? { do: 'refuse_coupled', reason: SEND_COUPLED_REFUSED } : WAIT
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

export interface PaymentPlanRow {
  idempotencyKey: string | null
  createdAt: number
  invoice: string
  refundWithoutReceiverDelay: number
  quotedRefundDeadline: number | null
  quotedRoutingFeeSats: number | null
}

export type PaymentReads = Pick<
  SendReads,
  | 'now'
  | 'providerKeyCurrent'
  | 'refundDeadline'
  | 'hintDenylist'
  | 'routeCltvBudgetBlocks'
  | 'enforcesRouteCltv'
  | 'payDeadline'
>

export type PaymentAction =
  | { do: 'pay'; idempotencyKey: string; maxFeeSats: number; maxCltvBlocks: number }
  /** Closed with nothing owed: the caller proved no payment is committed. */
  | { do: 'refuse'; reason: string }
  /** A payment may be out; the store decides where an exposed row is parked. */
  | { do: 'fail'; reason: string }

/**
 * The gates in front of every submission, the first and each re-submission after a crash.
 *
 * `nothingCommitted` is the caller's proof, from a read earlier in the same tick, that no payment is
 * committed against this hash. It is not read again here.
 */
export const planPayment = async (
  row: PaymentPlanRow,
  nothingCommitted: boolean,
  reads: PaymentReads,
): Promise<PaymentAction> => {
  // Unreachable by construction; refusing to pay without one is the point.
  if (!row.idempotencyKey) return { do: 'fail', reason: 'paying state with no idempotency key' }
  const refuse = (reason: string): PaymentAction => ({ do: nothingCommitted ? 'refuse' : 'fail', reason })

  // A row recovered in `paying` re-submits on whatever key is configured now, and the claim throws on a
  // mismatch rather than reaching for a retained key.
  if (!reads.providerKeyCurrent()) return refuse('refused to pay: provider key rotated since quote')
  const refundDeadline = await reads.refundDeadline()
  if (
    !refundWithoutReceiverDelayCovers(
      row.refundWithoutReceiverDelay,
      row.quotedRefundDeadline ?? refundDeadline,
      row.createdAt,
    )
  ) {
    return refuse('refused to pay: client_solo_refund_too_soon')
  }
  const invoice = decodeInvoice(row.invoice, reads.hintDenylist())
  const cltv = {
    minFinalCltvBlocks: invoice.minFinalCltvBlocks,
    worstRouteHintCltvBlocks: invoice.worstRouteHintCltvBlocks,
    bestRouteHintCltvBlocks: invoice.bestRouteHintCltvBlocks,
    routeCltvBudgetBlocks: reads.routeCltvBudgetBlocks(),
    enforcesRouteCltv: reads.enforcesRouteCltv(),
  }
  // The rail may have changed since the quote, and a re-submission asks none of the pay-time gates of
  // `funded`. Seconds: the CLTV budget is Lightning's wall clock.
  const payDeadline = await reads.payDeadline(refundDeadline)
  if (!reads.enforcesRouteCltv() && !deadlineContainsHtlc(cltv, payDeadline, reads.now())) {
    return refuse('refused to pay: uncapped_route_deadline_too_short')
  }
  const maxCltvBlocks = payableCltvBlocks(cltv, payDeadline, reads.now())
  // A budget this short is a refusal, not a ceiling (see `payableCltvBlocks`).
  if (maxCltvBlocks <= cltv.minFinalCltvBlocks + hintCltvBlocks(cltv)) {
    return refuse('refused to pay: cltv_budget_too_short')
  }
  return {
    do: 'pay',
    idempotencyKey: row.idempotencyKey,
    maxFeeSats: row.quotedRoutingFeeSats ?? maxRoutingFeeSats(invoice.amountSats),
    maxCltvBlocks,
  }
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
