import { describe, it, expect } from 'vitest'
import {
  ONCHAIN_DUST_SATS,
  evaluateOnchainReceiveFill,
  onchainReceiveFillFloor,
  onchainReceiveFillCeiling,
  onchainReceiveFundedPayout,
  clampOnchainReceiveBand,
  defaultMaxBandWidthSats,
  type OnchainReceiveFillOutput,
  type OnchainReceiveFillParams,
} from '@arkade-os/solver-core/core/onchainReceive.js'

const limits = { minSats: 1_000, maxSats: 1_000_000 }
/** Quoted 50_000 in, 49_450 out: a 550 sat absolute fee. */
const quote = { amountSats: 50_000, payoutSats: 49_450 }

const output = (valueSats: number, confirmations = 0): OnchainReceiveFillOutput => ({
  txid: 'ab'.repeat(32),
  vout: 0,
  valueSats,
  confirmations,
})

const params = (over: Partial<OnchainReceiveFillParams> = {}): OnchainReceiveFillParams => ({
  outputs: [],
  quote,
  band: { minFromSats: quote.amountSats, maxFromSats: quote.amountSats },
  limits,
  claimFeeSats: 500,
  ...over,
})

const band = (minFromSats: number, maxFromSats: number) => ({ minFromSats, maxFromSats })

describe('a client that declared no band', () => {
  it('collapses the window to the strict equality this corridor ships today', () => {
    expect(onchainReceiveFillFloor(params())).toBe(50_000)
    expect(onchainReceiveFillCeiling(params())).toBe(50_000)
  })

  it('adopts the exact amount', () => {
    const result = evaluateOnchainReceiveFill(params({ outputs: [output(50_000)] }))
    expect(result).toMatchObject({ fill: 'adopt', fundedValueSats: 50_000, fundedPayoutSats: 49_450 })
  })

  it.each([49_999, 50_001, 1, 999_999])('refuses %i once it has confirmed', (valueSats) => {
    const result = evaluateOnchainReceiveFill(params({ outputs: [output(valueSats, 1)] }))
    expect(result.fill).toBe('refuse')
    if (result.fill === 'refuse') expect(result.reason).toContain('quote is for 50000')
  })

  it('gives back the refusal string this corridor already emits, verbatim', () => {
    // Pinned against `whenQuoted`'s own template so the band cannot quietly
    // change what an operator reads on a mismatched row.
    const result = evaluateOnchainReceiveFill(params({ outputs: [output(49_999, 1)] }))
    if (result.fill !== 'refuse') throw new Error('expected a refusal')
    expect(result.reason).toBe(`funding mismatch: ${'ab'.repeat(32)}:0 holds 49999 sats, quote is for 50000`)
  })

  it('keeps the quoted amount adoptable even when the claim fee alone exceeds it', () => {
    // Today such a swap is adopted and then fails at claim time naming the fee
    // rate. Refusing it here instead would be a new behaviour, not this change.
    const p = params({ outputs: [output(50_000)], claimFeeSats: 80_000 })
    expect(onchainReceiveFillFloor(p)).toBe(50_000)
    expect(evaluateOnchainReceiveFill(p).fill).toBe('adopt')
  })
})

describe('the floor, bound by bound', () => {
  it("takes the client's own floor when it is the highest", () => {
    expect(onchainReceiveFillFloor(params({ band: band(48_000, 52_000) }))).toBe(48_000)
  })

  it("takes the operator's floor over a lower client one", () => {
    expect(
      onchainReceiveFillFloor(params({ band: band(200, 52_000), limits: { minSats: 45_000, maxSats: 1_000_000 } })),
    ).toBe(45_000)
  })

  it('takes the give whose derived payout is exactly at dust', () => {
    // Fee 550 absolute, so a give of 550 + 330 pays out exactly 330.
    const floor = onchainReceiveFillFloor(
      params({ band: band(1, 52_000), limits: { minSats: 1, maxSats: 1_000_000 }, claimFeeSats: 0 }),
    )
    expect(floor).toBe(550 + ONCHAIN_DUST_SATS)
    expect(onchainReceiveFundedPayout(quote, floor)).toBe(ONCHAIN_DUST_SATS)
  })

  it('takes the give that is exactly worth sweeping', () => {
    const floor = onchainReceiveFillFloor(
      params({ band: band(1, 52_000), limits: { minSats: 1, maxSats: 1_000_000 }, claimFeeSats: 40_000 }),
    )
    expect(floor).toBe(40_000 + ONCHAIN_DUST_SATS)
  })

  it('refuses a confirmed output one sat under the floor and adopts one exactly on it', () => {
    const p = params({ band: band(48_000, 52_000) })
    expect(evaluateOnchainReceiveFill({ ...p, outputs: [output(47_999, 1)] }).fill).toBe('refuse')
    expect(evaluateOnchainReceiveFill({ ...p, outputs: [output(48_000)] })).toMatchObject({
      fill: 'adopt',
      fundedValueSats: 48_000,
      fundedPayoutSats: 47_450,
    })
  })
})

describe('the ceiling', () => {
  it("takes the client's own ceiling", () => {
    expect(onchainReceiveFillCeiling(params({ band: band(48_000, 52_000) }))).toBe(52_000)
  })

  it("never lifts past the operator's cap", () => {
    const p = params({ band: band(48_000, 900_000), limits: { minSats: 1_000, maxSats: 60_000 } })
    expect(onchainReceiveFillCeiling(p)).toBe(60_000)
    expect(evaluateOnchainReceiveFill({ ...p, outputs: [output(60_001, 1)] }).fill).toBe('refuse')
  })

  it('refuses a confirmed output one sat over and adopts one exactly on it', () => {
    const p = params({ band: band(48_000, 52_000) })
    expect(evaluateOnchainReceiveFill({ ...p, outputs: [output(52_001, 1)] }).fill).toBe('refuse')
    expect(evaluateOnchainReceiveFill({ ...p, outputs: [output(52_000)] })).toMatchObject({
      fill: 'adopt',
      fundedValueSats: 52_000,
      fundedPayoutSats: 51_450,
    })
  })
})

describe('what has not confirmed yet is not yet anything', () => {
  it('waits on an out-of-band output that could still be replaced', () => {
    expect(evaluateOnchainReceiveFill(params({ outputs: [output(9_000, 0)] })).fill).toBe('wait')
  })

  it('waits on no outputs at all', () => {
    expect(evaluateOnchainReceiveFill(params()).fill).toBe('wait')
  })

  it('refuses the same value once it confirms', () => {
    expect(evaluateOnchainReceiveFill(params({ outputs: [output(9_000, 1)] })).fill).toBe('refuse')
  })

  it('names both bounds in the refusal when a band is in play', () => {
    const result = evaluateOnchainReceiveFill(params({ band: band(48_000, 52_000), outputs: [output(9_000, 1)] }))
    if (result.fill !== 'refuse') throw new Error('expected a refusal')
    expect(result.reason).toContain('quote accepts 48000 to 52000')
  })
})

describe('one output funds one swap', () => {
  it('never sums two under-band outputs into an in-band one', () => {
    const p = params({ band: band(48_000, 52_000), outputs: [output(25_000, 1), output(25_000, 1)] })
    expect(evaluateOnchainReceiveFill(p).fill).toBe('refuse')
  })

  it('adopts the first in-band output and ignores a second payment', () => {
    const p = params({ band: band(48_000, 52_000), outputs: [output(49_000), output(51_000)] })
    expect(evaluateOnchainReceiveFill(p)).toMatchObject({ fill: 'adopt', fundedValueSats: 49_000 })
  })

  it('finds an in-band output sitting behind an out-of-band one', () => {
    const p = params({ band: band(48_000, 52_000), outputs: [output(3_000, 1), output(51_000)] })
    expect(evaluateOnchainReceiveFill(p)).toMatchObject({ fill: 'adopt', fundedValueSats: 51_000 })
  })
})

describe('the operator caps how much flexibility it offers', () => {
  it('derives its default from the range the operator already serves', () => {
    expect(defaultMaxBandWidthSats(limits)).toBe(999_000)
  })

  it('leaves a band inside the cap exactly as asked', () => {
    expect(clampOnchainReceiveBand(band(49_000, 51_000), quote.amountSats, 5_000)).toEqual(band(49_000, 51_000))
  })

  it('narrows a wider band around the quote rather than to one end', () => {
    expect(clampOnchainReceiveBand(band(10_000, 90_000), quote.amountSats, 1_000)).toEqual(band(49_500, 50_500))
  })

  it('never widens a band the client asked to be narrow', () => {
    expect(clampOnchainReceiveBand(band(49_900, 50_000), quote.amountSats, 999_000)).toEqual(band(49_900, 50_000))
  })

  it('holds the cap on an odd width', () => {
    const clamped = clampOnchainReceiveBand(band(10_000, 90_000), quote.amountSats, 999)
    expect(clamped.maxFromSats - clamped.minFromSats).toBe(999)
  })
})
