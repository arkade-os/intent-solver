/**
 * Block-typed timelocks: the unit is read off the value, and every place that
 * mixes such a value with a wall clock converts it first.
 *
 * The interesting cases here are not "does 20 stay 20". They are the ones where
 * a block count and a seconds value are BOTH well-formed numbers, so nothing
 * local notices they count different clocks — which is every way this feature
 * can lose money.
 */
import { describe, expect, it } from 'vitest'
import {
  absoluteLocktimeIn,
  absoluteLocktimeReached,
  absoluteLocktimeSeconds,
  absoluteLocktimeUnit,
  assertAbsoluteLocktime,
  deriveUnilateralDelays,
  isEncodableDelay,
  MAX_BIP68_BLOCKS,
  NOMINAL_BLOCK_SECONDS,
  rawDelaySeconds,
  relativeDelayFrom,
  SEQUENCE_GRANULARITY_SECONDS,
  SOLO_REFUND_HEADROOM_BLOCKS,
  SOLO_REFUND_HEADROOM_SECONDS,
} from '@arkade-os/solver-core/core/timelocks.js'
import { minHtlcWindowFor } from '@arkade-os/solver-core/core/receive.js'
import { refundLocktimeFor, REFUND_SAFETY_MARGIN } from '@arkade-os/solver-core/core/send.js'
import { onchainRefundLocktimeFor, ONCHAIN_ORDER_MARGIN_SECONDS } from '@arkade-os/solver-core/core/onchainSend.js'

describe('the unit is read off the value', () => {
  it.each([
    [1, 'blocks'],
    [20, 'blocks'],
    [511, 'blocks'],
    [512, 'seconds'],
    [4096, 'seconds'],
  ])('reads %i as %s, matching the SDK toTimelock boundary', (raw, unit) => {
    expect(relativeDelayFrom(raw).unit).toBe(unit)
  })

  it('puts the boundary exactly where the SDK puts it', () => {
    // `toTimelock` is `value >= 512n ? 'seconds' : 'blocks'`. If the SDK ever
    // moves it, this is the test that should fail — not a lockup in production.
    expect(relativeDelayFrom(SEQUENCE_GRANULARITY_SECONDS).unit).toBe('seconds')
    expect(relativeDelayFrom(SEQUENCE_GRANULARITY_SECONDS - 1).unit).toBe('blocks')
  })

  it('accepts any positive integer block count, but only 512-multiples as seconds', () => {
    expect(isEncodableDelay(20)).toBe(true)
    expect(isEncodableDelay(511)).toBe(true)
    expect(isEncodableDelay(1000)).toBe(false)
    expect(isEncodableDelay(4096)).toBe(true)
  })
})

describe('deriveUnilateralDelays, block-typed', () => {
  it('builds the ladder in blocks, without rounding to a 512-second grid', () => {
    expect(deriveUnilateralDelays(20)).toEqual({
      unilateralClaimDelay: 20,
      unilateralRefundDelay: 20,
      unilateralRefundWithoutReceiverDelay: 20 + SOLO_REFUND_HEADROOM_BLOCKS,
    })
  })

  it('keeps the solo refund opening last, the ordering the whole ladder exists for', () => {
    const { unilateralClaimDelay, unilateralRefundWithoutReceiverDelay } = deriveUnilateralDelays(144)
    expect(unilateralRefundWithoutReceiverDelay).toBeGreaterThan(unilateralClaimDelay)
  })

  it('refuses a base whose ladder TOP would re-type itself as seconds', () => {
    // 505 + 8 = 513: still a fine integer, and silently no longer blocks. A
    // ~3.5-day window would become an ~85-minute one.
    expect(() => deriveUnilateralDelays(MAX_BIP68_BLOCKS + 1)).toThrow(
      /stops meaning blocks and starts meaning seconds/,
    )
    expect(deriveUnilateralDelays(MAX_BIP68_BLOCKS).unilateralRefundWithoutReceiverDelay).toBeLessThan(
      SEQUENCE_GRANULARITY_SECONDS,
    )
  })

  it('refuses a fractional block count, which nothing downstream would round', () => {
    expect(() => deriveUnilateralDelays(20.5)).toThrow(/whole number/)
  })

  it('leaves the seconds ladder exactly as it was', () => {
    // The additive claim, asserted rather than hoped: a seconds-configured
    // deployment gets byte-identical numbers out of this function.
    expect(deriveUnilateralDelays(4096)).toEqual({
      unilateralClaimDelay: 4096,
      unilateralRefundDelay: 4096,
      unilateralRefundWithoutReceiverDelay: 4096 + SOLO_REFUND_HEADROOM_SECONDS,
    })
    // And the off-grid value still climbs to the 512 boundary.
    expect(deriveUnilateralDelays(4000).unilateralClaimDelay).toBe(4096)
  })
})

describe('a block delay meeting a wall clock', () => {
  const NOW = 1_800_000_000

  it('converts at the SDK nominal rate rather than adding blocks to a timestamp', () => {
    expect(rawDelaySeconds(20)).toBe(20 * NOMINAL_BLOCK_SECONDS)
    expect(rawDelaySeconds(4096)).toBe(4096)
  })

  it('keeps refundLocktimeFor a real bound under a block-typed ladder', () => {
    // The bug this pins: a delay added raw puts the deadline that many SECONDS
    // past now, so the unilateral bound stops bounding anything.
    //
    // A SHORT invoice on purpose. `refundLocktimeFor` takes a max, and at any
    // ordinary route budget the HTLC bound swamps the unilateral one and would
    // hide the mistake entirely — so these terms are sized to make the
    // unilateral bound the binding one, which is the term under test.
    const cltv = {
      minFinalCltvBlocks: 10,
      worstRouteHintCltvBlocks: 0,
      bestRouteHintCltvBlocks: 0,
      routeCltvBudgetBlocks: 10,
      enforcesRouteCltv: true,
    }
    const locktime = refundLocktimeFor(cltv, 400, NOW)
    expect(locktime).toBe(NOW + 400 * NOMINAL_BLOCK_SECONDS + REFUND_SAFETY_MARGIN)
    // Non-vacuous: the unilateral term is what set it, not the HTLC term — a
    // shorter ladder moves the answer, which it could not if the max were won
    // elsewhere.
    expect(refundLocktimeFor(cltv, 300, NOW)).toBeLessThan(locktime)
  })

  it('keeps onchainRefundLocktimeFor a real bound under a block-typed ladder', () => {
    // Chosen so the server-independent bound is the one that binds: the HTLC
    // locktime is close enough to `now` that neither chain bound can win.
    const locktime = onchainRefundLocktimeFor(NOW, 20, NOW)
    expect(locktime).toBeGreaterThanOrEqual(NOW + 20 * NOMINAL_BLOCK_SECONDS + ONCHAIN_ORDER_MARGIN_SECONDS)
  })

  it('keeps the receive corridor recourse gate binding under a block-typed ladder', () => {
    const withBlocks = minHtlcWindowFor(28, false)
    const withSeconds = minHtlcWindowFor(28 * NOMINAL_BLOCK_SECONDS, false)
    // Same physical window, so the gate must ask for the same thing either way.
    expect(withBlocks).toBe(withSeconds)
  })
})

describe('absolute locktimes', () => {
  it('reads its unit off the BIP65 threshold', () => {
    expect(absoluteLocktimeUnit(812)).toBe('blocks')
    expect(absoluteLocktimeUnit(1_800_000_000)).toBe('seconds')
  })

  it('refuses each unit where the other was meant, and says which', () => {
    expect(() => assertAbsoluteLocktime(812, 'refundLocktime', 'seconds')).toThrow(
      /would be interpreted as a block height/,
    )
    expect(() => assertAbsoluteLocktime(1_800_000_000, 'refundLocktime', 'blocks')).toThrow(
      /would be interpreted as unix/,
    )
  })

  it('accepts each unit where it was meant', () => {
    expect(() => assertAbsoluteLocktime(812, 'refundLocktime', 'blocks')).not.toThrow()
    expect(() => assertAbsoluteLocktime(1_800_000_000)).not.toThrow()
  })

  it('defaults to seconds, so every pre-existing caller still refuses a height', () => {
    // The additive claim for the EVM and onchain callers, which pass no unit and
    // must go on behaving exactly as they did.
    expect(() => assertAbsoluteLocktime(850_000)).toThrow(/would be interpreted as a block height/)
  })

  it('refuses a non-positive locktime whichever unit is expected', () => {
    expect(() => assertAbsoluteLocktime(0, 'refundLocktime', 'blocks')).toThrow(/positive/)
    expect(() => assertAbsoluteLocktime(-1)).toThrow(/positive/)
  })
})

describe('absolute locktimes across the two clocks', () => {
  const AT = { now: 1_800_000_000, tipHeight: 800 }

  it('leaves a seconds locktime untouched, so pre-existing rows flow through', () => {
    expect(absoluteLocktimeSeconds(1_800_007_200, AT)).toBe(1_800_007_200)
    expect(absoluteLocktimeIn(1_800_007_200, 'seconds', AT)).toBe(1_800_007_200)
  })

  it('projects a height from the tip at the nominal interval', () => {
    // 12 blocks out from the tip is 2 hours at 600s/block.
    expect(absoluteLocktimeSeconds(812, AT)).toBe(AT.now + 12 * NOMINAL_BLOCK_SECONDS)
  })

  it('round-trips a deadline through the block encoding', () => {
    const deadline = AT.now + 2 * 60 * 60
    const height = absoluteLocktimeIn(deadline, 'blocks', AT)
    expect(height).toBe(812)
    expect(absoluteLocktimeSeconds(height, AT)).toBe(deadline)
  })

  it('rounds a height UP, never shaving the margin a deadline guarantees', () => {
    // 100s short of a whole block still buys the whole block.
    const height = absoluteLocktimeIn(AT.now + NOMINAL_BLOCK_SECONDS + 100, 'blocks', AT)
    expect(height).toBe(AT.tipHeight + 2)
    expect(absoluteLocktimeSeconds(height, AT)).toBeGreaterThan(AT.now + NOMINAL_BLOCK_SECONDS + 100)
  })

  it('answers "has it opened" on the CHAIN, not on a projection', () => {
    // The regtest case, and the whole point: a hundred blocks mined, clock
    // unmoved. The projection would still say "not yet"; the chain says yes.
    const mined = { now: AT.now, tipHeight: 900 }
    expect(absoluteLocktimeReached(812, mined)).toBe(true)
    expect(absoluteLocktimeReached(812, AT)).toBe(false)
    // The split's whole reason, stated as a disagreement: the projection and the
    // chain answer differently at the same moment, and the chain is the one that
    // decides whether a spend is accepted.
    expect(absoluteLocktimeSeconds(812, mined)).toBeLessThanOrEqual(mined.now)
  })

  it('still answers a seconds locktime on the clock, whatever the tip does', () => {
    const mined = { now: AT.now, tipHeight: 10_000 }
    expect(absoluteLocktimeReached(AT.now + 1, mined)).toBe(false)
    expect(absoluteLocktimeReached(AT.now - 1, mined)).toBe(true)
  })

  it('refuses a height that would read back as unix seconds', () => {
    // Unreachable on any real chain, but the failure it prevents is a locktime
    // that silently means 1985 rather than a height half a billion blocks out.
    const nearThreshold = { now: AT.now, tipHeight: 499_999_999 }
    expect(() => absoluteLocktimeIn(AT.now + NOMINAL_BLOCK_SECONDS, 'blocks', nearThreshold)).toThrow(
      /would read as unix seconds/,
    )
  })
})
