/**
 * Send leg: the client gives up Arkade balance for an onchain UTXO, via a
 * solver-funded Taproot HTLC.
 *
 * The client locks up on Arkade, we fund the onchain HTLC, they claim it revealing
 * the preimage, we claim the Arkade lockup. We are exposed at the HTLC funding. Same
 * shape as `core/send.ts`, with the HTLC's own CLTV standing in for a BOLT11's final
 * delta and no routing budget to add.
 */

import { HOUR, MINUTE, rawDelaySeconds } from './timelocks.js'
import type { Limits } from './limits.js'

/** How long a quoted swap stays fundable before it is considered abandoned. */
export const DEFAULT_ONCHAIN_LOCKUP_TIMEOUT = 15 * MINUTE

/** Solver policy default for `min_confirmations`. */
export const DEFAULT_MIN_CONFIRMATIONS = 1

/**
 * Shared by NAME AND VALUE with `@arkade-os/swap`'s `onchainHtlc.ts` — the client's
 * own `assertFundable` guardrail is written in terms of exactly these.
 */
export const ONCHAIN_SECONDS_PER_BLOCK = 600
export const ONCHAIN_CLAIM_MARGIN_SECONDS = 90 * MINUTE
export const ONCHAIN_ORDER_MARGIN_SECONDS = 2 * HOUR
export const MAX_MIN_CONFIRMATIONS = 6

/**
 * The FLOOR under `min_confirmations` (TLA+ F2, #38). Zero accepts an HTLC still in a
 * mempool; negative SHORTENS `htlcLocktimeFor`'s window, moving the deadline the wrong
 * way. Unreachable from the wire, but the guard belongs at the domain boundary.
 */
export const MIN_MIN_CONFIRMATIONS = 1

/**
 * Bring a requested confirmation depth inside the policy range.
 *
 * Total: `undefined` and any non-finite value take the default, because a NaN survives
 * both `Math.min` and `Math.max`. Fractions truncate — rounding up would over-deliver
 * on the client's own guardrail arithmetic.
 */
export const clampMinConfirmations = (requested: number | undefined): number => {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MIN_CONFIRMATIONS
  return Math.max(MIN_MIN_CONFIRMATIONS, Math.min(Math.trunc(requested), MAX_MIN_CONFIRMATIONS))
}
/** Taproot dust, not P2PKH's 546 — the refund destination is taproot. */
export const ONCHAIN_DUST_SATS = 330

/**
 * The onchain HTLC's CLTV deadline (absolute unix seconds, NOT a block height). Sized
 * so the client's guardrail passes with margin rather than at the boundary, where
 * clock skew would refuse it.
 */
export const htlcLocktimeFor = (minConfirmations: number, now: number): number =>
  now + minConfirmations * ONCHAIN_SECONDS_PER_BLOCK + 2 * ONCHAIN_CLAIM_MARGIN_SECONDS

/**
 * `htlcLocktime` matures against MEDIAN-TIME-PAST, which lags ~1h on mainnet. Arming
 * the refund at the bare deadline broadcasts a transaction Bitcoin rejects as
 * non-final, and widens the window for a client claim after we committed to refunding.
 */
export const HTLC_REFUND_MTP_MARGIN = 90 * MINUTE

/**
 * What the solver needs after learning `P` to get its Arkade claim landed (TLA+ F7,
 * #104). A DEADLINE BUDGET, not a timeout: the room
 * {@link onchainRefundLocktimeFor} reserves so a last-instant client claim cannot
 * leave the solver without time to answer.
 */
export const ARKADE_CLAIM_WINDOW_SECONDS = 90 * MINUTE

/**
 * When the client's Arkade refund may open. Several lower bounds, latest wins; every
 * bound only RAISES the result, so the client's `timelock_order` guardrail cannot
 * break by adding one.
 *
 * The third bound is F7: the client's L1 claim leaf has no timelock, so they may claim
 * up to `htlcLocktime` plus the MTP margin, after which the solver holds `P` and must
 * claim before `refund_locktime` or the client takes both legs. Slack at today's
 * values — a guard that binds only if someone shrinks the margins.
 */
export const onchainRefundLocktimeFor = (htlcLocktime: number, unilateralClaimDelay: number, now: number): number => {
  const chainBound = htlcLocktime + 2 * ONCHAIN_ORDER_MARGIN_SECONDS
  // Converted, not added raw — the same bound, and the same reason, as `core/send.ts`'s
  // `unilateralBound`: a block-typed delay against a unix-seconds deadline collapses
  // this bound to nothing rather than merely blurring it.
  const serverIndependentBound = now + rawDelaySeconds(unilateralClaimDelay) + ONCHAIN_ORDER_MARGIN_SECONDS
  const claimAnswerBound = latestClaimArrival(htlcLocktime) + ARKADE_CLAIM_WINDOW_SECONDS
  return Math.max(chainBound, serverIndependentBound, claimAnswerBound)
}

/**
 * The last instant a client claim can reach the chain. Named because the bound above
 * and `whenAwaitingClaim`'s runtime check must agree on it.
 */
export const latestClaimArrival = (htlcLocktime: number): number => htlcLocktime + HTLC_REFUND_MTP_MARGIN

/**
 * How long is left to claim the Arkade lockup now that `P` is known. Negative or small
 * means F7's loss window: the lockup can be pulled back while we hold their preimage.
 */
export const arkadeClaimTimeLeft = (refundLocktime: number, now: number): number => refundLocktime - now

export type OnchainSendAcceptanceRefusal = 'amount_out_of_range'

export interface OnchainSendAcceptanceParams {
  amountSats: number
  limits: Limits
  unilateralClaimDelay: number
  now: number
  minConfirmations?: number
}

export type OnchainSendAcceptance =
  | { accept: true; refundLocktime: number; htlcLocktime: number; minConfirmations: number; lockupDeadline: number }
  | { accept: false; reason: OnchainSendAcceptanceRefusal }

/** The pure quote-time gate: servable amount, and the deadlines the quote carries. */
export const evaluateOnchainSendAcceptance = (params: OnchainSendAcceptanceParams): OnchainSendAcceptance => {
  if (params.amountSats < params.limits.minSats || params.amountSats > params.limits.maxSats) {
    return { accept: false, reason: 'amount_out_of_range' }
  }
  const minConfirmations = clampMinConfirmations(params.minConfirmations)
  const htlcLocktime = htlcLocktimeFor(minConfirmations, params.now)
  return {
    accept: true,
    refundLocktime: onchainRefundLocktimeFor(htlcLocktime, params.unilateralClaimDelay, params.now),
    htlcLocktime,
    minConfirmations,
    lockupDeadline: params.now + DEFAULT_ONCHAIN_LOCKUP_TIMEOUT,
  }
}

/** Re-evaluated immediately before funding the onchain HTLC — not at quote time. */
export const MIN_ONCHAIN_FUND_WINDOW = 90 * MINUTE

export type OnchainSendFundingDecision = { fund: true } | { fund: false; reason: string }

export const evaluateOnchainSendFunding = (params: {
  refundLocktime: number
  now: number
}): OnchainSendFundingDecision => {
  if (params.now >= params.refundLocktime - MIN_ONCHAIN_FUND_WINDOW) {
    return { fund: false, reason: 'refused to fund: refund window closing' }
  }
  return { fund: true }
}
