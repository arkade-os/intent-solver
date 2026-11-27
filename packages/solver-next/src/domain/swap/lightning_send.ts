import type { ValueOf } from '../shared/brand.js'
import type { UnixSeconds } from '../shared/time.js'

const MINUTE = 60
const HOUR = 60 * MINUTE

export const SECONDS_PER_BLOCK = 10 * MINUTE
export const LONGEST_WAIT_FOR_THE_LOCKUP = 15 * MINUTE
export const SHORTEST_INVOICE_LIFE_LEFT = 2 * MINUTE
export const TIME_TO_CLAIM = 90 * MINUTE
export const SPARE_TIME_BEFORE_THE_REFUND = 2 * HOUR
export const SMALLEST_ROUTING_FEE_CAP_SATS = 25
export const SECONDS_A_NEW_PAYMENT_MAY_BE_MISSING = 60

/** The lockup must be funded by this moment, and the invoice must still have life left when it is. */
export const lockupDeadline = (
  quotedAt: number,
  invoiceExpiresAt: number,
  longestWait = LONGEST_WAIT_FOR_THE_LOCKUP,
): number => Math.min(quotedAt + longestWait, invoiceExpiresAt - SHORTEST_INVOICE_LIFE_LEFT)

export interface ClientLockupSeen {
  /** Everything at the lockup address, spendable by a claim or not. */
  readonly heldSats: number
  readonly spendableSats: readonly number[]
}

export interface LockupRules {
  readonly amountSats: number
  readonly maxOutputs: number
  readonly quotedAt: UnixSeconds
  readonly invoiceExpiresAt: UnixSeconds
  readonly longestWait: number
}

export type LockupStep =
  | { readonly do: 'adopt' }
  | { readonly do: 'wait' }
  /** `heldSats` is what the client has to take back. Null when nothing is there. */
  | { readonly do: 'refuse'; readonly reason: string; readonly heldSats: number | null }

// The words are what clients and logs already see.
const whyTooLate = (rules: LockupRules, claimable: number, now: number): string => {
  if (now >= rules.invoiceExpiresAt) return 'invoice expired before funding completed'
  if (claimable >= rules.amountSats) return 'lockup arrived after the funding deadline'
  return claimable > 0 ? `lockup timeout with partial ${claimable} sats` : 'lockup timeout'
}

/** Only a lockup of exactly the amount is adopted. More than the amount is refused at once: it is never paid against. */
export const whatToDoWithTheLockup = (seen: ClientLockupSeen, rules: LockupRules, now: UnixSeconds): LockupStep => {
  const { heldSats, spendableSats } = seen
  const { amountSats, maxOutputs } = rules
  const refuse = (reason: string): LockupStep => ({ do: 'refuse', reason, heldSats: heldSats > 0 ? heldSats : null })
  const claimable = spendableSats.reduce((sum, sats) => sum + sats, 0)

  if (claimable > amountSats) return refuse(`overfunded lockup: ${claimable} > ${amountSats} sats`)
  if (claimable === amountSats && spendableSats.length > maxOutputs) {
    return refuse(`lockup funded in ${spendableSats.length} outputs, over ${maxOutputs}`)
  }
  if (claimable < amountSats && heldSats >= amountSats) {
    return refuse(`lockup funded on an asset vtxo a claim cannot spend: ${heldSats} held, ${claimable} spendable`)
  }
  const tooLate =
    now >= lockupDeadline(rules.quotedAt, rules.invoiceExpiresAt, rules.longestWait) || now >= rules.invoiceExpiresAt
  if (tooLate) return refuse(whyTooLate(rules, claimable, now))
  return claimable === amountSats ? { do: 'adopt' } : { do: 'wait' }
}

/** How many blocks the payment's HTLC can take, as the invoice asks and the node allows. */
export interface HtlcBlocks {
  readonly finalHop: number
  readonly worstRouteHint: number
  readonly bestRouteHint: number
  readonly routeBudget: number
  /** A node that cannot cap the route is judged by the worst hint, and by the whole budget. */
  readonly nodeCapsTheRoute: boolean
}

const hintBlocks = (blocks: HtlcBlocks): number =>
  blocks.nodeCapsTheRoute ? blocks.bestRouteHint : blocks.worstRouteHint

const mostBlocksTheHtlcCouldTake = (blocks: HtlcBlocks): number =>
  blocks.finalHop + hintBlocks(blocks) + blocks.routeBudget

/** The cap sent with the payment: its HTLC must be over well before the client's refund opens. */
export const blocksThePaymentMayTake = (blocks: HtlcBlocks, refundOpensAt: number, now: number): number =>
  Math.min(
    mostBlocksTheHtlcCouldTake(blocks),
    Math.floor((refundOpensAt - now - SPARE_TIME_BEFORE_THE_REFUND) / SECONDS_PER_BLOCK),
  )

export const PayRefusal = {
  LockupInsufficient: 'lockup_insufficient',
  InvoiceExpired: 'invoice_expired',
  InvoiceExpiresTooSoon: 'invoice_expires_too_soon',
  TooLittleTimeToClaim: 'claim_window_too_short',
  TooFewBlocksForTheHtlc: 'cltv_budget_too_short',
  RouteMayOutliveTheRefund: 'uncapped_route_deadline_too_short',
} as const

export type PayRefusal = ValueOf<typeof PayRefusal>

export const tooFewBlocksForTheHtlc = (blocks: HtlcBlocks, refundOpensAt: number, now: number): boolean =>
  blocksThePaymentMayTake(blocks, refundOpensAt, now) <= blocks.finalHop + hintBlocks(blocks)

export const routeMayOutliveTheRefund = (blocks: HtlcBlocks, refundOpensAt: number, now: number): boolean =>
  !blocks.nodeCapsTheRoute && blocksThePaymentMayTake(blocks, refundOpensAt, now) < mostBlocksTheHtlcCouldTake(blocks)

export interface PayTerms {
  readonly invoiceExpiresAt: UnixSeconds
  /** When the client can take the lockup back. */
  readonly refundOpensAt: UnixSeconds
  readonly lockedSats: number
  readonly expectedSats: number
  readonly blocks: HtlcBlocks
}

/** Why the invoice must not be paid right now. Null when it may. Ask right before paying: the answer depends on the clock. */
export const whatStopsThePayment = (terms: PayTerms, now: UnixSeconds): PayRefusal | null => {
  const { invoiceExpiresAt, refundOpensAt, lockedSats, expectedSats, blocks } = terms
  const enoughLocked =
    Number.isFinite(lockedSats) && Number.isFinite(expectedSats) && expectedSats > 0 && lockedSats >= expectedSats
  if (!enoughLocked) return PayRefusal.LockupInsufficient
  if (now >= invoiceExpiresAt) return PayRefusal.InvoiceExpired
  if (invoiceExpiresAt - now < SHORTEST_INVOICE_LIFE_LEFT) return PayRefusal.InvoiceExpiresTooSoon
  if (refundOpensAt - now < TIME_TO_CLAIM) return PayRefusal.TooLittleTimeToClaim
  if (tooFewBlocksForTheHtlc(blocks, refundOpensAt, now)) return PayRefusal.TooFewBlocksForTheHtlc
  if (routeMayOutliveTheRefund(blocks, refundOpensAt, now)) return PayRefusal.RouteMayOutliveTheRefund
  return null
}

/** With the Arkade server gone, the client's own refund must not open before the refund we quoted. */
export const clientCannotRefundAloneEarly = (
  secondsToRefundAlone: number,
  refundOpensAt: number,
  quotedAt: number,
): boolean => secondsToRefundAlone >= refundOpensAt - quotedAt

export const routingFeeCapSats = (amountSats: number): number =>
  Math.max(SMALLEST_ROUTING_FEE_CAP_SATS, Math.ceil(amountSats * 0.005))

/** A node may not show a payment it was sent moments ago. Until then "no record" does not mean it failed. */
export const tooSoonToBelieveNoRecord = (sentAt: UnixSeconds | null, now: UnixSeconds): boolean =>
  sentAt !== null && now - sentAt < SECONDS_A_NEW_PAYMENT_MAY_BE_MISSING
