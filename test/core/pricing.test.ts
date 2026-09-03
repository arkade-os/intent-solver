/**
 * Pricing as a decision rather than a number.
 *
 * The default MUST reproduce `corridorPolicy.ts`'s arithmetic exactly — a
 * default that moves a quoted figure is a pricing change wearing a refactor's
 * clothes, and it would move it for every deployment at once.
 */
import { describe, it, expect } from 'vitest'
import { fixedFeePricing, networkFeePricing, type PricingStrategy } from '@arkade-os/solver-core/core/pricing.js'
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

/**
 * The chain cost, priced when the quote is made rather than when the process
 * booted.
 *
 * `fixedFeePricing`'s flat is a guess against a number that moves. These pin
 * the three things that make replacing it safe: it tracks the rate, it never
 * quotes zero when the rate is missing, and it cannot be talked into an absurd
 * figure by a bad reading.
 */
describe('networkFeePricing', () => {
  const BASE: Fee = { bps: 25, flatSats: 300 }
  const VSIZE = 154
  const CAP = 50_000

  const at = (rate: number | null): PricingStrategy =>
    networkFeePricing({ base: BASE, feeRate: () => rate, vsize: VSIZE, capSats: CAP })

  it('charges the rate times the size it will actually broadcast', () => {
    // 10 sat/vB * 154 vB = 1540, and the bps term is untouched.
    expect(at(10).payoutFor({ pair: PAIR, giveSats: 100_000 })).toBe(
      payoutSatsFor(100_000, { bps: 25, flatSats: 1_540 }),
    )
  })

  it('moves with the mempool — the whole point', () => {
    const calm = at(2).payoutFor({ pair: PAIR, giveSats: 100_000 })
    const spike = at(80).payoutFor({ pair: PAIR, giveSats: 100_000 })
    expect(spike).toBeLessThan(calm)
  })

  it('REPLACES the configured flat rather than adding to it', () => {
    // `Fee.flatSats` already means "the chain cost this corridor pays"; adding
    // a live estimate on top bills it twice.
    const priced = at(10).payoutFor({ pair: PAIR, giveSats: 100_000 })
    expect(priced).not.toBe(payoutSatsFor(100_000, { bps: 25, flatSats: 300 + 1_540 }))
  })

  it('falls back to the configured flat when no rate is known, never to zero', () => {
    // Quoting no chain cost is how the solver ends up paying it.
    expect(at(null).payoutFor({ pair: PAIR, giveSats: 100_000 })).toBe(payoutSatsFor(100_000, BASE))
    expect(at(null).giveFor({ pair: PAIR, payoutSats: 100_000 })).toBe(giveSatsFor(100_000, BASE))
  })

  it('treats a nonsense rate as no rate, not as a huge one', () => {
    // A source returning NaN, Infinity or a negative is broken, and a broken
    // reading must not become a quote.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(at(bad).payoutFor({ pair: PAIR, giveSats: 100_000 })).toBe(payoutSatsFor(100_000, BASE))
    }
  })

  it('caps the chain cost, so a spike refuses rather than quoting absurdly', () => {
    const capped = networkFeePricing({ base: BASE, feeRate: () => 1_000_000, vsize: VSIZE, capSats: 5_000 })
    expect(capped.payoutFor({ pair: PAIR, giveSats: 100_000 })).toBe(
      payoutSatsFor(100_000, { bps: 25, flatSats: 5_000 }),
    )
  })

  it('does NOT clamp a payout the chain cost has eaten', () => {
    // Same contract as `fixedFeePricing`: "the fee ate the swap" and "below the
    // minimum" are different refusals, and a clamp to zero hides the first.
    expect(at(80).payoutFor({ pair: PAIR, giveSats: 1_000 })).toBeLessThanOrEqual(0)
  })

  it('round-trips at a given rate, so a quote and its fill agree', () => {
    const priced = at(10)
    for (const want of [1_000, 9_999, 250_000]) {
      expect(
        priced.payoutFor({ pair: PAIR, giveSats: priced.giveFor({ pair: PAIR, payoutSats: want }) }),
      ).toBeGreaterThanOrEqual(want)
    }
  })

  it('reads the rate once per call, so a refresh cannot split one quote', () => {
    // A rate landing between the two reads of a single call would make
    // `payoutFor` and `giveFor` disagree about the same swap — which is the
    // drift `giveFor` exists to prevent.
    let calls = 0
    const moving = networkFeePricing({ base: BASE, feeRate: () => ++calls, vsize: VSIZE, capSats: CAP })
    moving.payoutFor({ pair: PAIR, giveSats: 100_000 })
    expect(calls).toBe(1)
  })
})
