import { describe, it, expect } from 'vitest'
import {
  refundWithoutReceiverDelayCovers,
  refundLocktimeFor,
  unilateralLadderFor,
  worstCaseHtlcBlocks,
  REFUND_SAFETY_MARGIN,
  ROUTE_CLTV_BUDGET_BLOCKS,
  SECONDS_PER_BLOCK,
} from '@arkade-os/solver-core/core/send.js'
import {
  MAX_BIP68_SECONDS,
  relativeDelayFrom,
  secondsForBlockRung,
  type UnilateralDelays,
} from '@arkade-os/solver-core/core/timelocks.js'

/**
 * The CLTV terms, with no route hint and an enforcing backend unless stated.
 *
 * One hint argument, applied to BOTH totals: every case here is about the
 * selected value, and the selection itself (`hintCltvBlocks`) is pinned in
 * `test/core/send.test.ts`.
 */
const cltvOf = (
  minFinalCltvBlocks: number,
  routeHintCltvBlocks = 0,
  routeCltvBudgetBlocks = ROUTE_CLTV_BUDGET_BLOCKS,
  enforcesRouteCltv = true,
) => ({
  minFinalCltvBlocks,
  worstRouteHintCltvBlocks: routeHintCltvBlocks,
  bestRouteHintCltvBlocks: routeHintCltvBlocks,
  routeCltvBudgetBlocks,
  enforcesRouteCltv,
})

const NOW = 1_800_000_000
// A small claim delay, so these cases exercise the HTLC bound rather than the
// unilateral one. The mainnet-scale case is asserted separately below.
const CLAIM_DELAY = 4096

/**
 * The property under test is a security boundary, not a formula.
 *
 * A client who supplies a hold invoice for their own node can keep our outbound
 * HTLC alive for the invoice's final CLTV delta plus whatever the route adds. If
 * their Arkade refund path opened before that, they would refund the lockup and
 * only then settle the Lightning payment — taking both sides.
 */
describe('refundLocktimeFor', () => {
  it('outlasts the worst-case life of the outbound HTLC', () => {
    for (const cltvBlocks of [18, 40, 144, 288]) {
      const refundAt = refundLocktimeFor(cltvOf(cltvBlocks), CLAIM_DELAY, NOW)
      const worstCaseHtlcResolvesAt = NOW + (cltvBlocks + ROUTE_CLTV_BUDGET_BLOCKS) * SECONDS_PER_BLOCK
      expect(refundAt).toBeGreaterThan(worstCaseHtlcResolvesAt)
    }
  })

  it('scales with the invoice, so a client cannot shorten it', () => {
    // The old behaviour was a constant `now + 2h` regardless of the invoice,
    // which is not a bound on anything the client chooses.
    expect(refundLocktimeFor(cltvOf(288), CLAIM_DELAY, NOW)).toBeGreaterThan(
      refundLocktimeFor(cltvOf(18), CLAIM_DELAY, NOW),
    )
  })

  it('never quotes a refund deadline inside the old fixed 2h window for a long CLTV', () => {
    // A default 18-block invoice already needs well over two hours of cover:
    // 162 blocks at 10 min/block is 27 hours.
    expect(refundLocktimeFor(cltvOf(18), CLAIM_DELAY, NOW)).toBeGreaterThan(NOW + 2 * 3600)
  })

  it('keeps a margin above the raw HTLC deadline', () => {
    const cltvBlocks = 18
    const raw = NOW + (cltvBlocks + ROUTE_CLTV_BUDGET_BLOCKS) * SECONDS_PER_BLOCK
    expect(refundLocktimeFor(cltvOf(cltvBlocks), CLAIM_DELAY, NOW) - raw).toBe(REFUND_SAFETY_MARGIN)
  })

  it('is monotonic in now', () => {
    expect(refundLocktimeFor(cltvOf(18), CLAIM_DELAY, NOW + 1)).toBe(
      refundLocktimeFor(cltvOf(18), CLAIM_DELAY, NOW) + 1,
    )
  })

  it('reserves exactly the CLTV window the backend is capped at, so the two cannot drift', () => {
    // The one property tying this deadline to the LND backend's enforced
    // ceiling: both read `worstCaseHtlcBlocks`. If a future edit gave the
    // adapter a looser ceiling than the deadline reserved, the outbound HTLC
    // could outlive the refund path -- reopening the double-collect window
    // this whole bound exists to close. Asserted here rather than in the
    // adapter's own tests because it is the DEADLINE's side of the contract.
    for (const cltvBlocks of [18, 40, 144, 288]) {
      const reserved = NOW + worstCaseHtlcBlocks(cltvOf(cltvBlocks)) * SECONDS_PER_BLOCK + REFUND_SAFETY_MARGIN
      expect(refundLocktimeFor(cltvOf(cltvBlocks), CLAIM_DELAY, NOW)).toBe(reserved)
    }
  })

  it('never lets the client refund before our server-independent claim matures', () => {
    // Both collaborative paths need the Arkade server. If it is unavailable, our
    // only recourse is unilateralClaim -- roughly seven days on mainnet. A
    // refund opening before that would let the client take back funds we had
    // already paid for, with no recourse left to us.
    const MAINNET_CLAIM_DELAY = 605184
    const refundAt = refundLocktimeFor(cltvOf(18), MAINNET_CLAIM_DELAY, NOW)
    expect(refundAt).toBeGreaterThan(NOW + MAINNET_CLAIM_DELAY)
  })
})

describe('unilateralLadderFor', () => {
  const secondsBase: UnilateralDelays = {
    unilateralClaimDelay: 5120,
    unilateralRefundDelay: 5120,
    unilateralRefundWithoutReceiverDelay: 5120,
  }
  const blocksBase: UnilateralDelays = {
    unilateralClaimDelay: 20,
    unilateralRefundDelay: 20,
    unilateralRefundWithoutReceiverDelay: 28,
  }

  it('extends a seconds ladder through the quoted absolute refund horizon', () => {
    const refundLocktime = NOW + 420 * SECONDS_PER_BLOCK
    const ladder = unilateralLadderFor(secondsBase, refundLocktime, NOW)

    expect(ladder.unilateralRefundWithoutReceiverDelay).toBe(252_416)
    expect(ladder.unilateralClaimDelay).toBe(5120)
    expect(ladder.unilateralRefundDelay).toBe(5120)
    expect(refundWithoutReceiverDelayCovers(ladder.unilateralRefundWithoutReceiverDelay, refundLocktime, NOW)).toBe(
      true,
    )
    expect(
      refundWithoutReceiverDelayCovers(ladder.unilateralRefundWithoutReceiverDelay - 512, refundLocktime, NOW),
    ).toBe(false)
  })

  it('preserves a block-typed ladder and rounds the horizon up in blocks', () => {
    expect(unilateralLadderFor(blocksBase, NOW + 21 * 600 + 1, NOW)).toMatchObject({
      unilateralClaimDelay: 20,
      unilateralRefundDelay: 20,
      unilateralRefundWithoutReceiverDelay: 28,
    })
    expect(unilateralLadderFor(blocksBase, NOW + 28 * 600 + 1, NOW)).toMatchObject({
      unilateralRefundWithoutReceiverDelay: 29,
    })
  })

  it('re-clocks a block ladder to seconds when the horizon overflows it', () => {
    // The regtest shape: 5-block server delay, 524-block horizon (40 final +
    // 40 hint + 432 LND budget + 2h margin). 524 would read back as seconds,
    // so every rung moves clocks instead of the quote refusing.
    const regtestBase: UnilateralDelays = {
      unilateralClaimDelay: 5,
      unilateralRefundDelay: 5,
      unilateralRefundWithoutReceiverDelay: 13,
    }
    const ladder = unilateralLadderFor(regtestBase, NOW + 524 * 600, NOW)

    expect(ladder).toEqual({
      unilateralClaimDelay: secondsForBlockRung(5),
      unilateralRefundDelay: secondsForBlockRung(5),
      unilateralRefundWithoutReceiverDelay: 314_880,
    })
    for (const rung of Object.values(ladder)) expect(relativeDelayFrom(rung).unit).toBe('seconds')
    expect(refundWithoutReceiverDelayCovers(ladder.unilateralRefundWithoutReceiverDelay, NOW + 524 * 600, NOW)).toBe(
      true,
    )
  })

  it('flips exactly where blocks stop meaning blocks', () => {
    const fits = unilateralLadderFor(blocksBase, NOW + 511 * 600, NOW)
    expect(relativeDelayFrom(fits.unilateralRefundWithoutReceiverDelay).unit).toBe('blocks')
    expect(fits.unilateralRefundWithoutReceiverDelay).toBe(511)
    const flipped = unilateralLadderFor(blocksBase, NOW + 511 * 600 + 1, NOW)
    expect(relativeDelayFrom(flipped.unilateralRefundWithoutReceiverDelay).unit).toBe('seconds')
    expect(flipped.unilateralClaimDelay).toBe(secondsForBlockRung(20))
  })

  it('still refuses past what BIP68 can encode', () => {
    expect(() => unilateralLadderFor(secondsBase, NOW + MAX_BIP68_SECONDS + 512, NOW)).toThrow(/unencodable/)
  })

  it('refuses a mixed-unit base rather than converting from two clocks', () => {
    expect(() => unilateralLadderFor({ ...blocksBase, unilateralRefundDelay: 5120 }, NOW + 600, NOW)).toThrow(
      /mixes units/,
    )
  })
})
