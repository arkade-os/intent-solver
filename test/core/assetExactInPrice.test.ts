/** ONE rounding: `computeWantAmount` floors once, and a second rounding here pays under it. */

import { describe, it, expect } from 'vitest'
import { computeWantAmount } from '@arkade-os/solver-discovery'
import { assetExactInPayout, assetExactOutInput } from '@arkade-os/solver-core/core/assetExactInPrice.js'
import { offerWithinTolerance } from '@arkade-os/solver-core/core/assetOfferPrice.js'

const BPS = 10_000n
const pow10 = (n: number): bigint => 10n ** BigInt(n)

const AMOUNTS = [1n, 7n, 333n, 15_977n, 100_000n, 1_234_567n, 10n ** 9n]
const FEEDS = [
  { mantissa: 100_000n, scale: 0 },
  { mantissa: 9_876_543n, scale: 2 },
  { mantissa: 7n, scale: 3 },
  { mantissa: 1n, scale: 0 },
]
// base >= quote: `registryCard.ts` refuses a market needing negative price_decimals.
const DECIMALS = [
  [8, 6],
  [8, 2],
  [8, 8],
  [18, 6],
  [18, 18],
] as const
const FEE_BPS = [0, 1, 25, 50, 900, 9_999]

interface Case {
  netInput: bigint
  givesBase: boolean
  baseDecimals: number
  quoteDecimals: number
  feeBps: number
  toleranceBps: number
  feed: { mantissa: bigint; scale: number }
}

const grid = (toleranceBps = 0): Case[] => {
  const out: Case[] = []
  for (const netInput of AMOUNTS) {
    for (const feed of FEEDS) {
      for (const [baseDecimals, quoteDecimals] of DECIMALS) {
        for (const feeBps of FEE_BPS) {
          for (const givesBase of [true, false]) {
            out.push({ netInput, givesBase, baseDecimals, quoteDecimals, feeBps, toleranceBps, feed })
          }
        }
      }
    }
  }
  return out
}

const label = (c: Case): string =>
  `${c.netInput} ${c.givesBase ? 'base->quote' : 'quote->base'} d${c.baseDecimals}/${c.quoteDecimals} ` +
  `fee ${c.feeBps} tol ${c.toleranceBps} feed ${c.feed.mantissa}e-${c.feed.scale}`

/** The tolerance-adjusted value the payout is a share of, as an exact rational. */
const value = (c: Case): { num: bigint; den: bigint } => {
  const scale = pow10(c.feed.scale)
  const baseUnit = pow10(c.baseDecimals)
  const quoteUnit = pow10(c.quoteDecimals)
  const tol = BigInt(c.toleranceBps)
  return c.givesBase
    ? { num: c.netInput * c.feed.mantissa * (BPS + tol) * quoteUnit, den: baseUnit * scale * BPS }
    : { num: c.netInput * baseUnit * scale * BPS, den: quoteUnit * c.feed.mantissa * (BPS - tol) }
}

const twoRoundings = (c: Case): bigint => {
  const { num, den } = value(c)
  const mid = num / den
  return mid - (mid * BigInt(c.feeBps) + BPS - 1n) / BPS
}

describe('assetExactInPayout agrees with the published client', () => {
  it('equals computeWantAmount at every grid point, both directions', () => {
    const mismatched = grid()
      .map((c) => {
        const client = computeWantAmount({
          deposit: c.netInput,
          give: c.givesBase ? 'base' : 'quote',
          price: { num: c.feed.mantissa * pow10(c.quoteDecimals), den: pow10(c.baseDecimals) * pow10(c.feed.scale) },
          feeBps: c.feeBps,
          safetyBps: 0,
        })
        const ours = assetExactInPayout(c)
        return ours === client ? null : `${label(c)}: solver ${ours}, client ${client}`
      })
      .filter((m) => m !== null)
    expect(mismatched.slice(0, 5)).toEqual([])
  })
})

describe('the offer gate takes what the client was shown', () => {
  // The reported symptom: a client-computed want at exactly the card's fee, refused by one.
  it('accepts a want computed by computeWantAmount at the card fee', () => {
    const feed = { mantissa: 9_876_543n, scale: 2 }
    const depositAmount = 16_202n
    const wantAmount = computeWantAmount({
      deposit: depositAmount,
      give: 'base',
      price: { num: feed.mantissa * pow10(6), den: pow10(8) * pow10(2) },
      feeBps: 50,
      safetyBps: 0,
    })
    expect(wantAmount).toBe(15_921_965n)
    const market = { baseDecimals: 8, quoteDecimals: 6, toleranceBps: 0, feeBps: 50 }
    expect(offerWithinTolerance({ depositAmount, wantAmount, direction: 'sell_base', market, feed })).toBe(true)
  })
})

describe('assetExactInPayout is a single floor of the conceded value', () => {
  it.each([0, 250, 9_999])('never pays more than (BPS - feeBps)/BPS of the value, at tolerance %i', (toleranceBps) => {
    const overpaid = grid(toleranceBps)
      .filter((c) => {
        const { num, den } = value(c)
        return assetExactInPayout(c) * den * BPS > num * (BPS - BigInt(c.feeBps))
      })
      .map(label)
    expect(overpaid.slice(0, 5)).toEqual([])
  })

  it.each([0, 250, 9_999])('is the LARGEST such amount, at tolerance %i', (toleranceBps) => {
    const short = grid(toleranceBps)
      .filter((c) => {
        const { num, den } = value(c)
        return num * (BPS - BigInt(c.feeBps)) >= (assetExactInPayout(c) + 1n) * den * BPS
      })
      .map(label)
    expect(short.slice(0, 5)).toEqual([])
  })

  it('concedes at most one atomic unit against the two-rounding formula, and never less', () => {
    const diffs = grid(250).map((c) => assetExactInPayout(c) - twoRoundings(c))
    expect([...new Set(diffs)].sort().map(String)).toEqual(['0', '1'])
  })
})

describe('assetExactOutInput follows the forward function', () => {
  const priced = grid(250).filter((c) => assetExactInPayout(c) > 0n)
  // Without the drop, the search's own netInput loses to this one on the spread.
  const rateOf = ({ netInput: _dropped, ...rate }: Case): Omit<Case, 'netInput'> => rate

  it('returns the least input reaching the payout', () => {
    const wrong = priced
      .filter((c) => {
        const payout = assetExactInPayout(c)
        const netInput = assetExactOutInput({ payout, ...rateOf(c) })
        if (netInput === null) return true
        if (assetExactInPayout({ ...c, netInput }) < payout) return true
        return netInput > 1n && assetExactInPayout({ ...c, netInput: netInput - 1n }) >= payout
      })
      .map(label)
    expect(wrong.slice(0, 5)).toEqual([])
  })

  it('keeps the fee on the input it solves back to', () => {
    const atALoss = priced
      .filter((c) => {
        const payout = assetExactInPayout(c)
        const netInput = assetExactOutInput({ payout, ...rateOf(c) })
        if (netInput === null) return true
        const { num, den } = value({ ...c, netInput })
        return payout * den * BPS > num * (BPS - BigInt(c.feeBps))
      })
      .map(label)
    expect(atALoss.slice(0, 5)).toEqual([])
  })

  it('prices a monotonic non-decreasing payout, which the search assumes', () => {
    const regressed: string[] = []
    for (const c of grid(250).slice(0, 240)) {
      let previous = -1n
      for (let netInput = 1n; netInput <= 5_000n; netInput += 379n) {
        const payout = assetExactInPayout({ ...c, netInput })
        if (payout < previous) regressed.push(`${label(c)} at ${netInput}`)
        previous = payout
      }
    }
    expect(regressed.slice(0, 5)).toEqual([])
  })
})
