import { describe, it, expect } from 'vitest'
import {
  EVM_MIN_CLAIM_WINDOW_SECONDS,
  EVM_ORDER_MARGIN_SECONDS,
  evaluateEvmSendLock,
  evmTimeoutFor,
} from '@arkade-os/solver-core/core/evmSend.js'
import {
  EVM_MAX_CLIENT_TIMEOUT_SECONDS,
  arkadeRefundLocktimeFor,
  evaluateEvmReceiveFund,
  type EvmReceiveFundParams,
} from '@arkade-os/solver-core/core/evmReceive.js'

const NOW = 1_800_000_000
const HOUR = 3600

/** A comfortable quote: the client's lock runs a day, so both bounds have room. */
const params = (over: Partial<EvmReceiveFundParams> = {}): EvmReceiveFundParams => ({
  evmTimeout: NOW + 24 * HOUR,
  refundLocktime: NOW + 12 * HOUR,
  nowSeconds: NOW,
  ...over,
})

describe('evaluateEvmReceiveFund', () => {
  it('funds against a lock with room at both ends', () => {
    expect(evaluateEvmReceiveFund(params())).toEqual({ ok: true })
  })

  /**
   * "Expired" is not the same as "past".
   *
   * A lock with less than our own recourse margin left is already useless: even
   * an instant claim leaves no time to collect the tokens. Funding against one
   * buys an obligation with no way to be paid for it.
   */
  it('refuses a lock with less than the margin left, not merely an expired one', () => {
    expect(evaluateEvmReceiveFund(params({ evmTimeout: NOW - 1 }))).toEqual({ ok: false, reason: 'evm_lock_expired' })
    const barelyAlive = NOW + EVM_ORDER_MARGIN_SECONDS
    expect(evaluateEvmReceiveFund(params({ evmTimeout: barelyAlive }))).toEqual({
      ok: false,
      reason: 'evm_lock_expired',
    })
  })

  it('refuses when the client would not have time to claim', () => {
    const tooSoon = NOW + EVM_MIN_CLAIM_WINDOW_SECONDS - 1
    expect(evaluateEvmReceiveFund(params({ refundLocktime: tooSoon }))).toEqual({
      ok: false,
      reason: 'client_claim_window_too_short',
    })
  })

  /** The one the solver's capital depends on, in this direction. */
  it('refuses when our token claim would land after the client could refund', () => {
    const tooLate = NOW + 24 * HOUR - EVM_ORDER_MARGIN_SECONDS + 1
    expect(evaluateEvmReceiveFund(params({ refundLocktime: tooLate }))).toEqual({
      ok: false,
      reason: 'recourse_after_evm_timeout',
    })
  })

  it('accepts landing exactly on the margin', () => {
    const exactly = NOW + 24 * HOUR - EVM_ORDER_MARGIN_SECONDS
    expect(evaluateEvmReceiveFund(params({ refundLocktime: exactly }))).toEqual({ ok: true })
  })

  it('refuses a deadline past the serving horizon, and serves exactly at it', () => {
    // The mirror of MAX_REFUND_HORIZON on the BTC legs: a lock years out is a
    // claim on the solver's sats at one fixed rate for as long. The boundary
    // is inclusive — a 24h lock is served, a second past it is not.
    expect(EVM_MAX_CLIENT_TIMEOUT_SECONDS).toBe(24 * HOUR)
    expect(evaluateEvmReceiveFund(params({ evmTimeout: NOW + 24 * HOUR }))).toEqual({ ok: true })
    expect(evaluateEvmReceiveFund(params({ evmTimeout: NOW + 24 * HOUR + 1 }))).toEqual({
      ok: false,
      reason: 'evm_timeout_too_far_out',
    })
  })

  it('names an unsatisfiable quote distinctly from a badly chosen deadline', () => {
    const cramped = params({
      evmTimeout: NOW + EVM_ORDER_MARGIN_SECONDS + EVM_MIN_CLAIM_WINDOW_SECONDS - 1,
      refundLocktime: NOW + HOUR,
    })
    expect(evaluateEvmReceiveFund(cramped)).toEqual({ ok: false, reason: 'deadlines_cannot_be_ordered' })
  })

  it('reports the expired lock even when the quote is also unsatisfiable', () => {
    // Both conditions hold at once. The expired lock wins because it is wrong
    // for every solver, while an unorderable quote is wrong for this policy —
    // the send gate's ordering, mirrored. Relaxing the first check to `<` would
    // flip the answer and no other case here would notice.
    const both = params({ evmTimeout: NOW + EVM_ORDER_MARGIN_SECONDS, refundLocktime: NOW + HOUR })
    expect(evaluateEvmReceiveFund(both)).toEqual({ ok: false, reason: 'evm_lock_expired' })
  })

  it('treats the margin as policy, not a constant baked into the rule', () => {
    // The send suite's equivalent. Both boundaries, so a forwarding typo in the
    // destructure cannot hide behind the default.
    const at = NOW + 24 * HOUR - HOUR
    expect(evaluateEvmReceiveFund(params({ refundLocktime: at, orderMarginSeconds: 30 * 60 }))).toEqual({ ok: true })
    expect(evaluateEvmReceiveFund(params({ refundLocktime: at, orderMarginSeconds: 2 * HOUR }))).toEqual({
      ok: false,
      reason: 'recourse_after_evm_timeout',
    })
  })

  it('treats the claim window as policy too, at both sides of its boundary', () => {
    const at = NOW + HOUR
    expect(evaluateEvmReceiveFund(params({ refundLocktime: at, minClaimWindowSeconds: HOUR }))).toEqual({ ok: true })
    expect(evaluateEvmReceiveFund(params({ refundLocktime: at, minClaimWindowSeconds: HOUR + 1 }))).toEqual({
      ok: false,
      reason: 'client_claim_window_too_short',
    })
  })

  /**
   * The wiring check, and it bites harder on this leg: `evmTimeout` is the
   * CLIENT's number, read off the wire as a block height and converted a few
   * frames earlier. An unconverted height reaches the first gate as a tiny
   * integer and comes back `evm_lock_expired`, which reads as a stale quote
   * rather than as the conversion that never happened.
   */
  it.each([
    ['refundLocktime', { refundLocktime: 850_000 }, /refundLocktime 850000 is below LOCKTIME_THRESHOLD/],
    ['evmTimeout', { evmTimeout: 850_000 }, /evmTimeout 850000 is below LOCKTIME_THRESHOLD/],
  ])('throws on a %s that is really a block height', (_field, over, message) => {
    expect(() => evaluateEvmReceiveFund(params(over))).toThrow(message)
  })
})

describe('arkadeRefundLocktimeFor', () => {
  it('proposes the latest safe value, giving the client every second it can', () => {
    expect(arkadeRefundLocktimeFor(params())).toBe(NOW + 24 * HOUR - EVM_ORDER_MARGIN_SECONDS)
  })

  it('proposes something its own gate accepts', () => {
    const proposed = arkadeRefundLocktimeFor(params())
    expect(proposed).not.toBeNull()
    expect(evaluateEvmReceiveFund(params({ refundLocktime: proposed! }))).toEqual({ ok: true })
  })

  it('returns null rather than an unsafe proposal when no value works', () => {
    expect(arkadeRefundLocktimeFor(params({ evmTimeout: NOW + 60 }))).toBeNull()
  })
})

/**
 * The two directions are mirrors, and the mirror is the point.
 *
 * Written as separate modules on purpose — the roles, the capital at risk and
 * the party choosing each deadline all differ — but the arithmetic must stay
 * symmetric, and these are the tests that would catch one drifting from the
 * other.
 */
describe('send and receive are mirrors of one another', () => {
  it('orders the same pair of deadlines in opposite directions', () => {
    // One pair of numbers, read by both gates. Whichever side goes SECOND with
    // its own money is the side whose deadline must come first.
    const early = NOW + 4 * HOUR
    const late = NOW + 24 * HOUR

    // Send: the solver locks second on EVM, so the EVM timeout is the early one.
    expect(evaluateEvmSendLock({ evmTimeout: early, refundLocktime: late, nowSeconds: NOW })).toEqual({ ok: true })
    expect(evaluateEvmSendLock({ evmTimeout: late, refundLocktime: early, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'recourse_after_refund_deadline',
    })

    // Receive: the solver funds Arkade second, so Arkade is the early one —
    // exactly inverted.
    expect(evaluateEvmReceiveFund({ evmTimeout: late, refundLocktime: early, nowSeconds: NOW })).toEqual({ ok: true })
    expect(evaluateEvmReceiveFund({ evmTimeout: early, refundLocktime: late, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'recourse_after_evm_timeout',
    })
  })

  it('has each side propose a deadline the OTHER side would also call safe', () => {
    // Both proposers leave exactly the margin, so a deadline proposed by one
    // gate is orderable by the other with the roles swapped. If either drifted
    // — a different margin, or a floor instead of a ceiling — this diverges.
    const fixed = NOW + 24 * HOUR

    // Send proposes an evmTimeout against a fixed refundLocktime.
    const sendProposal = evmTimeoutFor({ refundLocktime: fixed, nowSeconds: NOW })
    // Receive proposes a refundLocktime against a fixed evmTimeout.
    const receiveProposal = arkadeRefundLocktimeFor({ evmTimeout: fixed, nowSeconds: NOW })

    expect(sendProposal).not.toBeNull()
    expect(receiveProposal).toBe(sendProposal)
    expect(fixed - sendProposal!).toBe(EVM_ORDER_MARGIN_SECONDS)
  })
})
