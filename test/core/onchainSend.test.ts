import { describe, it, expect } from 'vitest'
import {
  htlcLocktimeFor,
  onchainRefundLocktimeFor,
  evaluateOnchainSendAcceptance,
  evaluateOnchainSendFunding,
  latestClaimArrival,
  ARKADE_CLAIM_WINDOW_SECONDS,
  ONCHAIN_SECONDS_PER_BLOCK,
  ONCHAIN_CLAIM_MARGIN_SECONDS,
  ONCHAIN_ORDER_MARGIN_SECONDS,
  MAX_MIN_CONFIRMATIONS,
  MIN_MIN_CONFIRMATIONS,
  DEFAULT_MIN_CONFIRMATIONS,
  clampMinConfirmations,
} from '@arkade-os/solver-core/core/onchainSend.js'
import { HOUR } from '@arkade-os/solver-core/core/timelocks.js'

describe('htlcLocktimeFor', () => {
  it('clears the client-side claim_window_too_short guardrail with margin to spare', () => {
    const now = 1_000_000
    const minConfirmations = 1
    const htlcLocktime = htlcLocktimeFor(minConfirmations, now)
    const bareMinimum = now + minConfirmations * ONCHAIN_SECONDS_PER_BLOCK + ONCHAIN_CLAIM_MARGIN_SECONDS
    expect(htlcLocktime).toBeGreaterThan(bareMinimum)
  })
})

describe('onchainRefundLocktimeFor', () => {
  it('clears the client-side timelock_order guardrail with margin to spare', () => {
    const now = 1_000_000
    const htlcLocktime = now + 10_000
    const unilateralClaimDelay = 512
    const refundLocktime = onchainRefundLocktimeFor(htlcLocktime, unilateralClaimDelay, now)
    expect(refundLocktime).toBeGreaterThan(htlcLocktime + ONCHAIN_ORDER_MARGIN_SECONDS)
  })

  it('the server-independent bound dominates when the htlc locktime is soon', () => {
    const now = 1_000_000
    const locktime = onchainRefundLocktimeFor(now + 1, 7 * 24 * 3600, now)
    expect(locktime).toBe(now + 7 * 24 * 3600 + ONCHAIN_ORDER_MARGIN_SECONDS)
  })

  /**
   * TLA+ finding F7 (#104). The client's L1 claim leaf carries no timelock, so
   * a claim can arrive at the very last instant — `htlcLocktime` plus the MTP
   * margin the solver waits out. From there the solver must claim the Arkade
   * lockup before `refundLocktime`, or the client takes it back on the refund
   * leaf and collects both legs.
   *
   * This is the guarantee, and it is asserted across a spread of inputs rather
   * than at one point, because the three bounds take turns dominating and the
   * invariant has to survive all of them.
   */
  it('always leaves room to answer a claim that arrives at the last instant', () => {
    const now = 1_000_000
    for (const htlcOffset of [1, 60, 3_600, 10_000, 86_400, 30 * 86_400]) {
      for (const unilateralClaimDelay of [0, 512, 4_096, 7 * 24 * 3_600]) {
        const htlcLocktime = now + htlcOffset
        const refundLocktime = onchainRefundLocktimeFor(htlcLocktime, unilateralClaimDelay, now)
        expect(
          refundLocktime - latestClaimArrival(htlcLocktime),
          `htlc +${htlcOffset}s, delay ${unilateralClaimDelay}s`,
        ).toBeGreaterThanOrEqual(ARKADE_CLAIM_WINDOW_SECONDS)
      }
    }
  })

  /**
   * And the slack that makes it free today, stated so a future edit can see
   * what it is spending. The chain bound (`+2 * ONCHAIN_ORDER_MARGIN_SECONDS`)
   * currently wins by an hour over the claim-answer bound, which is why adding
   * that bound changed no quote. Shrink either margin and the claim-answer
   * bound starts to bind — which is the whole point of it existing.
   */
  it('records the margin the chain bound currently wins by', () => {
    const now = 1_000_000
    const htlcLocktime = now + 10_000
    const chainBound = htlcLocktime + 2 * ONCHAIN_ORDER_MARGIN_SECONDS
    const claimAnswerBound = latestClaimArrival(htlcLocktime) + ARKADE_CLAIM_WINDOW_SECONDS
    expect(chainBound - claimAnswerBound).toBe(HOUR)
    expect(onchainRefundLocktimeFor(htlcLocktime, 512, now)).toBe(chainBound)
  })
})

describe('evaluateOnchainSendAcceptance', () => {
  const limits = { minSats: 1_000, maxSats: 1_000_000 }
  const base = { amountSats: 50_000, limits, unilateralClaimDelay: 512, now: 1_000_000 }

  it('accepts an in-range amount and returns fields that satisfy the client guardrail', () => {
    const result = evaluateOnchainSendAcceptance(base)
    expect(result.accept).toBe(true)
    if (result.accept) {
      expect(result.refundLocktime).toBeGreaterThan(result.htlcLocktime + ONCHAIN_ORDER_MARGIN_SECONDS)
      expect(result.minConfirmations).toBeGreaterThanOrEqual(1)
      expect(result.minConfirmations).toBeLessThanOrEqual(6)
    }
  })

  it('refuses an amount below the minimum', () => {
    const result = evaluateOnchainSendAcceptance({ ...base, amountSats: 500 })
    expect(result).toEqual({ accept: false, reason: 'amount_out_of_range' })
  })

  it('refuses an amount above the maximum', () => {
    const result = evaluateOnchainSendAcceptance({ ...base, amountSats: 2_000_000 })
    expect(result).toEqual({ accept: false, reason: 'amount_out_of_range' })
  })
})

describe('evaluateOnchainSendFunding', () => {
  it('funds when enough of the refund window remains', () => {
    const result = evaluateOnchainSendFunding({ refundLocktime: 1_000_000 + 3 * 3600, now: 1_000_000 })
    expect(result).toEqual({ fund: true })
  })

  it('refuses to fund inside the minimum claim window before the client refund opens', () => {
    const result = evaluateOnchainSendFunding({ refundLocktime: 1_000_000 + 60, now: 1_000_000 })
    expect(result.fund).toBe(false)
  })
})

/**
 * TLA+ finding F2 (#38). Only the CEILING was applied, so a zero or negative
 * confirmation depth passed straight through — and zero means funding against
 * a transaction that is still replaceable. Unreachable from today's wire
 * schema, which is why it was ranked low; the clamp belongs at the domain
 * boundary regardless, because the wire is not the only caller this will have.
 */
describe('clampMinConfirmations', () => {
  it('refuses to accept a zero-confirmation depth', () => {
    expect(clampMinConfirmations(0)).toBe(MIN_MIN_CONFIRMATIONS)
  })

  it('refuses a negative depth, which would shorten the quoted deadline', () => {
    // Not merely invalid: `htlcLocktimeFor` multiplies it, so a negative value
    // moves the client's deadline the WRONG WAY rather than just being ignored.
    expect(clampMinConfirmations(-3)).toBe(MIN_MIN_CONFIRMATIONS)
    expect(htlcLocktimeFor(clampMinConfirmations(-3), 1_000_000)).toBeGreaterThan(1_000_000)
  })

  it('still applies the ceiling it always did', () => {
    expect(clampMinConfirmations(99)).toBe(MAX_MIN_CONFIRMATIONS)
  })

  it('takes the default for absent or non-finite input', () => {
    // NaN is the one that matters: it survives both Math.min and Math.max, so
    // without an explicit test it would reach the row as an uncomputable depth.
    expect(clampMinConfirmations(undefined)).toBe(DEFAULT_MIN_CONFIRMATIONS)
    expect(clampMinConfirmations(Number.NaN)).toBe(DEFAULT_MIN_CONFIRMATIONS)
    expect(clampMinConfirmations(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MIN_CONFIRMATIONS)
  })

  it('truncates a fraction rather than rounding it up', () => {
    // Rounding up would over-deliver against the client's own guardrail
    // arithmetic, which is computed from the integer we publish.
    expect(clampMinConfirmations(2.9)).toBe(2)
  })

  it('is what the quote path actually uses', () => {
    // The clamp is worthless if the caller kept its own copy of the old
    // expression, so this asserts through `evaluateOnchainSendAcceptance`.
    const result = evaluateOnchainSendAcceptance({
      amountSats: 50_000,
      limits: { minSats: 1_000, maxSats: 1_000_000 },
      unilateralClaimDelay: 512,
      now: 1_000_000,
      minConfirmations: 0,
    })
    expect(result.accept).toBe(true)
    if (result.accept) expect(result.minConfirmations).toBe(MIN_MIN_CONFIRMATIONS)
  })
})
