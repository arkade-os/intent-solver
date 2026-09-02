/**
 * Pricing as a decision rather than a number.
 *
 * The default MUST reproduce `corridorPolicy.ts`'s arithmetic exactly — a
 * default that moves a quoted figure is a pricing change wearing a refactor's
 * clothes, and it would move it for every deployment at once.
 */
import { describe, it, expect } from 'vitest'
import { fixedFeePricing, type PricingStrategy } from '@arkade-os/solver-core/core/pricing.js'
import { giveSatsFor, payoutSatsFor, type Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'

const FEE: Fee = { bps: 25, flatSats: 100 }
const PAIR = 'arkade:BTC->lightning:BTC'

describe('fixedFeePricing', () => {
  it('reproduces the flat-plus-bps arithmetic exactly', () => {
    // 10_000 * 25bps = 25, plus 100 flat = 125 kept; 9_875 delivered.
    expect(fixedFeePricing(FEE).payoutFor({ pair: PAIR, giveSats: 10_000 })).toBe(9_875)
  })

  /**
   * Asserted against the FUNCTIONS rather than against hand-computed numbers.
   * Hand-computed expectations would drift from `feeSatsFor`'s ceiling and the
   * correction loop in `giveSatsFor`, and the point here is that nothing moved.
   */
  it.each([1, 546, 1_000, 9_999, 10_000, 123_456, 21_000_000])('matches payoutSatsFor at %i sats', (give) => {
    expect(fixedFeePricing(FEE).payoutFor({ pair: PAIR, giveSats: give })).toBe(payoutSatsFor(give, FEE))
  })

  it.each([1, 546, 1_000, 9_999, 10_000, 123_456])('matches giveSatsFor at %i sats', (payout) => {
    expect(fixedFeePricing(FEE).giveFor({ pair: PAIR, payoutSats: payout })).toBe(giveSatsFor(payout, FEE))
  })

  it('round-trips: giveFor then payoutFor returns at least what was asked', () => {
    const p = fixedFeePricing(FEE)
    const give = p.giveFor({ pair: PAIR, payoutSats: 9_875 })
    expect(p.payoutFor({ pair: PAIR, giveSats: give })).toBeGreaterThanOrEqual(9_875)
  })

  /**
   * `payoutSatsFor`'s doc is explicit that a small amount against a large flat
   * fee may go zero or negative, and that the CALLER must treat that as
   * unquotable rather than as a free swap — clamping here would silently turn
   * "the fee ate the swap" into a payout of nothing, which is a different
   * refusal with a different reason.
   */
  it('does NOT clamp a payout the fee has eaten', () => {
    const p = fixedFeePricing({ bps: 0, flatSats: 1_000 })
    expect(p.payoutFor({ pair: PAIR, giveSats: 400 })).toBe(-600)
  })

  it('charges nothing when the fee is free', () => {
    const p = fixedFeePricing({ bps: 0, flatSats: 0 })
    expect(p.payoutFor({ pair: PAIR, giveSats: 10_000 })).toBe(10_000)
    expect(p.giveFor({ pair: PAIR, payoutSats: 10_000 })).toBe(10_000)
  })
})

describe('a custom strategy', () => {
  /** Seeing the amount is the whole reason this is an interface and not a number. */
  it('can price on size, which a static Fee cannot', () => {
    const tiered: PricingStrategy = {
      payoutFor: ({ giveSats }) => giveSats - (giveSats > 100_000 ? 10 : 500),
      giveFor: ({ payoutSats }) => payoutSats + (payoutSats > 100_000 ? 10 : 500),
    }
    expect(tiered.payoutFor({ pair: PAIR, giveSats: 1_000_000 })).toBe(999_990)
    expect(tiered.payoutFor({ pair: PAIR, giveSats: 1_000 })).toBe(500)
  })

  /** And on the corridor, which is why `pair` is on both inputs. */
  it('can price one corridor differently from another', () => {
    const perPair: PricingStrategy = {
      payoutFor: ({ pair, giveSats }) => giveSats - (pair.startsWith('arkade:') ? 10 : 50),
      giveFor: ({ pair, payoutSats }) => payoutSats + (pair.startsWith('arkade:') ? 10 : 50),
    }
    expect(perPair.payoutFor({ pair: PAIR, giveSats: 1_000 })).toBe(990)
    expect(perPair.payoutFor({ pair: 'lightning:BTC->arkade:BTC', giveSats: 1_000 })).toBe(950)
  })
})
