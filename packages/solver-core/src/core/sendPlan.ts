/**
 * What an `arkade:BTC->lightning:BTC` swap should do next, up to the moment it starts paying. Pure: the
 * orchestrator reads, this decides, the orchestrator acts. Same shape as `receivePlan.ts`: the planner asks
 * for one fact at a time (`{ do: 'read' }`), so the order of the rules is the order of the reads.
 *
 * `paying`, `paid` and `claiming` keep their rules in the orchestrator for now.
 */

import { decodeInvoice } from '../invoice/decode.js'
import { judgeClientLockup } from './clientLockup.js'
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
  invoice: string
  htlcExpiresAt: number | null
  fundStartedAt: number | null
  invoiceWalletFingerprint?: string | null
  invoiceBackendName?: string | null
}

export type SendRead =
  | 'lockups'
  | 'refund_deadline'
  | 'coupled'
  | 'coupled_preimage'
  | 'failed_receive'
  | 'wallet_identity'
  | 'own_invoice'
  | 'pay_deadline'
  | 'approval'

/** What has been read so far this tick. A field that is `undefined` has not been read. */
export interface SendObservation {
  /** Taken again before every call. */
  nowSeconds: number
  lockupTimeout: number
  /** One claim spends at most this many outputs; the rest would stay for the client to refund. */
  maxLockupOutputs: number
  providerKeyCurrent: boolean
  /** How the node can be asked about an invoice it minted: directly, only after proving it is the same wallet, or not at all. */
  invoiceProbe: 'own' | 'known' | 'none'
  backendName: string | undefined
  routeCltvBudgetBlocks: number
  enforcesRouteCltv: boolean
  hintDenylist: ReadonlySet<string>
  /** `held` counts every output; `spendable` leaves out those on an asset vtxo, which a claim cannot spend. */
  lockups?: { held: number; spendable: readonly { value: number }[] }
  refundDeadlineSeconds?: number
  coupled?: SendPlanCoupledReceive | null
  /** The preimage the client revealed by claiming the coupled payout. */
  coupledPreimage?: string | null
  /** Any receive swap on the hash, finished ones too. */
  failedReceive?: SendPlanCoupledReceive | null
  currentWallet?: string | null
  /** The status of our own invoice on the node, or null when it has none to give. */
  ownInvoice?: string | null
  /** The refund deadline, pulled in by a lockup that is short or about to expire. */
  payDeadline?: number
  approved?: boolean
}

export type SendAction =
  | { do: 'read'; what: SendRead }
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
const read = (what: SendRead): SendAction => ({ do: 'read', what })
const fail = (reason: string, lockupValue?: number): SendAction =>
  lockupValue === undefined ? { do: 'fail', reason } : { do: 'fail', reason, lockupValue }

export const planSend = (row: SendPlanRow, seen: SendObservation): SendAction => {
  switch (row.state) {
    case 'quoted':
      return whenQuoted(row, seen)
    case 'funded':
      return whenFunded(row, seen)
    case 'paying':
    case 'paid':
    case 'claiming':
      return { do: 'hand_over' }
    default:
      return WAIT
  }
}

const whenQuoted = (row: SendPlanRow, seen: SendObservation): SendAction => {
  if (seen.lockups === undefined) return read('lockups')
  const tooLate =
    seen.nowSeconds >= lockupDeadlineFor(row.createdAt, row.invoiceExpiresAt, seen.lockupTimeout) ||
    seen.nowSeconds >= row.invoiceExpiresAt
  return judgeClientLockup(seen.lockups, {
    amountSats: row.amountSats,
    maxOutputs: seen.maxLockupOutputs,
    tooLate,
    // A full lockup that lands late is refused too: the refund locktime was fixed at the quote.
    lateReason: (claimable) => lateFundingReason(row, claimable, seen.nowSeconds),
    refusal: null,
    recordOnOverfund: 'claimable',
    recordOnTooManyOutputs: true,
  })
}

const lateFundingReason = (row: SendPlanRow, claimable: number, nowSeconds: number): string => {
  if (nowSeconds >= row.invoiceExpiresAt) return 'invoice expired before funding completed'
  if (claimable >= row.amountSats) return 'lockup arrived after the funding deadline'
  return claimable > 0 ? `lockup timeout with partial ${claimable} sats` : 'lockup timeout'
}

const sameInvoice = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

const whenFunded = (row: SendPlanRow, seen: SendObservation): SendAction => {
  // Approval is the last thing read, and nothing is asked again after it.
  if (seen.approved !== undefined) return seen.approved ? { do: 'start_paying' } : WAIT

  if (!seen.providerKeyCurrent) return fail(SEND_KEY_ROTATED)
  if (seen.refundDeadlineSeconds === undefined) return read('refund_deadline')
  const clientCanRefundAloneInTime = refundWithoutReceiverDelayCovers(
    row.refundWithoutReceiverDelay,
    row.quotedRefundDeadline ?? seen.refundDeadlineSeconds,
    row.createdAt,
  )
  if (!clientCanRefundAloneInTime) return fail('refused to proceed: client solo refund opens before the quoted refund')

  if (seen.coupled === undefined) return read('coupled')
  if (seen.coupled) return collectFromCoupledReceive(seen.coupled, seen)

  if (seen.failedReceive === undefined) return read('failed_receive')
  const failed = seen.failedReceive
  if (failed && sameInvoice(failed.invoice, row.invoice) && failed.state === 'refused') {
    return afterCoupledReceiveRefused(failed, seen)
  }
  return payOrRefuse(row, seen)
}

// The invoice is our own and a node cannot pay itself, so a coupled swap only collects: its preimage shows
// on Arkade when the client claims the payout of the receive leg.
const collectFromCoupledReceive = (coupled: SendPlanCoupledReceive, seen: SendObservation): SendAction => {
  if (coupled.htlcExpiresAt !== null) return fail('refused to collect: receive took a real htlc')
  if (seen.coupledPreimage === undefined) return read('coupled_preimage')
  return seen.coupledPreimage === null ? WAIT : { do: 'collect', preimage: seen.coupledPreimage }
}

const afterCoupledReceiveRefused = (failed: SendPlanCoupledReceive, seen: SendObservation): SendAction => {
  const mayStillHavePaidOut = failed.fundStartedAt !== null || failed.htlcExpiresAt !== null
  if (mayStillHavePaidOut) return WAIT
  if (seen.invoiceProbe === 'none') {
    return { do: 'wait', alert: 'coupled refund blocked: Lightning backend cannot probe its own invoice' }
  }
  if (seen.invoiceProbe === 'known') {
    if (seen.currentWallet === undefined) return read('wallet_identity')
    if (!mintedByThisNode(failed, seen.currentWallet, seen.backendName)) {
      return { do: 'wait', alert: 'coupled refund blocked: invoice wallet or backend identity unavailable or changed' }
    }
  }
  if (seen.ownInvoice === undefined) return read('own_invoice')
  const invoiceUnpaid = seen.ownInvoice === 'pending' || seen.ownInvoice === 'cancelled'
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

// Asked right before the money moves, which can be minutes after the quote.
const payOrRefuse = (row: SendPlanRow, seen: SendObservation): SendAction => {
  const invoice = decodeInvoice(row.invoice, seen.hintDenylist)
  if (seen.payDeadline === undefined) return read('pay_deadline')
  const decision = evaluateSendPayment({
    invoiceExpiresAt: row.invoiceExpiresAt,
    refundLocktime: seen.payDeadline,
    lockedSats: row.lockupValue ?? 0,
    expectedSats: row.amountSats,
    minFinalCltvBlocks: invoice.minFinalCltvBlocks,
    worstRouteHintCltvBlocks: invoice.worstRouteHintCltvBlocks,
    bestRouteHintCltvBlocks: invoice.bestRouteHintCltvBlocks,
    routeCltvBudgetBlocks: seen.routeCltvBudgetBlocks,
    enforcesRouteCltv: seen.enforcesRouteCltv,
    now: seen.nowSeconds,
  })
  return decision.pay ? read('approval') : fail(`refused to pay: ${decision.reason}`)
}
