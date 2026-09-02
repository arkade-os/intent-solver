/**
 * Receive leg: the client pays a Bitcoin L1 HTLC and the sats land on Arkade — the
 * mirror of `core/onchainSend.ts`.
 *
 * The client funds the HTLC and goes offline; we wait for confirmations, fund the
 * Arkade side under a covenant pinned to their payout script, covclaimd reveals `P`,
 * and we claim the HTLC. We are exposed at the Arkade funding.
 *
 * The roles reverse from send, which inverts the bound: there the client funds Arkade
 * and `refund_locktime` lands AFTER `htlc_locktime`; here the solver funds Arkade and
 * its refund must open BEFORE the onchain deadline (rfq-protocol.md §7.1.4).
 *
 * Values coinciding with `onchainSend.ts` are redeclared rather than imported, because
 * they are corridor POLICY an operator may want to differ per leg.
 * `UNILATERAL_RECOURSE_MARGIN` is the one exception: it is headroom against the CSV
 * ladder, the same physical fact on both receive legs, so redeclaring it could let the
 * two drift and leave one funding swaps the other refuses.
 */

import { HOUR, MINUTE } from './timelocks.js'
import { UNILATERAL_RECOURSE_MARGIN } from './receive.js'
import type { Limits } from './limits.js'

/** Shared by name and value with `@arkade-os/swap`. Redeclared; see the header. */
export const ONCHAIN_SECONDS_PER_BLOCK = 600
export const MAX_MIN_CONFIRMATIONS = 6
export const DEFAULT_MIN_CONFIRMATIONS = 1

/**
 * The FLOOR under `min_confirmations` (TLA+ F2, #38). Zero is the dangerous one HERE:
 * this leg funds Arkade against the client's HTLC, so zero confirmations means funding
 * against a transaction that can still be replaced. `test/interop/constantsParity.test.ts`
 * pins the two legs together.
 */
export const MIN_MIN_CONFIRMATIONS = 1

/** @see `core/onchainSend.ts`'s identical helper. */
export const clampMinConfirmations = (requested: number | undefined): number => {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MIN_CONFIRMATIONS
  return Math.max(MIN_MIN_CONFIRMATIONS, Math.min(Math.trunc(requested), MAX_MIN_CONFIRMATIONS))
}

/** How long a quoted swap stays fundable by the CLIENT before it is abandoned. */
export const DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT = 15 * MINUTE

/** Taproot dust, not P2PKH's 546. Redeclared; see the header. */
export const ONCHAIN_DUST_SATS = 330

/** rfq-protocol.md §9's receive-direction invariants, unchanged from `core/receive.ts`. */
export const MIN_SETTLE_WINDOW = 90 * MINUTE
export const SETTLE_SAFETY_MARGIN = 15 * MINUTE
export const MAX_REFUND_HORIZON = 2 * HOUR

/**
 * The onchain HTLC's CLTV deadline — on this leg the CLIENT's refund path.
 *
 * Sized for everything past the client's broadcast: the confirmation wait, then our
 * settle process (notice, fund Arkade, covclaimd claims, notice `P`, claim the HTLC).
 */
export const htlcLocktimeFor = (minConfirmations: number, now: number): number =>
  now + minConfirmations * ONCHAIN_SECONDS_PER_BLOCK + 2 * MIN_SETTLE_WINDOW

/**
 * When the SOLVER's own Arkade refund may open.
 *
 * `min` of two upper bounds, not `max` of two lower ones: on this leg our refund must
 * land BEFORE the cross-side deadline.
 *
 * THE CAP ALWAYS WINS in the reachable input range, and that is load-bearing rather
 * than incidental (#141). It supplies 70–120 minutes of L1 claim slack where the
 * written formula would supply `SETTLE_SAFETY_MARGIN`'s 15. Raising
 * `MAX_REFUND_HORIZON` shrinks that toward 15; {@link onchainReceiveClaimWindow}
 * states the quantity so it can be pinned instead of emerging.
 */
export const arkadeRefundLocktimeFor = (htlcLocktime: number, now: number): number =>
  Math.min(htlcLocktime - SETTLE_SAFETY_MARGIN, now + MAX_REFUND_HORIZON)

/**
 * How long the solver has to confirm its HTLC claim once a late Arkade claim reveals
 * `P`. The one deadline on this leg whose miss costs REAL MONEY: past it we have
 * refunded our lockup while the counterparty can still sweep the HTLC.
 */
export const onchainReceiveClaimWindow = (minConfirmations: number, now: number): number => {
  const htlcLocktime = htlcLocktimeFor(minConfirmations, now)
  return htlcLocktime - arkadeRefundLocktimeFor(htlcLocktime, now)
}

export type OnchainReceiveAcceptanceRefusal = 'amount_out_of_range'

export interface OnchainReceiveAcceptanceParams {
  amountSats: number
  limits: Limits
  now: number
  minConfirmations?: number
}

export type OnchainReceiveAcceptance =
  | {
      accept: true
      /** The onchain HTLC's CLTV deadline — the client's refund path. */
      htlcLocktime: number
      /** The Arkade lockup's refund deadline — the solver's own. Wire field `refund_locktime`. */
      arkadeRefundLocktime: number
      minConfirmations: number
      lockupDeadline: number
    }
  | { accept: false; reason: OnchainReceiveAcceptanceRefusal }

/**
 * The pure quote-time gate. Both locktimes derive from `now` here, unlike the
 * Lightning receive leg: its `E` is only known once a payer's HTLC arms, while this
 * leg's cross-side deadline is one WE choose and the client verifies before funding.
 */
export const evaluateOnchainReceiveAcceptance = (params: OnchainReceiveAcceptanceParams): OnchainReceiveAcceptance => {
  if (params.amountSats < params.limits.minSats || params.amountSats > params.limits.maxSats) {
    return { accept: false, reason: 'amount_out_of_range' }
  }
  const minConfirmations = clampMinConfirmations(params.minConfirmations)
  const htlcLocktime = htlcLocktimeFor(minConfirmations, params.now)
  return {
    accept: true,
    htlcLocktime,
    arkadeRefundLocktime: arkadeRefundLocktimeFor(htlcLocktime, params.now),
    minConfirmations,
    lockupDeadline: params.now + DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT,
  }
}

/** Re-evaluated immediately before funding the ARKADE lockup — not at quote time. */
export const MIN_ARKADE_FUND_WINDOW = 90 * MINUTE

export type OnchainReceiveFundingDecision = { fund: true } | { fund: false; reason: string }

export const evaluateOnchainReceiveFunding = (params: {
  arkadeRefundLocktime: number
  /** Absolute timeout of the CLIENT's onchain htlc, unix seconds. */
  htlcLocktime: number
  /** CSV delay on the leaf the solver can spend ALONE, seconds, from the row. */
  unilateralRefundWithoutReceiverDelay: number
  now: number
}): OnchainReceiveFundingDecision => {
  if (params.now >= params.arkadeRefundLocktime - MIN_ARKADE_FUND_WINDOW) {
    return { fund: false, reason: 'refused to fund: arkade refund window closing' }
  }
  // Gate (d) against this corridor's cross-side deadline (#69). The check above bounds
  // the COLLABORATIVE refund, which needs the Arkade server; with it gone the trader's
  // `unilateralClaim` opens first, so an HTLC timing out before our own leaf opens lets
  // them reclaim onchain and then claim the Arkade payout — both sides.
  if (params.now + params.unilateralRefundWithoutReceiverDelay + UNILATERAL_RECOURSE_MARGIN > params.htlcLocktime) {
    return { fund: false, reason: 'refused to fund: solver unilateral recourse opens after the onchain htlc timeout' }
  }
  return { fund: true }
}
