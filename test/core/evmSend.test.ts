import { describe, it, expect } from 'vitest'
import {
  EVM_MIN_CLAIM_WINDOW_SECONDS,
  EVM_ORDER_MARGIN_SECONDS,
  evaluateEvmSendLock,
  evmTimeoutFor,
  type EvmSendLockParams,
} from '@arkade-os/solver-core/core/evmSend.js'

const NOW = 1_800_000_000
const HOUR = 3600

/** A comfortable quote: the Arkade refund is a day out, so both bounds have room. */
const params = (over: Partial<EvmSendLockParams> = {}): EvmSendLockParams => ({
  evmTimeout: NOW + 12 * HOUR,
  refundLocktime: NOW + 24 * HOUR,
  nowSeconds: NOW,
  ...over,
})

describe('evaluateEvmSendLock', () => {
  it('accepts a timeout comfortably inside both bounds', () => {
    expect(evaluateEvmSendLock(params())).toEqual({ ok: true })
  })

  it('refuses a timeout already behind us', () => {
    expect(evaluateEvmSendLock(params({ evmTimeout: NOW - 1 }))).toEqual({
      ok: false,
      reason: 'evm_timeout_in_past',
    })
  })

  it('refuses when the client would not have time to claim', () => {
    const tooSoon = NOW + EVM_MIN_CLAIM_WINDOW_SECONDS - 1
    expect(evaluateEvmSendLock(params({ evmTimeout: tooSoon }))).toEqual({
      ok: false,
      reason: 'claim_window_too_short',
    })
  })

  /**
   * The one the solver's money depends on.
   *
   * A client claiming at the last moment before `evmTimeout` reveals the
   * preimage only then, and the solver still has to get its Arkade claim
   * confirmed before `refundLocktime`. Too close and the client takes the
   * tokens AND, once the refund opens, its BTC.
   */
  it('refuses when our own recourse would open too late', () => {
    const tooLate = NOW + 24 * HOUR - EVM_ORDER_MARGIN_SECONDS + 1
    expect(evaluateEvmSendLock(params({ evmTimeout: tooLate }))).toEqual({
      ok: false,
      reason: 'recourse_after_refund_deadline',
    })
  })

  it('accepts landing exactly on the margin, which is the margin doing its job', () => {
    const exactly = NOW + 24 * HOUR - EVM_ORDER_MARGIN_SECONDS
    expect(evaluateEvmSendLock(params({ evmTimeout: exactly }))).toEqual({ ok: true })
  })

  it('accepts landing exactly on the minimum claim window', () => {
    const exactly = NOW + EVM_MIN_CLAIM_WINDOW_SECONDS
    // Needs a refundLocktime far enough out that this is not also too late.
    expect(evaluateEvmSendLock(params({ evmTimeout: exactly, refundLocktime: NOW + 48 * HOUR }))).toEqual({ ok: true })
  })

  it('names an unsatisfiable quote distinctly from a badly chosen timeout', () => {
    // The Arkade refund is so soon that the margin and the claim window cannot
    // both fit. No `evmTimeout` works, so reporting one of the two tunable
    // refusals would send an operator chasing a knob that cannot help.
    const cramped = params({
      refundLocktime: NOW + EVM_ORDER_MARGIN_SECONDS + EVM_MIN_CLAIM_WINDOW_SECONDS - 1,
      evmTimeout: NOW + HOUR,
    })
    expect(evaluateEvmSendLock(cramped)).toEqual({ ok: false, reason: 'deadlines_cannot_be_ordered' })
  })

  it('reports the past-timeout case even when the quote is also unsatisfiable', () => {
    // Ordering: the most structural thing wrong wins. A timeout behind us is
    // wrong for every solver; an unorderable quote is wrong for this one's
    // policy.
    const both = params({ refundLocktime: NOW + 60, evmTimeout: NOW - 1 })
    expect(evaluateEvmSendLock(both)).toEqual({ ok: false, reason: 'evm_timeout_in_past' })
  })

  it('treats the margin as policy, not a constant baked into the rule', () => {
    const at = NOW + 24 * HOUR - HOUR
    expect(evaluateEvmSendLock(params({ evmTimeout: at, orderMarginSeconds: 30 * 60 }))).toEqual({ ok: true })
    expect(evaluateEvmSendLock(params({ evmTimeout: at, orderMarginSeconds: 2 * HOUR }))).toEqual({
      ok: false,
      reason: 'recourse_after_refund_deadline',
    })
  })
})

describe('evmTimeoutFor', () => {
  it('proposes the latest safe value, giving the client every second it can', () => {
    // Deliberately not the earliest: claim time matters on a corridor where
    // the client may have to obtain gas first, and the margin already covers
    // our own recourse.
    expect(evmTimeoutFor(params())).toBe(NOW + 24 * HOUR - EVM_ORDER_MARGIN_SECONDS)
  })

  it('proposes something its own gate accepts', () => {
    const proposed = evmTimeoutFor(params())
    expect(proposed).not.toBeNull()
    expect(evaluateEvmSendLock(params({ evmTimeout: proposed! }))).toEqual({ ok: true })
  })

  it('returns null rather than an unsafe proposal when no value works', () => {
    // A caller must not be able to lift a deadline out of a quote that cannot
    // be served — that is how an unsafe lock gets funded from a refused quote.
    expect(evmTimeoutFor(params({ refundLocktime: NOW + 60 }))).toBeNull()
  })

  it('honours an overridden margin', () => {
    expect(evmTimeoutFor(params({ orderMarginSeconds: HOUR }))).toBe(NOW + 23 * HOUR)
  })
})
