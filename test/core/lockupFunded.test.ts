/**
 * Whether a lockup holds what the quote said it would.
 *
 * The asset half is the point. Every funding gate today sums `.value` and
 * compares it to a sats figure — correct while sats ARE the amount, and wrong
 * the moment the amount lives in an asset, because a lockup funded with the
 * right sats carrier and the wrong asset amount reads as funded.
 *
 * The covenant will not catch that: `enforcePayToAsset` relates the refund
 * output to the input (`out >= in`), which is the only correct rule for a
 * refund. Binding it to the quote would refund an underfunding client MORE
 * than they locked.
 */

import { describe, it, expect } from 'vitest'
import { lockupIsFunded, type FundedOutputView } from '@arkade-os/solver-core/core/lockupFunded.js'

const ASSET = 'b227e0d9'.repeat(8) + '0000'
const OTHER = 'ffffffff'.repeat(8) + '0001'

const out = (value: number, assets?: readonly { assetId: string; amount: bigint }[]): FundedOutputView =>
  assets ? { value, assets } : { value }

describe('sats', () => {
  it('is funded at exactly the quoted amount', () => {
    expect(lockupIsFunded([out(100_000)], { kind: 'sats', amount: 100_000 })).toBe(true)
  })

  it('is not funded one sat short', () => {
    expect(lockupIsFunded([out(99_999)], { kind: 'sats', amount: 100_000 })).toBe(false)
  })

  it('sums several outputs, since a lockup can be funded by more than one payment', () => {
    expect(lockupIsFunded([out(60_000), out(40_000)], { kind: 'sats', amount: 100_000 })).toBe(true)
  })

  it('accepts an overpayment, since the quote already fixed what is owed', () => {
    expect(lockupIsFunded([out(250_000)], { kind: 'sats', amount: 100_000 })).toBe(true)
  })

  it('is not funded by an empty read', () => {
    expect(lockupIsFunded([], { kind: 'sats', amount: 1 })).toBe(false)
  })
})

describe('an asset', () => {
  it('is funded when the NAMED asset covers the amount', () => {
    expect(
      lockupIsFunded([out(330, [{ assetId: ASSET, amount: 1_000n }])], {
        kind: 'asset',
        assetId: ASSET,
        amount: 1_000n,
      }),
    ).toBe(true)
  })

  it('is NOT funded by a different asset, however much of it there is', () => {
    // The case a "does it carry assets" check waves through, and the cheapest
    // one for a client to construct: mint something worthless, lock a lot of it.
    expect(
      lockupIsFunded([out(330, [{ assetId: OTHER, amount: 10n ** 18n }])], {
        kind: 'asset',
        assetId: ASSET,
        amount: 1_000n,
      }),
    ).toBe(false)
  })

  it('counts only the named asset when several ride together', () => {
    const outputs = [
      out(330, [
        { assetId: OTHER, amount: 10n ** 18n },
        { assetId: ASSET, amount: 400n },
      ]),
      out(330, [{ assetId: ASSET, amount: 600n }]),
    ]
    expect(lockupIsFunded(outputs, { kind: 'asset', assetId: ASSET, amount: 1_000n })).toBe(true)
    expect(lockupIsFunded(outputs, { kind: 'asset', assetId: ASSET, amount: 1_001n })).toBe(false)
  })

  it('IGNORES the sats entirely on the asset side', () => {
    // A carrier's sats are not the amount. A lockup fat with sats and short of
    // the asset is not funded, and the reverse is funded.
    expect(
      lockupIsFunded([out(100_000_000, [{ assetId: ASSET, amount: 1n }])], {
        kind: 'asset',
        assetId: ASSET,
        amount: 1_000n,
      }),
    ).toBe(false)
    expect(
      lockupIsFunded([out(330, [{ assetId: ASSET, amount: 1_000n }])], {
        kind: 'asset',
        assetId: ASSET,
        amount: 1_000n,
      }),
    ).toBe(true)
  })

  it('is not funded by an output carrying no assets at all', () => {
    expect(lockupIsFunded([out(100_000)], { kind: 'asset', assetId: ASSET, amount: 1n })).toBe(false)
  })

  it('handles amounts past what a double holds', () => {
    // An asset amount is not bounded by 2^53, and the SDK types it bigint for
    // exactly this reason.
    const big = 123_456_789_012_345_678_901n
    expect(
      lockupIsFunded([out(330, [{ assetId: ASSET, amount: big }])], { kind: 'asset', assetId: ASSET, amount: big }),
    ).toBe(true)
    expect(
      lockupIsFunded([out(330, [{ assetId: ASSET, amount: big - 1n }])], {
        kind: 'asset',
        assetId: ASSET,
        amount: big,
      }),
    ).toBe(false)
  })

  it('refuses a zero expectation rather than calling it trivially met', () => {
    // An asset lockup for nothing is not a lockup. Answering true would let a
    // quote that mispriced its way to zero settle as funded.
    expect(
      lockupIsFunded([out(330, [{ assetId: ASSET, amount: 5n }])], { kind: 'asset', assetId: ASSET, amount: 0n }),
    ).toBe(false)
    expect(lockupIsFunded([], { kind: 'asset', assetId: ASSET, amount: 0n })).toBe(false)
  })
})
