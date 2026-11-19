import { describe, it, expect } from 'vitest'
import {
  clampedBefore,
  MIN_ROUTING_FEE_CAP_SATS,
  maxRoutingFeeSats,
  resolveLimits,
} from '@arkade-os/solver-core/core/limits.js'
import { NETWORKS } from '@arkade-os/solver-core/core/networks.js'

describe('resolveLimits', () => {
  it('caps mainnet far below the test networks', () => {
    const mainnet = resolveLimits('bitcoin')
    expect(mainnet).toEqual({ minSats: NETWORKS.bitcoin.limits.minSats, maxSats: NETWORKS.bitcoin.limits.maxSats })
    expect(mainnet.maxSats).toBeLessThan(resolveLimits('mutinynet').maxSats)
  })

  it('lets configuration narrow the range', () => {
    expect(resolveLimits('bitcoin', { maxSats: 800 })).toEqual({
      minSats: NETWORKS.bitcoin.limits.minSats,
      maxSats: 800,
    })
    expect(resolveLimits('bitcoin', { minSats: 800 }).minSats).toBe(800)
  })

  it('lets configuration set a range past the mainnet default, in either direction', () => {
    expect(resolveLimits('bitcoin', { maxSats: 10_000_000 }).maxSats).toBe(10_000_000)
    expect(resolveLimits('bitcoin', { minSats: 1 }).minSats).toBe(1)
  })

  it('applies the same rule on test networks', () => {
    expect(resolveLimits('mutinynet', { maxSats: 999_999_999 }).maxSats).toBe(999_999_999)
    expect(resolveLimits('regtest', { maxSats: 5_000 }).maxSats).toBe(5_000)
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -1],
  ])('rejects a %s override instead of silently removing the cap', (_label, maxSats) => {
    // Math.min(1000, NaN) is NaN, which then compares false against every
    // amount -- the cap would be gone with no error and no log.
    expect(() => resolveLimits('bitcoin', { maxSats })).toThrow(/positive finite/)
  })

  it('rejects an override that leaves no usable range', () => {
    expect(() => resolveLimits('bitcoin', { minSats: 900, maxSats: 700 })).toThrow(/empty/)
  })
})

describe('clampedBefore', () => {
  const net = NETWORKS.bitcoin.limits

  it('names nothing a deployment inside the old ranges sets', () => {
    expect(clampedBefore('bitcoin', net, { a: { minSats: 1_000, maxSats: 20_000 } })).toEqual([])
  })

  it('names each bound the old clamps moved, the deployment into the network and a corridor into the deployment', () => {
    const deployment = { minSats: net.minSats, maxSats: 30_000 }
    expect(
      clampedBefore('bitcoin', deployment, {
        wide: { minSats: 100, maxSats: 40_000 },
        inherits: deployment,
      }),
    ).toEqual([
      { corridor: 'wide', field: 'minSats', now: 100, was: net.minSats },
      { corridor: 'wide', field: 'maxSats', now: 40_000, was: 30_000 },
    ])
    expect(clampedBefore('bitcoin', { minSats: net.minSats, maxSats: 100_000 }, {})).toEqual([
      { corridor: null, field: 'maxSats', now: 100_000, was: net.maxSats },
    ])
  })
})

describe('maxRoutingFeeSats', () => {
  it('scales with the amount', () => {
    expect(maxRoutingFeeSats(100_000)).toBe(500)
  })

  it('keeps a floor so small swaps stay routable', () => {
    expect(maxRoutingFeeSats(1_000)).toBe(MIN_ROUTING_FEE_CAP_SATS)
  })

  it('clears the backend minimum that made a whole size band unservable', () => {
    // The floor was 10. At 0.5%, `ceil(amt * 0.005)` only exceeds 10 above 2000
    // sats — so EVERY swap at or below 2000 got a cap of exactly 10, and a
    // mainnet backend quoting 11 refused all of them, identically and forever:
    //
    //   maxFeeSats does not cover fee estimate [value: 10, expected: 11 sats]
    //
    // Asserted across the whole band rather than at the one observed size,
    // because the bug was never about 503 sats — it was about every amount
    // whose proportional cap lands under the backend's own minimum.
    for (const amount of [1, 100, 503, 1_000, 2_000]) {
      expect(maxRoutingFeeSats(amount), `${amount} sats`).toBeGreaterThan(11)
    }
  })

  it('hands over from the floor to the proportional cap at the crossover', () => {
    // 5000 is the crossover itself: 0.5% of it IS the floor, so the two agree
    // and neither can be said to govern. Named as the tie it is, because a
    // sample taken exactly here proves nothing about which side wins.
    expect(maxRoutingFeeSats(5_000)).toBe(MIN_ROUTING_FEE_CAP_SATS)
    // One sat above it, the percentage is what governs — and it must round up,
    // or the handover would dip back below the floor it just left.
    expect(maxRoutingFeeSats(5_001)).toBe(26)
    expect(maxRoutingFeeSats(20_000)).toBe(100)
  })

  it('never returns a fraction of a sat', () => {
    for (const amount of [1_001, 3_333, 4_999]) {
      expect(Number.isInteger(maxRoutingFeeSats(amount))).toBe(true)
    }
  })
})
