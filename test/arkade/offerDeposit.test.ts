/**
 * The observed half of the offer-fill decision.
 *
 * Every case here is one an offer could actually arrive in, and each maps to a
 * way the decision goes wrong if the summing does: money at another script
 * counted as this offer's, a spent deposit resurrected, a multi-payment deposit
 * undercounted so a fillable offer refuses for being short, or a 256-bit asset
 * amount narrowed on its way through.
 */

import { describe, it, expect } from 'vitest'
import type { ExtendedContractVtxo } from '@arkade-os/sdk'
import { offerDepositFrom, type OfferOutputView } from '@arkade-os/solver-arkade/arkade/offerDeposit.js'
import { offerFillInputFrom } from '@arkade-os/solver-arkade/arkade/offerFill.js'

/**
 * What the contract manager hands back must satisfy `OfferOutputView`.
 *
 * A compile-time assertion, because it is the one property no runtime test can
 * reach: the module names its fields structurally rather than importing the
 * type, so an SDK bump renaming `isSwept` or turning `value` into a string would
 * leave every test below green while the production caller stopped compiling —
 * or worse, kept compiling against a field that no longer exists. `tsc` fails
 * here instead.
 *
 * `ExtendedContractVtxo` is what `getContractsWithVtxos()` returns, which is the
 * local-repository read this module is built around. Pinning the indexer's
 * `Vtxo` here instead would pass just as happily and prove the wrong thing —
 * the two shapes disagree about both `value` and the asset amount type.
 */
const _satisfiesContractVtxo: (v: ExtendedContractVtxo) => OfferOutputView = (v) => v

const SCRIPT = '5120' + 'ab'.repeat(32)
const OTHER = '5120' + 'cd'.repeat(32)
const USD = '41bcbb06921a0e9f6fe4f1b003b878cbb43d9ca3f6d14cab7940090458765a390000'
const EUR = '7cfc24fc9b275633780502ba8d7bf8431501b52246856df8d402e4bc9627ebc90000'

const out = (over: Partial<OfferOutputView> = {}): OfferOutputView => ({
  script: SCRIPT,
  value: 100_000,
  isSpent: false,
  isSwept: false,
  ...over,
})

describe('offerDepositFrom', () => {
  it('reads the sats sitting at the offer’s own script', () => {
    expect(offerDepositFrom(SCRIPT, [out()])).toEqual({ sats: 100_000n })
  })

  it('sums a deposit that arrived in more than one payment', () => {
    // Nothing says an offer is funded once. A reader that took the first output
    // would undercount and refuse a fillable offer as `offer_unfunded`.
    const deposit = offerDepositFrom(SCRIPT, [out({ value: 60_000 }), out({ value: 40_000 })])
    expect(deposit.sats).toBe(100_000n)
  })

  it('ignores outputs at any other script', () => {
    // The direction that matters: another script's money must never be counted
    // toward this offer. Being handed them is normal — the caller passes on
    // whatever the repository held.
    const deposit = offerDepositFrom(SCRIPT, [out(), out({ script: OTHER, value: 9_999_999 })])
    expect(deposit.sats).toBe(100_000n)
  })

  it('matches the script case-insensitively, since hex has two spellings', () => {
    expect(offerDepositFrom(SCRIPT.toUpperCase(), [out()]).sats).toBe(100_000n)
  })

  it.each([
    ['spent', { isSpent: true }],
    ['swept', { isSwept: true }],
  ])('does not resurrect a %s deposit', (_why, over) => {
    // The output still has a history in the repository. Counting it would let an
    // offer be filled against a deposit that is already gone.
    expect(offerDepositFrom(SCRIPT, [out(over)])).toEqual({ sats: 0n })
  })

  it('treats an absent spent/swept flag as not flagged', () => {
    // Both are optional on this shape. Reading absence as "unknown, so skip"
    // would make every unflagged output invisible and every offer unfunded.
    expect(offerDepositFrom(SCRIPT, [{ script: SCRIPT, value: 100_000 }]).sats).toBe(100_000n)
  })

  it('sums one asset across several outputs, and several assets across one', () => {
    const deposit = offerDepositFrom(SCRIPT, [
      out({ value: 1_000, assets: [{ assetId: USD, amount: 250n }] }),
      out({
        value: 2_000,
        assets: [
          { assetId: USD, amount: 750n },
          { assetId: EUR, amount: 40n },
        ],
      }),
    ])
    expect(deposit.sats).toBe(3_000n)
    expect(deposit.assets).toEqual([
      { assetId: USD, amount: 1_000n },
      { assetId: EUR, amount: 40n },
    ])
  })

  it('omits `assets` entirely when the deposit carries none', () => {
    // Matching the repository and what `heldOf` already expects. An empty array
    // would invite a caller to read emptiness as an observed fact.
    expect(offerDepositFrom(SCRIPT, [out()])).not.toHaveProperty('assets')
  })

  it('keeps a 256-bit asset amount exact across a sum', () => {
    // The reason the SDK types these as `bigint` at all. Any route through
    // `Number` loses this well before the top of the range, and a sum is where
    // a widening conversion would actually show.
    const huge = 123456789012345678901234567890n
    const deposit = offerDepositFrom(SCRIPT, [
      out({ assets: [{ assetId: USD, amount: huge }] }),
      out({ assets: [{ assetId: USD, amount: 1n }] }),
    ])
    expect(deposit.assets?.[0]?.amount).toBe(huge + 1n)
  })

  /**
   * Sats arrive as a JS number, so their failures are numeric ones.
   *
   * Each would corrupt a total silently rather than fail: a fraction makes the
   * sum fractional, a negative makes an offer read as holding less than it does
   * — up to reading as unfunded — and anything past `MAX_SAFE_INTEGER` is
   * already wrong before it is added to.
   */
  it.each([
    ['a fraction', 1.5],
    ['a negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['past MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses %s as a sats value', (_why, value) => {
    expect(() => offerDepositFrom(SCRIPT, [out({ value })])).toThrow(/nonsensical sats value/)
  })

  /**
   * The asset side's version of the same guard, which used to be missing.
   *
   * A `bigint` cannot be fractional, NaN or unsafely large, so a negative is the
   * only shape left — and it is the one that does damage, because entries are
   * SUMMED. A negative on one output cancels a positive on another and reports
   * the offer as holding less than the chain says, or as holding nothing, which
   * the decision reads as `offer_unfunded` for a deposit that exists.
   */
  it('refuses a negative asset amount, which would silently cancel a real one', () => {
    expect(() => offerDepositFrom(SCRIPT, [out({ value: 1000, assets: [{ assetId: USD, amount: -1n }] })])).toThrow(
      /negative amount of asset/,
    )
  })

  it('refuses it even when the total across outputs would come out positive', () => {
    // The failure the guard actually prevents: summed to 400n, this looks like a
    // perfectly ordinary deposit. Checking the total instead of each entry would
    // pass it, so the guard has to sit where the entries are read.
    expect(() =>
      offerDepositFrom(SCRIPT, [
        out({ value: 1000, assets: [{ assetId: USD, amount: 500n }] }),
        out({ value: 1000, assets: [{ assetId: USD, amount: -100n }] }),
      ]),
    ).toThrow(/negative amount of asset/)
  })

  it('carries a genuine zero on either side rather than dropping it', () => {
    // Zero is a real amount. A reader that treated it as "nothing here" would
    // drop the asset entry entirely and report the wrong shape to the decision.
    expect(offerDepositFrom(SCRIPT, [out({ value: 0 })])).toEqual({ sats: 0n })
    expect(offerDepositFrom(SCRIPT, [out({ value: 0, assets: [{ assetId: USD, amount: 0n }] })])).toEqual({
      sats: 0n,
      assets: [{ assetId: USD, amount: 0n }],
    })
  })
})

describe('feeding the decision', () => {
  /**
   * `swapPkScript` is empty here on purpose: `offerDepositFrom` takes the script
   * as its own hex argument and never reads it off the offer, so the mock's copy
   * is unused by this path. The real wiring — decode the packet, take
   * `swapPkScript` from it, hand the hex to both — lands with the quote step.
   */
  const offer = {
    swapPkScript: new Uint8Array(),
    wantAmount: 50_000n,
    wantAsset: undefined,
    offerAsset: { toString: () => USD },
    makerPkScript: new Uint8Array(),
    makerPublicKey: new Uint8Array(),
    emulatorPubkey: new Uint8Array(),
  }

  /**
   * The join this module exists for: a decoded offer plus an observed deposit
   * becomes the decision's input, with `offerAmount` coming from the CHAIN and
   * never from the packet.
   */
  it('supplies the offerAmount the packet does not carry', () => {
    const deposit = offerDepositFrom(SCRIPT, [
      out({ value: 1_000, assets: [{ assetId: USD, amount: 400n }] }),
      out({ value: 1_000, assets: [{ assetId: USD, amount: 600n }] }),
    ])

    expect(offerFillInputFrom(offer as never, deposit)).toEqual({
      wantAssetId: null,
      wantAmount: 50_000n,
      offerAssetId: USD,
      offerAmount: 1_000n,
    })
  })

  it('reports an unfunded offer as holding nothing, rather than throwing', () => {
    // `offer_unfunded` is the decision's own refusal and belongs to it. This
    // layer's job is to say truthfully that nothing is there.
    const input = offerFillInputFrom(offer as never, offerDepositFrom(SCRIPT, []))
    expect(input.offerAmount).toBe(0n)
  })
})
