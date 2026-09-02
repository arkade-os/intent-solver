import { UNILATERAL_RECOURSE_MARGIN } from '@arkade-os/solver-core/core/receive.js'
import { describe, it, expect } from 'vitest'
import {
  ONCHAIN_SECONDS_PER_BLOCK,
  MAX_MIN_CONFIRMATIONS,
  MIN_MIN_CONFIRMATIONS,
  DEFAULT_MIN_CONFIRMATIONS,
  clampMinConfirmations,
  MIN_SETTLE_WINDOW,
  SETTLE_SAFETY_MARGIN,
  MAX_REFUND_HORIZON,
  MIN_ARKADE_FUND_WINDOW,
  htlcLocktimeFor,
  arkadeRefundLocktimeFor,
  onchainReceiveClaimWindow,
  evaluateOnchainReceiveAcceptance,
  evaluateOnchainReceiveFunding,
} from '@arkade-os/solver-core/core/onchainReceive.js'

const now = 1_800_000_000

/**
 * The solver's own window to get an L1 claim confirmed after a late Arkade
 * claim reveals `P` — the one deadline on this leg whose miss costs real money
 * rather than a failed swap (#141).
 *
 * Pinned in ABSOLUTE MINUTES, deliberately, and this is the whole point of the
 * block. Every other test here is written in terms of the constants, so it
 * follows them wherever they go and can never notice that they moved. This
 * window is not configured anywhere: it is what `MAX_REFUND_HORIZON` happens to
 * leave over once it out-binds `htlcLocktime - SETTLE_SAFETY_MARGIN`, which it
 * does across the entire reachable input range. Raising the horizon shrinks the
 * window toward `SETTLE_SAFETY_MARGIN` = 15 minutes, and nothing said so.
 *
 * If these numbers change, that is a decision about how long an L1 claim needs,
 * and #141 is where it gets made — not a constant nudge with a side effect.
 */
describe('the L1 claim window this leg actually gives the solver', () => {
  it.each([
    ['default (1 confirmation)', DEFAULT_MIN_CONFIRMATIONS, 70],
    ['maximum (6 confirmations)', MAX_MIN_CONFIRMATIONS, 120],
  ])('is %s minutes at %s', (_label, minConfirmations, expectedMinutes) => {
    expect(onchainReceiveClaimWindow(minConfirmations, now)).toBe(expectedMinutes * 60)
  })

  it('is supplied by the CAP, not by the documented margin', () => {
    // The branch the JSDoc describes would leave SETTLE_SAFETY_MARGIN. It never
    // runs, so the window is 4.6x wider than the formula reads. Asserted rather
    // than described, because a future change that makes the first bound bind
    // would silently cut the window to 15 minutes and every other test here
    // would still pass.
    for (const minConfirmations of [DEFAULT_MIN_CONFIRMATIONS, MAX_MIN_CONFIRMATIONS]) {
      const htlcLocktime = htlcLocktimeFor(minConfirmations, now)
      expect(arkadeRefundLocktimeFor(htlcLocktime, now)).toBe(now + MAX_REFUND_HORIZON)
      expect(onchainReceiveClaimWindow(minConfirmations, now)).toBeGreaterThan(SETTLE_SAFETY_MARGIN)
    }
  })

  /**
   * The DEFAULT configuration is already below this module's own figure, and
   * that is the live substance of #141 rather than a hypothetical.
   *
   * `MIN_SETTLE_WINDOW` = 90 minutes is what this file says noticing a
   * preimage, settling and retrying takes. An L1 claim has neither a retry nor
   * fee-bump room, so it is the weaker case, not the stronger one — and at one
   * confirmation it gets 70.
   *
   * Asserted in BOTH directions on purpose. An earlier version of this block
   * checked the floor only at `MAX_MIN_CONFIRMATIONS`, where it holds, and read
   * as though the floor held everywhere. Pinning only the case that passes is
   * how a contradiction stays invisible — which is the exact failure this whole
   * describe block exists to prevent, so it should not have been reproduced in
   * it.
   */
  it('clears the floor at six confirmations and does NOT at the default', () => {
    // 120 min >= 90 min.
    expect(onchainReceiveClaimWindow(MAX_MIN_CONFIRMATIONS, now)).toBeGreaterThanOrEqual(MIN_SETTLE_WINDOW)
    // 70 min < 90 min. Deliberately asserted as a FAILURE of the floor: if #141
    // resolves by making the documented SETTLE_SAFETY_MARGIN branch bind, this
    // line changes with it, and the change is the decision being recorded.
    expect(onchainReceiveClaimWindow(DEFAULT_MIN_CONFIRMATIONS, now)).toBeLessThan(MIN_SETTLE_WINDOW)
  })
})

describe('htlcLocktimeFor', () => {
  it('covers the confirmation wait plus double the settle margin', () => {
    const result = htlcLocktimeFor(1, now)
    expect(result).toBe(now + 1 * ONCHAIN_SECONDS_PER_BLOCK + 2 * MIN_SETTLE_WINDOW)
  })

  it('scales with minConfirmations', () => {
    const one = htlcLocktimeFor(1, now)
    const six = htlcLocktimeFor(6, now)
    expect(six - one).toBe(5 * ONCHAIN_SECONDS_PER_BLOCK)
  })
})

describe('arkadeRefundLocktimeFor', () => {
  it('opens SETTLE_SAFETY_MARGIN before the onchain htlcLocktime when that is the binding bound', () => {
    const htlcLocktime = now + 10 * MAX_REFUND_HORIZON // push the chain bound far out so MAX_REFUND_HORIZON binds instead — see next test
    const result = arkadeRefundLocktimeFor(htlcLocktime, now)
    expect(result).toBe(now + MAX_REFUND_HORIZON)
  })

  it('caps at MAX_REFUND_HORIZON from now when htlcLocktime is far away', () => {
    const htlcLocktime = now + MAX_REFUND_HORIZON + 10 * SETTLE_SAFETY_MARGIN
    const result = arkadeRefundLocktimeFor(htlcLocktime, now)
    expect(result).toBe(now + MAX_REFUND_HORIZON)
  })

  it('is bounded by htlcLocktime - SETTLE_SAFETY_MARGIN when that is tighter than the horizon cap', () => {
    const htlcLocktime = now + MIN_SETTLE_WINDOW // close by, well inside MAX_REFUND_HORIZON
    const result = arkadeRefundLocktimeFor(htlcLocktime, now)
    expect(result).toBe(htlcLocktime - SETTLE_SAFETY_MARGIN)
  })

  it('always leaves the arkade refund strictly before the onchain htlcLocktime', () => {
    for (const minConfirmations of [1, 3, 6]) {
      const htlcLocktime = htlcLocktimeFor(minConfirmations, now)
      const refundLocktime = arkadeRefundLocktimeFor(htlcLocktime, now)
      expect(refundLocktime).toBeLessThan(htlcLocktime)
    }
  })
})

describe('evaluateOnchainReceiveAcceptance', () => {
  const limits = { minSats: 1_000, maxSats: 1_000_000 }

  it('accepts a servable amount and derives both locktimes plus minConfirmations', () => {
    const result = evaluateOnchainReceiveAcceptance({ amountSats: 50_000, limits, now })
    expect(result.accept).toBe(true)
    if (!result.accept) throw new Error('expected acceptance')
    expect(result.minConfirmations).toBe(DEFAULT_MIN_CONFIRMATIONS)
    expect(result.htlcLocktime).toBe(htlcLocktimeFor(DEFAULT_MIN_CONFIRMATIONS, now))
    expect(result.arkadeRefundLocktime).toBe(arkadeRefundLocktimeFor(result.htlcLocktime, now))
    expect(result.lockupDeadline).toBeGreaterThan(now)
  })

  it('refuses an amount below the floor', () => {
    const result = evaluateOnchainReceiveAcceptance({ amountSats: 100, limits, now })
    expect(result).toEqual({ accept: false, reason: 'amount_out_of_range' })
  })

  it('refuses an amount above the ceiling', () => {
    const result = evaluateOnchainReceiveAcceptance({ amountSats: 10_000_000, limits, now })
    expect(result).toEqual({ accept: false, reason: 'amount_out_of_range' })
  })

  it('caps a requested minConfirmations at MAX_MIN_CONFIRMATIONS', () => {
    const result = evaluateOnchainReceiveAcceptance({ amountSats: 50_000, limits, now, minConfirmations: 99 })
    if (!result.accept) throw new Error('expected acceptance')
    expect(result.minConfirmations).toBe(MAX_MIN_CONFIRMATIONS)
  })

  it('honours a requested minConfirmations under the cap', () => {
    const result = evaluateOnchainReceiveAcceptance({ amountSats: 50_000, limits, now, minConfirmations: 3 })
    if (!result.accept) throw new Error('expected acceptance')
    expect(result.minConfirmations).toBe(3)
  })
})

describe('evaluateOnchainReceiveFunding', () => {
  // A ladder and an htlc timeout that clear the unilateral gate comfortably, so
  // these cases keep testing the window they were written for.
  const LADDER = 6 * 3600
  const fundingInput = (over: Record<string, number> = {}) => ({
    arkadeRefundLocktime: now + MIN_ARKADE_FUND_WINDOW + 3600,
    htlcLocktime: now + LADDER + UNILATERAL_RECOURSE_MARGIN,
    unilateralRefundWithoutReceiverDelay: LADDER,
    now,
    ...over,
  })

  it('funds when comfortably inside the window', () => {
    expect(evaluateOnchainReceiveFunding(fundingInput())).toEqual({ fund: true })
  })

  it('refuses once inside MIN_ARKADE_FUND_WINDOW of the arkade refund deadline', () => {
    const result = evaluateOnchainReceiveFunding(
      fundingInput({ arkadeRefundLocktime: now + MIN_ARKADE_FUND_WINDOW - 1 }),
    )
    expect(result.fund).toBe(false)
  })

  it('refuses exactly at the boundary', () => {
    const result = evaluateOnchainReceiveFunding(fundingInput({ arkadeRefundLocktime: now + MIN_ARKADE_FUND_WINDOW }))
    expect(result.fund).toBe(false)
  })

  /**
   * #69's timeline, on this corridor: with the Arkade server gone the trader's
   * `unilateralClaim` opens before the solver's own leaf, so if the onchain
   * htlc times out first the trader can reclaim their onchain funds AND then
   * claim the Arkade payout.
   */
  it('refuses when the solver solo recourse opens after the onchain htlc timeout', () => {
    const result = evaluateOnchainReceiveFunding(fundingInput({ htlcLocktime: now + LADDER }))
    expect(result).toEqual({
      fund: false,
      reason: 'refused to fund: solver unilateral recourse opens after the onchain htlc timeout',
    })
  })

  it('refuses when the recourse opens before the htlc timeout but inside the margin', () => {
    const result = evaluateOnchainReceiveFunding(
      fundingInput({ htlcLocktime: now + LADDER + UNILATERAL_RECOURSE_MARGIN - 1 }),
    )
    expect(result.fund).toBe(false)
  })
})

/**
 * TLA+ finding F2 (#38), on the leg it was written against. Zero is the
 * dangerous value here: this leg waits for the CLIENT's onchain HTLC to
 * confirm before funding the Arkade side, so a zero-confirmation depth means
 * funding against a transaction that can still be replaced —
 * `OnchainReceive_ZeroConf.cfg` is the model configuration for exactly that.
 */
describe('clampMinConfirmations (onchain receive)', () => {
  it('never lets a quote be taken at zero confirmations', () => {
    expect(clampMinConfirmations(0)).toBe(MIN_MIN_CONFIRMATIONS)
    expect(clampMinConfirmations(-1)).toBe(MIN_MIN_CONFIRMATIONS)
  })

  it('keeps the ceiling, the default and the non-finite guard', () => {
    expect(clampMinConfirmations(99)).toBe(MAX_MIN_CONFIRMATIONS)
    expect(clampMinConfirmations(undefined)).toBe(DEFAULT_MIN_CONFIRMATIONS)
    expect(clampMinConfirmations(Number.NaN)).toBe(DEFAULT_MIN_CONFIRMATIONS)
  })

  it('is what the quote path actually uses', () => {
    const result = evaluateOnchainReceiveAcceptance({
      amountSats: 50_000,
      limits: { minSats: 1_000, maxSats: 1_000_000 },
      now: 1_000_000,
      minConfirmations: 0,
    })
    expect(result.accept).toBe(true)
    if (result.accept) expect(result.minConfirmations).toBe(MIN_MIN_CONFIRMATIONS)
  })
})
