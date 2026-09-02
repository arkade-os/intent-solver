/**
 * Whether the solver may fund the Arkade side of an EVM receive swap.
 *
 * The corridor is `ethereum:<asset>->arkade:BTC`, and it is the mirror of
 * `core/evmSend.ts` with the roles exchanged:
 *
 * 1. the **client** locks tokens in `ERC20Swap`, carrying `evmTimeout` — when
 *    the CLIENT may take its tokens back;
 * 2. the **solver** funds the Arkade lockup out of its own capital, carrying
 *    `refundLocktime` — when the SOLVER may take its BTC back;
 * 3. the client claims the Arkade lockup, **revealing the preimage**;
 * 4. the solver claims the tokens with that preimage.
 *
 * The exposure and the ordering both invert. Here the solver goes second with its
 * own money, and the deadline it races is the CLIENT's: a client claiming the
 * Arkade lockup at the last moment before `refundLocktime` reveals the preimage
 * only then, and the solver must still get its token claim confirmed before
 * `evmTimeout` — after which the client can refund the very tokens the solver just
 * paid for. So the constraint inverts:
 *
 *     send:     evmTimeout     + margin <= refundLocktime
 *     receive:  refundLocktime + margin <= evmTimeout
 *
 * Two modules rather than one parameterised function, deliberately: the roles, the
 * money at risk and the party that chooses each deadline all differ, and a single
 * function taking a "which way round" flag is how the two get confused at the call
 * site.
 *
 * Does NOT cover finality. The client's lock must be observed to the corridor's
 * confirmation policy BEFORE this is consulted — on any L2 the sequencer's receipt
 * is not finality, and funding against an unfinalised lock risks it reorging away
 * after the solver has paid. That check belongs to the observer.
 */

import { EVM_MIN_CLAIM_WINDOW_SECONDS, EVM_ORDER_MARGIN_SECONDS } from './evmSend.js'
import { assertAbsoluteLocktime, HOUR } from './timelocks.js'

/**
 * The furthest-out client EVM deadline this deployment serves, seconds from
 * now. An INVARIANT, not config: the number bounds how long the solver's sats
 * can sit locked at one fixed rate — market risk no operator knob should be
 * able to widen. The mirror of `MAX_REFUND_HORIZON` on the BTC receive legs.
 */
export const EVM_MAX_CLIENT_TIMEOUT_SECONDS = 24 * HOUR

/**
 * Why the solver refused to fund. A closed set, like every other corridor's.
 *
 * Named from the SOLVER's point of view, matching the other corridors: these
 * are reasons not to put the solver's capital at risk.
 */
export type EvmReceiveFundRefusal =
  | 'evm_lock_expired'
  | 'evm_timeout_too_far_out'
  | 'client_claim_window_too_short'
  | 'recourse_after_evm_timeout'
  | 'deadlines_cannot_be_ordered'

export interface EvmReceiveFundParams {
  /** When the CLIENT's EVM refund opens, unix seconds (converted from a height). */
  evmTimeout: number
  /** When the SOLVER's Arkade refund opens, unix seconds. */
  refundLocktime: number
  nowSeconds: number
  /** Defaults to `EVM_ORDER_MARGIN_SECONDS`; injected so a test can pin the boundary. */
  orderMarginSeconds?: number
  /** Defaults to `EVM_MIN_CLAIM_WINDOW_SECONDS`. */
  minClaimWindowSeconds?: number
}

export type EvmReceiveFundDecision = { ok: true } | { ok: false; reason: EvmReceiveFundRefusal }

/**
 * Decide whether this pair of deadlines is safe to fund against.
 *
 * Structural-first, same as the send gate: a lock that has already expired is
 * wrong for every solver, an unorderable pair is wrong for this quote, and the
 * two window checks are the ones a different `refundLocktime` could fix.
 */
export const evaluateEvmReceiveFund = (params: EvmReceiveFundParams): EvmReceiveFundDecision => {
  const {
    evmTimeout,
    refundLocktime,
    nowSeconds,
    orderMarginSeconds = EVM_ORDER_MARGIN_SECONDS,
    minClaimWindowSeconds = EVM_MIN_CLAIM_WINDOW_SECONDS,
  } = params

  // Matters more here than on the send gate: `evmTimeout` is the CLIENT's number,
  // taken off the wire as a block height and converted a few frames earlier. An
  // unconverted height reaches every gate below as a very small integer and comes
  // back `evm_lock_expired`, which reads as a stale quote rather than as the
  // conversion that never happened.
  assertAbsoluteLocktime(refundLocktime)
  assertAbsoluteLocktime(evmTimeout, 'evmTimeout')

  // Not merely "expired": a lock with less than our own recourse margin left is
  // already useless, because even an instant claim leaves no time to collect.
  // Funding against one buys an obligation with no way to be paid for it.
  if (evmTimeout <= nowSeconds + orderMarginSeconds) return { ok: false, reason: 'evm_lock_expired' }

  // The horizon's OTHER end. A deadline years out is a claim on the solver's
  // sats at one fixed rate for as long — exactly the free option this gate
  // family exists to refuse, wearing a farther-out timelock instead of a
  // shorter one.
  if (evmTimeout > nowSeconds + EVM_MAX_CLIENT_TIMEOUT_SECONDS) {
    return { ok: false, reason: 'evm_timeout_too_far_out' }
  }

  const earliestSafe = nowSeconds + minClaimWindowSeconds
  const latestSafe = evmTimeout - orderMarginSeconds
  if (earliestSafe > latestSafe) return { ok: false, reason: 'deadlines_cannot_be_ordered' }

  if (refundLocktime < earliestSafe) return { ok: false, reason: 'client_claim_window_too_short' }
  if (refundLocktime > latestSafe) return { ok: false, reason: 'recourse_after_evm_timeout' }

  return { ok: true }
}

/**
 * The `refundLocktime` to commit to, given the client's `evmTimeout`.
 *
 * The latest safe value, for the same reason the send side takes the latest:
 * every second belongs to the client's claim window, and the margin already
 * covers the solver's own recourse.
 *
 * Returns null rather than an unsafe proposal when nothing works — a deadline
 * must never be lifted out of a quote this gate would refuse.
 */
export const arkadeRefundLocktimeFor = (params: Omit<EvmReceiveFundParams, 'refundLocktime'>): number | null => {
  const latestSafe = params.evmTimeout - (params.orderMarginSeconds ?? EVM_ORDER_MARGIN_SECONDS)
  const decision = evaluateEvmReceiveFund({ ...params, refundLocktime: latestSafe })
  return decision.ok ? latestSafe : null
}
