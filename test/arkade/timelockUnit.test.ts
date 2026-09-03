/**
 * The two boot-time refusals block mode introduces, and the announcement it makes.
 *
 * Both refusals guard something nothing at runtime can see. An override in the wrong
 * unit writes a whole deployment's covenants against a clock the server does not
 * enforce, and block mode on a real network holds a Lightning HTLC deadline against
 * block-interval variance. Neither shows up until a spend, with money already locked —
 * which is why they are boot throws and why they are tested here rather than trusted.
 */
import { describe, expect, it } from 'vitest'
import { resolveTimelockUnit } from '@arkade-os/solver-arkade/arkade/wallet.js'

describe('resolveTimelockUnit', () => {
  it('reads the unit off the server rather than off any setting', () => {
    expect(resolveTimelockUnit({ advertisedExitDelay: 20, isMainnet: false }).unit).toBe('blocks')
    expect(resolveTimelockUnit({ advertisedExitDelay: 4096, isMainnet: false }).unit).toBe('seconds')
  })

  it('says nothing at all on the seconds-typed deployment that has no override', () => {
    // The additive claim at boot: a deployment configured as it always was gets
    // exactly the log it always got.
    expect(resolveTimelockUnit({ advertisedExitDelay: 605_184, isMainnet: true }).notices).toEqual([])
  })

  it('announces block mode loudly wherever it is allowed', () => {
    const { notices } = resolveTimelockUnit({ advertisedExitDelay: 20, isMainnet: false })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/BLOCK-typed/)
  })

  it('refuses block mode on mainnet', () => {
    expect(() => resolveTimelockUnit({ advertisedExitDelay: 20, isMainnet: true })).toThrow(/refused on mainnet/)
  })

  it.each([
    // 4096 against a block-typed server: reads as "about an hour" and is seconds.
    [20, 4096],
    // 300 against a seconds-typed server: reads as five minutes and is 300 blocks.
    [4096, 300],
  ])('refuses an override in the other unit than the server advertises (%i vs %i)', (advertised, override) => {
    expect(() =>
      resolveTimelockUnit({
        advertisedExitDelay: advertised,
        unilateralExitDelayOverride: override,
        isMainnet: false,
      }),
    ).toThrow(/must be expressed in the same unit as the server it overrides/)
  })

  it('accepts an override that agrees in unit, and names both numbers', () => {
    const { unit, notices } = resolveTimelockUnit({
      advertisedExitDelay: 605_184,
      unilateralExitDelayOverride: 260_096,
      isMainnet: true,
    })
    expect(unit).toBe('seconds')
    // BOTH values, because the whole reason the override exists is that they disagree.
    expect(notices[0]).toContain('260096')
    expect(notices[0]).toContain('605184')
  })

  it('accepts a block-typed override against a block-typed server', () => {
    const { unit } = resolveTimelockUnit({
      advertisedExitDelay: 20,
      unilateralExitDelayOverride: 40,
      isMainnet: false,
    })
    expect(unit).toBe('blocks')
  })
})
