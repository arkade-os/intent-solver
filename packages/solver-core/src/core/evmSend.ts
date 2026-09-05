/**
 * Whether the solver may lock tokens on an EVM chain for a send swap
 * (`arkade:BTC->ethereum:<asset>`).
 *
 * The client funds the Arkade lockup carrying `refundLocktime`; the solver locks
 * tokens carrying `evmTimeout`; the client claims the tokens, revealing the preimage;
 * the solver claims the Arkade lockup.
 *
 * The solver locks second, so its timeout must come first — and not merely first. A
 * client claiming at the last moment before `evmTimeout` reveals the preimage only
 * then, and the solver must still confirm its Arkade claim before `refundLocktime` or
 * they walk away with both. So the binding constraint is
 *
 *     evmTimeout + recourse margin <= refundLocktime
 *
 * Denominated in SECONDS despite `ERC20Swap` using `block.number`, so the rule is
 * stated once and cannot be re-derived differently per chain. The caller converts.
 */

import { assertAbsoluteLocktime, HOUR, MINUTE } from './timelocks.js'
import type { Limits } from './limits.js'

/**
 * Time between seeing a claim and having our Arkade claim settled. Deliberately the
 * same as `ONCHAIN_ORDER_MARGIN_SECONDS` — not smaller because an EVM chain is faster,
 * since the slow half of this race is the ARKADE claim.
 */
export const EVM_ORDER_MARGIN_SECONDS = 2 * HOUR

/** The least time a client can reasonably be given to claim, gas acquisition included. */
export const EVM_MIN_CLAIM_WINDOW_SECONDS = 30 * MINUTE

/** Why the solver refused to lock. A closed set, so a caller cannot invent a reason. */
export type EvmSendLockRefusal =
  'evm_timeout_in_past' | 'claim_window_too_short' | 'recourse_after_refund_deadline' | 'deadlines_cannot_be_ordered'

export interface EvmSendLockParams {
  /**
   * When the solver's EVM refund opens, unix seconds. Direction depends on the
   * leg: on receive this is converted FROM the client's height; on send it is
   * derived by {@link evmTimeoutFor} and converted TO the height the row
   * stores. Either way this gate sees seconds only — the height conversion
   * happens at the orchestrator, never here.
   */
  evmTimeout: number
  /** When the client's Arkade refund opens, unix seconds. Committed at quote time. */
  refundLocktime: number
  nowSeconds: number
  /** Injected so a test can pin the boundary. */
  orderMarginSeconds?: number
  minClaimWindowSeconds?: number
}

export type EvmSendLockDecision = { ok: true } | { ok: false; reason: EvmSendLockRefusal }

/**
 * Decide whether this pair of deadlines is safe to lock against.
 *
 * Structural first: an already-past timeout is wrong for every solver, an unorderable
 * pair is wrong for this quote, and the two window checks come last because they are
 * the ones a different `evmTimeout` could fix.
 */
export const evaluateEvmSendLock = (params: EvmSendLockParams): EvmSendLockDecision => {
  const {
    evmTimeout,
    refundLocktime,
    nowSeconds,
    orderMarginSeconds = EVM_ORDER_MARGIN_SECONDS,
    minClaimWindowSeconds = EVM_MIN_CLAIM_WINDOW_SECONDS,
  } = params

  // Both arrive from somewhere that could hand over a block height instead. The
  // arithmetic below catches neither — a height is a small number, so every gate
  // refuses and the operator reads `evm_timeout_in_past` on a lock that is nothing of
  // the sort. A wiring error, not a refusal, hence not in the closed set.
  assertAbsoluteLocktime(refundLocktime)
  assertAbsoluteLocktime(evmTimeout, 'evmTimeout')

  if (evmTimeout <= nowSeconds) return { ok: false, reason: 'evm_timeout_in_past' }

  // The window a safe `evmTimeout` must land in, from both ends. Floor above ceiling
  // means no height works — the one failure changing `evmTimeout` cannot fix.
  const earliestSafe = nowSeconds + minClaimWindowSeconds
  const latestSafe = refundLocktime - orderMarginSeconds
  if (earliestSafe > latestSafe) return { ok: false, reason: 'deadlines_cannot_be_ordered' }

  if (evmTimeout < earliestSafe) return { ok: false, reason: 'claim_window_too_short' }
  // `>` not `>=`: landing exactly on the margin is the margin doing its job.
  if (evmTimeout > latestSafe) return { ok: false, reason: 'recourse_after_refund_deadline' }

  return { ok: true }
}

/**
 * The `evmTimeout` to ask for, given a committed `refundLocktime`.
 *
 * The LATEST safe value: every second belongs to the client's claim window, and the
 * margin already covers our recourse. Null rather than an unsafe proposal when nothing
 * works.
 */
export const evmTimeoutFor = (params: Omit<EvmSendLockParams, 'evmTimeout'>): number | null => {
  const latestSafe = params.refundLocktime - (params.orderMarginSeconds ?? EVM_ORDER_MARGIN_SECONDS)
  const decision = evaluateEvmSendLock({ ...params, evmTimeout: latestSafe })
  return decision.ok ? latestSafe : null
}

/**
 * Why a quote was refused before any deadline was even proposed.
 *
 * Separate from {@link EvmSendLockRefusal}: that one answers "are these two
 * deadlines safe to lock against", which is a question about ORDERING. This one
 * is the gate in front of it — size, and whether a safe pair of deadlines
 * exists at all.
 */
export type EvmSendAcceptanceRefusal = 'amount_out_of_range' | EvmSendLockRefusal

export interface EvmSendAcceptanceParams {
  /** What the CLIENT locks at the Arkade covenant. */
  amountSats: number
  limits: Limits
  /**
   * The solver's own worst-case recourse on the Arkade side, from
   * `deriveUnilateralDelays`. This is what anchors the whole quote — see below.
   */
  unilateralClaimDelay: number
  nowSeconds: number
  /** Injected so a test can pin a boundary; both default to this module's constants. */
  orderMarginSeconds?: number
  minClaimWindowSeconds?: number
}

export type EvmSendAcceptance =
  { accept: true; refundLocktime: number; evmTimeout: number } | { accept: false; reason: EvmSendAcceptanceRefusal }

/**
 * The pure quote-time gate for `arkade:BTC->ethereum:<token>`.
 *
 * THE ORDERING RUNS THE OPPOSITE WAY FROM THE OTHER CORRIDORS, and that is the
 * whole reason this function exists rather than reusing one of theirs. On the
 * Lightning leg the payee's CLTV fixes the outbound deadline and the Arkade
 * refund is sized to outlast it; on the onchain leg `htlcLocktimeFor` picks the
 * HTLC's CLTV first and `onchainRefundLocktimeFor` follows. Here neither is
 * possible: {@link evmTimeoutFor} DERIVES the EVM deadline from the Arkade one
 * by subtracting the margin, so the Arkade side has to be chosen first or the
 * definition is circular.
 *
 * So the anchor is the solver's own recourse. `refundLocktime` is
 * `now + unilateralClaimDelay + margin`, the same server-independent bound
 * `onchainRefundLocktimeFor` takes as one of its two — and here it is the only
 * one, because there is no counterparty-chosen deadline to bound against. The
 * EVM timeout then falls out one margin earlier, which leaves the client
 * `unilateralClaimDelay` to claim.
 *
 * WHAT THAT MARGIN IS AND IS NOT SIZED FOR. `EVM_ORDER_MARGIN_SECONDS` covers
 * observing the client's claim and getting the solver's own Arkade claim
 * SETTLED — the cooperative path. It does not cover a censoring Arkade Service,
 * where the solver's only recourse is the unilateral claim leaf: that leaf is
 * spendable now (`arkade/unilateralExit.ts`), but only through an on-chain exit
 * whose CSV runs from the moment the lockup CONFIRMS onchain, which this margin
 * makes no room for. This is the same exposure every other corridor carries and
 * is called out here rather than silently inherited.
 *
 * The result is re-checked through {@link evaluateEvmSendLock} rather than
 * trusted: deriving a deadline and validating it are different jobs, and a
 * caller that got a bad `unilateralClaimDelay` from config should be refused by
 * name rather than handed an unsafe pair.
 */
export const evaluateEvmSendAcceptance = (params: EvmSendAcceptanceParams): EvmSendAcceptance => {
  const { amountSats, limits } = params
  if (amountSats < limits.minSats || amountSats > limits.maxSats) {
    return { accept: false, reason: 'amount_out_of_range' }
  }
  return deriveEvmSendDeadlines(params)
}

/**
 * The deadline half of {@link evaluateEvmSendAcceptance}, with no opinion about
 * what the client locks.
 *
 * Extracted so the asset-funded leg (`arkade:<asset>->ethereum:<token>`) reuses
 * this ordering rule rather than restating it — the amount's DENOMINATION
 * differs there, the race between the two timeouts does not. A second copy of
 * this derivation is the kind that drifts silently and only on the swaps where
 * the margin actually mattered.
 */
export const deriveEvmSendDeadlines = (
  params: Omit<EvmSendAcceptanceParams, 'amountSats' | 'limits'>,
): EvmSendAcceptance => {
  const { unilateralClaimDelay, nowSeconds } = params
  const orderMargin = params.orderMarginSeconds ?? EVM_ORDER_MARGIN_SECONDS
  const minClaimWindow = params.minClaimWindowSeconds ?? EVM_MIN_CLAIM_WINDOW_SECONDS
  // TWO INDEPENDENT CONSTRAINTS, and the anchor has to clear both.
  //
  // The solver's recourse wants `unilateralClaimDelay` before its own refund
  // opens. The CLIENT separately needs `minClaimWindow` to claim at all - and
  // since `evmTimeout` is one margin earlier than this, anchoring on the exit
  // delay alone hands the client a window as short as that delay.
  //
  // On any network whose exit delay exceeds the claim window the two never
  // conflict, which is why a unit test with a production-shaped 24h delay
  // cannot see this. On the regtest stack, where the delay is under thirty
  // minutes, it made `evaluateEvmSendLock` refuse EVERY quote with
  // `deadlines_cannot_be_ordered` - found by running the corridor against a
  // live operator rather than by reading it.
  const refundLocktime = nowSeconds + Math.max(unilateralClaimDelay, minClaimWindow) + orderMargin
  const evmTimeout = evmTimeoutFor({
    refundLocktime,
    nowSeconds,
    orderMarginSeconds: orderMargin,
    ...(params.minClaimWindowSeconds !== undefined ? { minClaimWindowSeconds: params.minClaimWindowSeconds } : {}),
  })
  if (evmTimeout === null) {
    // `evmTimeoutFor` answers null exactly when no safe value exists. Re-run the
    // evaluation to recover WHICH rule bit, so the refusal names it instead of
    // collapsing every cause into one opaque reason.
    const decision = evaluateEvmSendLock({
      evmTimeout: refundLocktime - orderMargin,
      refundLocktime,
      nowSeconds,
      orderMarginSeconds: orderMargin,
      ...(params.minClaimWindowSeconds !== undefined ? { minClaimWindowSeconds: params.minClaimWindowSeconds } : {}),
    })
    return { accept: false, reason: decision.ok ? 'deadlines_cannot_be_ordered' : decision.reason }
  }
  return { accept: true, refundLocktime, evmTimeout }
}
