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

  it('pins the full success shape, so an added field cannot pass silently', () => {
    expect(at(100_000n, 'from').preview).toEqual({
      ok: true,
      fromAmount: 100_000n,
      toAmount: 99_171_650n,
      midPayout: 99_670_000n,
      spreadFee: 498_350n,
      flatFee: 0n,
      carrierCharged: 330n,
      carrierReturned: 0n,
      marginBps: 50,
    })
  })

  it('returns the carrier into the payout on asset->BTC, where fronting it is the point', () => {
    const decomposed = decomposeAssetQuote({
      pair: { from: USDX, to: null },
      amount: 100_000_000n,
      amountSide: 'from',
      market: sellUsdx,
      feed,
      carrierSats: 330n,
      dustSats: 330n,
    })
    if (!decomposed.ok) throw new Error('expected a quote')
    expect(decomposed.carrierCharged).toBe(0n)
    expect(decomposed.carrierReturned).toBe(330n)
    expect(decomposed.marginBps).toBe(50)
  })

  it('nets the sell-base flat fee out of the notional before pricing the mid', () => {
    const decomposed = decomposeAssetQuote({
      pair,
      amount: 100_000_000n,
      amountSide: 'from',
      market: { ...sellUsdx, sellBaseFeeFlat: 500_000n },
      feed,
      carrierSats: 0n,
      dustSats: 330n,
    })
    if (!decomposed.ok) throw new Error('expected a quote')
    expect(decomposed.flatFee).toBe(500_000n)
    expect(decomposed.marginBps).toBe(50)
  })

  it('nets the buy-base flat fee out of the notional before pricing the mid', () => {
    const decomposed = decomposeAssetQuote({
      pair: { from: USDX, to: null },
      amount: 100_000_000n,
      amountSide: 'from',
      market: { ...sellUsdx, buyBaseFeeFlat: 500_000n },
      feed,
      carrierSats: 0n,
      dustSats: 330n,
    })
    if (!decomposed.ok) throw new Error('expected a quote')
    expect(decomposed.flatFee).toBe(500_000n)
    expect(decomposed.marginBps).toBe(50)
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

  it('pins the full success shape, so an added field like breakEven cannot pass silently', () => {
    expect(decomposeCorridorQuote({ amountSats: 100_000, amountSide: 'from', fee, limits })).toEqual({
      ok: true,
      giveSats: 100_000,
      payoutSats: payoutSatsFor(100_000, fee),
      spreadSats: 250,
      flatSats: 150,
      marginBps: 40,
    })
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

import { carrierBreakEven, offerAcceptanceCeiling } from '@arkade-os/solver-core/core/pricingPreview.js'
import { offerWithinTolerance } from '@arkade-os/solver-core/core/assetOfferPrice.js'

describe('carrierBreakEven', () => {
  it('is the size at which 50 bps covers 330 sats', () => {
    expect(carrierBreakEven({ carrierSats: 330n, flatSats: 0n, feeBps: 50 })).toEqual({
      kind: 'at',
      amountSats: 66_000n,
    })
  })

  it('says never rather than dividing, at the default spread of zero', () => {
    expect(carrierBreakEven({ carrierSats: 330n, flatSats: 0n, feeBps: 0 })).toEqual({ kind: 'never' })
  })

  it('has none when the flat already covers the carrier', () => {
    expect(carrierBreakEven({ carrierSats: 330n, flatSats: 330n, feeBps: 50 })).toEqual({ kind: 'none' })
    expect(carrierBreakEven({ carrierSats: 330n, flatSats: 400n, feeBps: 0 })).toEqual({ kind: 'none' })
  })

  it('has none when the carrier is priced, because it is recovered in full', () => {
    expect(carrierBreakEven({ carrierSats: 0n, flatSats: 0n, feeBps: 50 })).toEqual({ kind: 'none' })
  })

  it('starts from the flat and rounds up, so the figure is never under the true one', () => {
    const at = carrierBreakEven({ carrierSats: 330n, flatSats: 100n, feeBps: 33 })
    expect(at).toMatchObject({ kind: 'at' })
    if (at.kind !== 'at') return
    expect(at.amountSats).toBe(100n + (230n * 10_000n + 32n) / 33n)
    expect(((at.amountSats - 100n) * 33n) / 10_000n + 100n).toBeGreaterThanOrEqual(330n)
  })
})

describe('offerAcceptanceCeiling', () => {
  const market = {
    baseDecimals: 8,
    quoteDecimals: 6,
    toleranceBps: 10,
    feeBps: 50,
  }

  it('is the largest want the gate accepts, and one more is refused', () => {
    const args = { depositAmount: 100_000n, direction: 'sell_base' as const, market, feed }
    const ceiling = offerAcceptanceCeiling(args)
    expect(ceiling).not.toBeNull()
    expect(offerWithinTolerance({ ...args, wantAmount: ceiling! })).toBe(true)
    expect(offerWithinTolerance({ ...args, wantAmount: ceiling! + 1n })).toBe(false)
  })

  it('counts the returned carrier as headroom, exactly as the gate does', () => {
    const args = { depositAmount: 100_000n, direction: 'sell_base' as const, market, feed }
    const plain = offerAcceptanceCeiling(args)!
    const withCarrier = offerAcceptanceCeiling({ ...args, carrierReturned: 330n })!
    expect(withCarrier).toBe(plain + 330n)
  })

  it('is null when the gate accepts nothing at all', () => {
    expect(
      offerAcceptanceCeiling({
        depositAmount: 100_000n,
        direction: 'sell_base',
        market,
        feed: { mantissa: 0n, scale: 0 },
      }),
    ).toBeNull()
  })
})
