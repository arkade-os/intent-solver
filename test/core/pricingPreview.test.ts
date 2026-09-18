import { describe, it, expect } from 'vitest'
import { decomposeAssetQuote, decomposeCorridorQuote } from '@arkade-os/solver-core/core/pricingPreview.js'
import { carrierLegs, resolveAssetQuote, type AssetQuoteMarket } from '@arkade-os/solver-core/core/assetRfq.js'
import { assetExactInPayout } from '@arkade-os/solver-core/core/assetExactInPrice.js'
import { giveSatsFor, payoutSatsFor } from '@arkade-os/solver-core/core/corridorPolicy.js'

const USDX = 'cc'.repeat(34)
const feed = { mantissa: 100_000n, scale: 0 }
const sellUsdx: AssetQuoteMarket = {
  base: null,
  quote: USDX,
  baseDecimals: 8,
  quoteDecimals: 6,
  feeBps: 50,
  minPayout: 1n,
  // Large enough that the million-sat sample below isn't refused by it.
  maxPayout: 100_000_000_000n,
}
const pair = { from: null, to: USDX }

describe('decomposeAssetQuote agrees with the quote it decomposes', () => {
  const at = (amount: bigint, amountSide: 'from' | 'to', carrierSats = 330n) => ({
    preview: decomposeAssetQuote({ pair, amount, amountSide, market: sellUsdx, feed, carrierSats, dustSats: 330n }),
    quote: resolveAssetQuote({ pair, amount, amountSide, market: sellUsdx, feed, carrierSats, dustSats: 330n }),
  })

  it.each([
    [1_000n, 'from' as const],
    [100_000n, 'from' as const],
    [1_000_000n, 'from' as const],
    [500_000n, 'to' as const],
  ])('reports the same two amounts at %s on the %s side', (amount, side) => {
    const { preview, quote } = at(amount, side)
    expect(quote.ok).toBe(true)
    expect(preview).toMatchObject({ ok: true, fromAmount: (quote as { fromAmount: bigint }).fromAmount })
    expect(preview).toMatchObject({ toAmount: (quote as { toAmount: bigint }).toAmount })
  })

  it('passes a refusal through unchanged rather than inventing a zero', () => {
    expect(at(200n, 'from').preview).toEqual({ ok: false, reason: 'fee_consumes_swap' })
  })

  it('recovers the exact netInput the quote priced on', () => {
    // The one subtraction in the module, pinned against the forward function.
    const decomposed = at(100_000n, 'from').preview
    if (!decomposed.ok) throw new Error('expected a quote')
    const netInput = decomposed.fromAmount - decomposed.flatFee - decomposed.carrierCharged
    const payout = assetExactInPayout({
      netInput,
      givesBase: true,
      baseDecimals: 8,
      quoteDecimals: 6,
      feeBps: 50,
      feed,
    })
    expect(payout).toBe(decomposed.toAmount - decomposed.carrierReturned)
  })

  it('measures margin inside the payout leg, on the mid rather than the input', () => {
    const decomposed = at(100_000n, 'from').preview
    if (!decomposed.ok) throw new Error('expected a quote')
    expect(decomposed.midPayout).toBeGreaterThan(decomposed.toAmount - decomposed.carrierReturned)
    expect(decomposed.spreadFee).toBe(decomposed.midPayout - (decomposed.toAmount - decomposed.carrierReturned))
    expect(decomposed.marginBps).toBe(50)
  })

  it('puts the carrier on the deposit when the solver delivers the asset', () => {
    const decomposed = at(100_000n, 'from').preview
    if (!decomposed.ok) throw new Error('expected a quote')
    expect({ charged: decomposed.carrierCharged, returned: decomposed.carrierReturned }).toEqual(
      carrierLegs(pair, 330n),
    )
  })

  it('reads a flat 50 bps at every size once the carrier is priced', () => {
    for (const amount of [1_000n, 10_000n, 100_000n, 1_000_000n]) {
      const decomposed = at(amount, 'from').preview
      if (!decomposed.ok) throw new Error(`expected a quote at ${amount}`)
      expect(decomposed.marginBps).toBe(50)
    }
  })
})

describe('decomposeCorridorQuote', () => {
  const fee = { bps: 25, flatSats: 150 }
  const limits = { minSats: 1_000, maxSats: 100_000 }

  it('splits the fee without rounding it twice', () => {
    const decomposed = decomposeCorridorQuote({ amountSats: 100_000, amountSide: 'from', fee, limits })
    if (!decomposed.ok) throw new Error('expected a quote')
    expect(decomposed.payoutSats).toBe(payoutSatsFor(100_000, fee))
    expect(decomposed.spreadSats).toBe(250)
    expect(decomposed.flatSats).toBe(150)
    expect(decomposed.spreadSats + decomposed.flatSats).toBe(100_000 - decomposed.payoutSats)
  })

  it('bounds the GIVE leg, which is the opposite convention to the asset markets', () => {
    expect(decomposeCorridorQuote({ amountSats: 999, amountSide: 'from', fee, limits })).toEqual({
      ok: false,
      reason: 'below_min',
    })
    expect(decomposeCorridorQuote({ amountSats: 100_001, amountSide: 'from', fee, limits })).toEqual({
      ok: false,
      reason: 'above_max',
    })
  })

  it('names the give a taker must send for a payout, through giveSatsFor', () => {
    const decomposed = decomposeCorridorQuote({ amountSats: 50_000, amountSide: 'to', fee, limits })
    if (!decomposed.ok) throw new Error('expected a quote')
    expect(decomposed.giveSats).toBe(giveSatsFor(50_000, fee))
    expect(decomposed.payoutSats).toBeGreaterThanOrEqual(50_000)
  })

  it('refuses rather than paying out nothing when the flat eats the swap', () => {
    expect(
      decomposeCorridorQuote({ amountSats: 100, amountSide: 'from', fee, limits: { minSats: 1, maxSats: 100_000 } }),
    ).toEqual({ ok: false, reason: 'fee_consumes_swap' })
  })
})
