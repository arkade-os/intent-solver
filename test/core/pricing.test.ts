/**
 * Pricing as a decision rather than a number.
 *
 * The default MUST reproduce `corridorPolicy.ts`'s arithmetic exactly — a
 * default that moves a quoted figure is a pricing change wearing a refactor's
 * clothes, and it would move it for every deployment at once.
 */
import { describe, it, expect } from 'vitest'
import {
  fixedFeePricing,
  networkFeePricing,
  onchainCostSats,
  type PricingStrategy,
} from '@arkade-os/solver-core/core/pricing.js'
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
    networkFeePricing({ base: BASE, costSats: onchainCostSats(VSIZE, () => rate), capSats: CAP })

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
    const capped = networkFeePricing({
      base: BASE,
      costSats: onchainCostSats(VSIZE, () => 1_000_000),
      capSats: 5_000,
    })
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
    const moving = networkFeePricing({ base: BASE, costSats: onchainCostSats(VSIZE, () => ++calls), capSats: CAP })
    moving.payoutFor({ pair: PAIR, giveSats: 100_000 })
    expect(calls).toBe(1)
  })
})

/**
 * The reason the cost is a FUNCTION OF THE SWAP and not a rate.
 *
 * Chain cost is `vsize x sats/vbyte` and is the same whatever the amount. A
 * Lightning routing fee is not: it depends on the amount and the destination,
 * and a real backend already computes one — today the solver only learns it by
 * being REFUSED for budgeting too little (`maxFeeSats does not cover fee
 * estimate`). Anything that can answer "what will this one cost me" fits here.
 */
describe('networkFeePricing with an amount-dependent cost', () => {
  const BASE: Fee = { bps: 25, flatSats: 300 }
  // A routing fee shaped like a real one: a floor plus a proportional part.
  const routing = ({ giveSats }: { giveSats: number }) => 25 + Math.ceil(giveSats / 1_000)

  it('charges more on a larger swap, which a fixed vsize cannot express', () => {
    const priced = networkFeePricing({ base: BASE, costSats: routing, capSats: 50_000 })
    const smallFee = 10_000 - priced.payoutFor({ pair: PAIR, giveSats: 10_000 })
    const largeFee = 1_000_000 - priced.payoutFor({ pair: PAIR, giveSats: 1_000_000 })
    // Both terms grow, but the point is that the FLAT one did too: bps alone
    // would scale identically for any cost function.
    expect(largeFee - smallFee).toBeGreaterThan(Math.ceil((1_000_000 - 10_000) * 25) / 10_000)
  })

  it('is handed the pair, so one strategy can serve corridors that differ', () => {
    const seen: string[] = []
    const priced = networkFeePricing({
      base: BASE,
      costSats: ({ pair }) => {
        seen.push(pair)
        return 100
      },
      capSats: 50_000,
    })
    priced.payoutFor({ pair: PAIR, giveSats: 10_000 })
    expect(seen).toEqual([PAIR])
  })
})

/**
 * The shape a prepare-then-execute backend gives you.
 *
 * Some backends split a send in two: the first call returns the fee for THIS
 * payment, the second spends against it. A corridor that awaits the prepare at
 * quote time has an exact figure, not a model of one — and pricing reads it
 * synchronously because by then it is just a number. The synchronous interface
 * is about WHERE the asking happens, not whether it can be asked.
 */
describe('networkFeePricing with a prepared per-swap fee', () => {
  const BASE: Fee = { bps: 25, flatSats: 300 }

  it('prices the exact fee a prepare returned, with no modelling', () => {
    // What a corridor does: `const prepared = await ln.prepareSend(invoice)`,
    // then close over it. No rate, no vsize, no sampling.
    const preparedFeeSats = 187
    const priced = networkFeePricing({ base: BASE, costSats: () => preparedFeeSats, capSats: 50_000 })
    expect(priced.payoutFor({ pair: PAIR, giveSats: 100_000 })).toBe(payoutSatsFor(100_000, { bps: 25, flatSats: 187 }))
  })

  it('asks nothing itself — the corridor already did', () => {
    // The guarantee that matters for the hot path: pricing performs no I/O and
    // cannot, so a taker cannot amplify load onto the fee source through it.
    let asked = 0
    const priced = networkFeePricing({
      base: BASE,
      costSats: () => {
        asked++
        return 187
      },
      capSats: 50_000,
    })
    priced.payoutFor({ pair: PAIR, giveSats: 100_000 })
    priced.payoutFor({ pair: PAIR, giveSats: 200_000 })
    // Once per quote, and only because the corridor handed over a closure.
    expect(asked).toBe(2)
  })

  it('still caps a prepared fee, because a backend can return anything', () => {
    const priced = networkFeePricing({ base: BASE, costSats: () => 900_000, capSats: 5_000 })
    expect(priced.payoutFor({ pair: PAIR, giveSats: 100_000 })).toBe(
      payoutSatsFor(100_000, { bps: 25, flatSats: 5_000 }),
    )
  })
})
