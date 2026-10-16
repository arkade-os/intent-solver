import { UNILATERAL_RECOURSE_MARGIN } from '@arkade-os/solver-core/core/receive.js'
import { NOMINAL_BLOCK_SECONDS } from '@arkade-os/solver-core/core/timelocks.js'
import { describe, it, expect } from 'vitest'
import {
  ONCHAIN_SECONDS_PER_BLOCK,
  MAX_MIN_CONFIRMATIONS,
  MIN_MIN_CONFIRMATIONS,
  DEFAULT_MIN_CONFIRMATIONS,
  clampMinConfirmations,
  MIN_SETTLE_WINDOW,
  SETTLE_SAFETY_MARGIN,
  MIN_ARKADE_FUND_WINDOW,
  DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT,
  SLOW_BLOCK_ALLOWANCE,
  onchainReceiveFundingBudget,
  htlcLocktimeFor,
  arkadeRefundLocktimeFor,
  onchainReceiveClaimWindow,
  evaluateOnchainReceiveAcceptance,
  evaluateOnchainReceiveFunding,
} from '@arkade-os/solver-core/core/onchainReceive.js'

const now = 1_800_000_000

const fundingAt = (minConfirmations: number, at: number) =>
  evaluateOnchainReceiveFunding({
    arkadeRefundLocktime: arkadeRefundLocktimeFor(minConfirmations, now),
    htlcLocktime: htlcLocktimeFor(minConfirmations, now),
    // A 2h exit ladder, which this leg's own htlcLocktime clears at every depth.
    unilateralRefundWithoutReceiverDelay: 2 * 3600,
    now: at,
  })

// ABSOLUTE MINUTES, deliberately: every other test here is written in terms of the
// constants and so follows them wherever they go. Changing these is the #160 decision.
describe('the deadlines this leg quotes', () => {
  it.each([
    ['default (1 confirmation)', DEFAULT_MIN_CONFIRMATIONS, 155, 245],
    ['maximum (6 confirmations)', MAX_MIN_CONFIRMATIONS, 255, 345],
  ])('at %s: arkade refund +%s min, onchain htlc +%s min', (_label, minConfirmations, refundMin, htlcMin) => {
    expect(arkadeRefundLocktimeFor(minConfirmations, now)).toBe(now + refundMin * 60)
    expect(htlcLocktimeFor(minConfirmations, now)).toBe(now + htlcMin * 60)
  })

  it.each([DEFAULT_MIN_CONFIRMATIONS, 3, MAX_MIN_CONFIRMATIONS])('leaves 90 minutes to claim at %s conf', (depth) => {
    expect(onchainReceiveClaimWindow(depth, now)).toBe(90 * 60)
    expect(onchainReceiveClaimWindow(depth, now)).toBe(MIN_SETTLE_WINDOW)
    expect(onchainReceiveClaimWindow(depth, now)).toBeGreaterThanOrEqual(SETTLE_SAFETY_MARGIN)
  })
})

// THE DEFECT #160 CLOSED: against a `now + 2h` refund, the gate below opened for
// 30 minutes, in which the client had to broadcast AND reach min_confirmations.
describe('the client has the whole funding budget to confirm in', () => {
  it.each([
    ['default (1 confirmation)', DEFAULT_MIN_CONFIRMATIONS, 65],
    ['maximum (6 confirmations)', MAX_MIN_CONFIRMATIONS, 165],
  ])('is %s minutes at %s', (_label, minConfirmations, expectedMinutes) => {
    expect(onchainReceiveFundingBudget(minConfirmations)).toBe(expectedMinutes * 60)
  })

  it.each([DEFAULT_MIN_CONFIRMATIONS, 3, MAX_MIN_CONFIRMATIONS])(
    'funds through the last second of the budget at %s conf, and refuses after it',
    (depth) => {
      const budget = onchainReceiveFundingBudget(depth)
      expect(fundingAt(depth, now + budget - 1)).toEqual({ fund: true })
      expect(fundingAt(depth, now + budget)).toEqual({
        fund: false,
        reason: 'refused to fund: arkade refund window closing',
      })
    },
  )

  it('covers a broadcast at the lockup deadline plus twice the expected confirmation wait', () => {
    for (const depth of [DEFAULT_MIN_CONFIRMATIONS, 3, MAX_MIN_CONFIRMATIONS]) {
      const broadcastAt = now + DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT
      const confirmedAt = broadcastAt + 2 * depth * ONCHAIN_SECONDS_PER_BLOCK
      expect(fundingAt(depth, confirmedAt)).toEqual({ fund: true })
      expect(onchainReceiveFundingBudget(depth) - (confirmedAt - now)).toBe(SLOW_BLOCK_ALLOWANCE)
    }
  })
})

describe('htlcLocktimeFor', () => {
  it('sits one MIN_SETTLE_WINDOW past the arkade refund', () => {
    expect(htlcLocktimeFor(1, now)).toBe(arkadeRefundLocktimeFor(1, now) + MIN_SETTLE_WINDOW)
  })

  it('scales with minConfirmations at twice the block interval', () => {
    expect(htlcLocktimeFor(6, now) - htlcLocktimeFor(1, now)).toBe(2 * 5 * ONCHAIN_SECONDS_PER_BLOCK)
  })
})

describe('arkadeRefundLocktimeFor', () => {
  it('leaves a full MIN_ARKADE_FUND_WINDOW after the budget closes', () => {
    for (const depth of [1, 3, 6]) {
      expect(arkadeRefundLocktimeFor(depth, now)).toBe(
        now + onchainReceiveFundingBudget(depth) + MIN_ARKADE_FUND_WINDOW,
      )
    }
  })

  it('always leaves the arkade refund strictly before the onchain htlcLocktime', () => {
    for (const minConfirmations of [1, 3, 6]) {
      expect(arkadeRefundLocktimeFor(minConfirmations, now)).toBeLessThan(htlcLocktimeFor(minConfirmations, now))
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
    expect(result.arkadeRefundLocktime).toBe(arkadeRefundLocktimeFor(DEFAULT_MIN_CONFIRMATIONS, now))
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
   * The unilateral-gap timeline, on this corridor: with the Arkade server gone the trader's
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

  it('reads a BLOCK-typed solo recourse in seconds, so the gate still binds', () => {
    // 20 blocks is 12000s; added raw to a unix timestamp it reads as 20.
    const result = evaluateOnchainReceiveFunding(
      fundingInput({
        unilateralRefundWithoutReceiverDelay: 20,
        htlcLocktime: now + 20 * NOMINAL_BLOCK_SECONDS,
      }),
    )
    expect(result).toEqual({
      fund: false,
      reason: 'refused to fund: solver unilateral recourse opens after the onchain htlc timeout',
    })
  })
})

/**
 * TLA+ finding F2, on the leg it was written against. Zero is the
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
