/**
 * Carving a renewal's proceeds into the pool's shape.
 *
 * ONE INVARIANT MATTERS ABOVE THE REST: the pieces plus their fees must never
 * exceed what there was to divide. Over-allocating does not fail cleanly — it
 * produces a settlement the server refuses, or one that silently takes the
 * difference out of the float. Everything else here is shape; this is money.
 *
 * The fee is injected because an operator's intent fee is a CEL expression, not
 * a constant: a live regtest server answers `offchainOutput: "0.0"` while
 * `offchainInput` is `"amount * 0.01"`. So the invariant is checked against a
 * flat fee, a proportional one, a zero one, and a deliberately awkward one.
 */

import { describe, it, expect } from 'vitest'
import { splitRenewalOutputs, type PoolRung } from '@arkade-os/solver-arkade/arkade/vtxoPool.js'

const DUST = 330n
const TARGET: PoolRung[] = [
  { size: 250_000, want: 6 },
  { size: 1_000_000, want: 4 },
]

/** The shapes an operator's expression can actually take. */
const FEES = {
  zero: () => 0n,
  flat: () => 250n,
  proportional: (a: bigint) => a / 100n,
  awkward: (a: bigint) => (a < 100_000n ? 500n : a / 200n + 17n),
} as const

const split = (gross: bigint, outputFeeOn: (a: bigint) => bigint, maxOutputs = 8, target = TARGET) =>
  splitRenewalOutputs({ gross, target, dust: DUST, outputFeeOn, maxOutputs })

describe('the invariant: never allocate more than there was', () => {
  it.each(Object.entries(FEES))('holds for a %s fee, across sizes', (_name, fee) => {
    for (const gross of [
      1_000n,
      5_000n,
      331n,
      330n,
      100_000n,
      250_001n,
      1_000_000n,
      4_500_000n,
      8_465_441n,
      100_000_000n,
    ]) {
      const pieces = split(gross, fee)
      const spent = pieces.reduce((sum, p) => sum + p + fee(p), 0n)
      expect(spent).toBeLessThanOrEqual(gross)
    }
  })

  it('never emits a piece below dust', () => {
    for (const [, fee] of Object.entries(FEES)) {
      for (const gross of [329n, 330n, 331n, 1_000n, 12_345n, 3_000_000n]) {
        for (const piece of split(gross, fee)) expect(piece).toBeGreaterThanOrEqual(DUST)
      }
    }
  })

  it('emits nothing at all when there is nothing to divide', () => {
    expect(split(0n, FEES.flat)).toEqual([])
    expect(split(-1n, FEES.flat)).toEqual([])
  })
})

describe('the shape', () => {
  it('carves the target rungs, largest first', () => {
    // Largest first so the float is shaped into the pieces that fund the biggest
    // swaps before it is spent down on small ones.
    const pieces = split(5_000_000n, FEES.zero)
    expect(pieces[0]).toBe(1_000_000n)
    expect(pieces.filter((p) => p === 1_000_000n).length).toBeGreaterThan(0)
  })

  it('falls back to ONE output when no rung fits — exactly what renewal does today', () => {
    // A deployment with too little to make even the smallest rung must renew the
    // way it always has, not refuse.
    const pieces = split(50_000n, FEES.zero)
    expect(pieces).toEqual([50_000n])
  })

  it('falls back to one output when there is no target at all', () => {
    expect(split(4_000_000n, FEES.zero, 8, [])).toEqual([4_000_000n])
  })

  it('gives the remainder its own piece rather than losing it', () => {
    // Zero fee makes the arithmetic checkable by eye: two rungs of 1_000_000
    // plus a 500_000 remainder.
    const pieces = split(2_500_000n, FEES.zero, 8, [{ size: 1_000_000, want: 2 }])
    expect(pieces).toEqual([1_000_000n, 1_000_000n, 500_000n])
    expect(pieces.reduce((a, b) => a + b, 0n)).toBe(2_500_000n)
  })

  it('keeps a gross that cannot afford a rung whole rather than shaving it', () => {
    // 1_000_000 + 200: the rung does not fit, because taking it would leave 200
    // and 200 cannot become an output. So no rung is taken and the whole gross
    // becomes one piece.
    //
    // THIS IS NOT THE FOLD PATH, despite looking like it. With a zero fee the
    // rung guard already leaves `remaining >= dust`, so the final piece clears
    // dust on its own and the fold below is unreachable from here. The test
    // named for the fold used to be this one, and it proved nothing about it.
    const pieces = split(1_000_200n, FEES.zero, 8, [{ size: 1_000_000, want: 2 }])
    expect(pieces).toHaveLength(1)
    expect(pieces[0]).toBe(1_000_200n)
  })

  it('folds a remainder that cannot pay its own fee into the last piece', () => {
    // The fold path proper, and it takes a NON-ZERO fee to reach: the rung loop
    // only takes a piece when at least `dust` survives, so with no fee the
    // remainder always clears dust by itself.
    //
    // 250_000 + 250 fee + 330 left. The 330 is exactly dust, so the rung is
    // taken — but the remainder must pay a 250 fee of its own to become an
    // output, leaving 80. Below dust, so it joins the piece before it rather
    // than being emitted as an output the server refuses, or silently dropped.
    const pieces = split(250_580n, FEES.flat, 8, [{ size: 250_000, want: 2 }])
    expect(pieces).toEqual([250_330n])
    // The reclaimed piece pays one fee, not two: folding removes an output.
    expect(pieces.reduce((sum, p) => sum + p + FEES.flat(), 0n)).toBe(250_580n)
  })

  it('takes a rung that leaves EXACTLY dust, because dust is a spendable output', () => {
    // The `< dust` boundary in the rung guard, and it is observable: `<=` here
    // would decline the third 250_000 and fold instead, giving
    // [1_000_000, 250_000, 250_330] — one fewer target-sized piece, forfeited to
    // avoid a remainder that was legal all along. A dust-exact output is an
    // output; only one that cannot pay its own fee is not.
    expect(split(1_500_330n, FEES.zero)).toEqual([1_000_000n, 250_000n, 250_000n, 330n])
  })

  it('drops a sub-dust remainder only when there is no piece to fold it into', () => {
    // The other half of the same branch. With no rung taken there is nothing to
    // grow, and emitting a sub-dust output would be refused by the server — so
    // the correct answer is no outputs at all rather than an unspendable one.
    expect(split(300n, FEES.flat, 8, [{ size: 250_000, want: 2 }])).toEqual([])
  })

  it('respects maxOutputs', () => {
    for (const max of [1, 2, 3, 8]) {
      expect(split(50_000_000n, FEES.zero, max).length).toBeLessThanOrEqual(max)
    }
  })

  it('still produces one usable output when maxOutputs is 1', () => {
    const pieces = split(4_000_000n, FEES.zero, 1)
    expect(pieces).toEqual([4_000_000n])
  })

  it('skips a rung smaller than dust rather than emitting it', () => {
    const pieces = split(10_000n, FEES.zero, 8, [{ size: 100, want: 5 }])
    expect(pieces.every((p) => p >= DUST)).toBe(true)
  })
})

describe('the fee is charged per piece, at that piece size', () => {
  it('costs more to split under a FLAT fee, and the pieces shrink to pay for it', () => {
    // Three outputs at 250 each is 750 of fee that a single output would not
    // have paid. The invariant test above proves it is affordable; this one
    // proves it is actually charged rather than ignored.
    const pieces = split(3_000_000n, FEES.flat, 8, [{ size: 1_000_000, want: 2 }])
    const spent = pieces.reduce((sum, p) => sum + p + FEES.flat(), 0n)
    expect(spent).toBeLessThanOrEqual(3_000_000n)
    expect(pieces.length).toBeGreaterThan(1)
  })

  it('does not assume the fee is constant', () => {
    // A proportional fee makes a big piece cost proportionally more. If the
    // splitter evaluated the fee once at `gross` and reused it, this would
    // over-allocate — the invariant test covers it, this names it.
    const pieces = split(4_000_000n, FEES.proportional, 8, [{ size: 1_000_000, want: 3 }])
    const spent = pieces.reduce((sum, p) => sum + p + FEES.proportional(p), 0n)
    expect(spent).toBeLessThanOrEqual(4_000_000n)
  })
})
