/**
 * The adapter that finally gives `evaluateOfferFill` a caller.
 *
 * The interesting half is `offerAmount`. It is NOT in the offer packet — `Offer`
 * carries `wantAmount` and nothing about the deposit — so it has to be observed
 * on chain. That is what these tests are mostly about: an offer's claim about
 * its own funding is not evidence, and the only reason it cannot be read as
 * evidence is that the signature has nowhere to put it.
 */

import { describe, it, expect } from 'vitest'
import { offerFillInputFrom, type OfferDeposit } from '@arkade-os/solver-arkade/arkade/offerFill.js'
import { evaluateOfferFill, type OfferFillPolicy } from '@arkade-os/solver-core/core/assetOffer.js'

const ASSET = 'b227e0d9'.repeat(8) + '0000'
const OTHER = 'ffffffff'.repeat(8) + '0001'

/** Only the fields the adapter reads; the rest of `Offer` is script material. */
const offerOf = (over: Record<string, unknown> = {}) =>
  ({
    swapPkScript: new Uint8Array(34),
    wantAmount: 100_000n,
    makerPkScript: new Uint8Array(34),
    makerPublicKey: new Uint8Array(32),
    emulatorPubkey: new Uint8Array(32),
    ...over,
  }) as never

/** An `AssetId` stand-in: the adapter needs `toString()` and nothing else. */
const id = (hex: string) => ({ toString: () => hex })

describe('reading the two legs', () => {
  it('maps a BTC want and an asset deposit', () => {
    const input = offerFillInputFrom(offerOf({ offerAsset: id(ASSET) }), {
      sats: 330n,
      assets: [{ assetId: ASSET, amount: 5_000n }],
    })
    expect(input).toEqual({
      wantAssetId: null,
      wantAmount: 100_000n,
      offerAssetId: ASSET,
      offerAmount: 5_000n,
    })
  })

  it('maps an asset want and a BTC deposit', () => {
    // The mirror, and the one where `offerAmount` is the deposit's SATS.
    const input = offerFillInputFrom(offerOf({ wantAsset: id(ASSET), wantAmount: 7n }), { sats: 250_000n })
    expect(input).toEqual({
      wantAssetId: ASSET,
      wantAmount: 7n,
      offerAssetId: null,
      offerAmount: 250_000n,
    })
  })

  it('uses null for BTC rather than a sentinel id', () => {
    // The packet OMITS the field for BTC; `evaluateOfferFill` keys its markets
    // and inventory on null. A stand-in string here would miss every market.
    const input = offerFillInputFrom(offerOf({}), { sats: 1n })
    expect(input.wantAssetId).toBeNull()
    expect(input.offerAssetId).toBeNull()
  })
})

describe('the deposit is observed, never taken on trust', () => {
  it('counts ONLY the asset the offer says it deposited', () => {
    // The cheapest attack available: mint something worthless, deposit a lot of
    // it, claim to have deposited the valuable one. A "does it carry assets"
    // read waves this through.
    const input = offerFillInputFrom(offerOf({ offerAsset: id(ASSET) }), {
      sats: 330n,
      assets: [{ assetId: OTHER, amount: 10n ** 18n }],
    })
    expect(input.offerAmount).toBe(0n)
  })

  it('sums the named asset across outputs, since an offer can be funded twice', () => {
    const input = offerFillInputFrom(offerOf({ offerAsset: id(ASSET) }), {
      sats: 660n,
      assets: [
        { assetId: OTHER, amount: 10n ** 18n },
        { assetId: ASSET, amount: 400n },
        { assetId: ASSET, amount: 600n },
      ],
    })
    expect(input.offerAmount).toBe(1_000n)
  })

  it('reports nothing deposited when the outputs carry no assets at all', () => {
    const input = offerFillInputFrom(offerOf({ offerAsset: id(ASSET) }), { sats: 100_000n })
    expect(input.offerAmount).toBe(0n)
  })

  it('IGNORES the sats when the deposit leg is an asset', () => {
    // A carrier's sats are not the deposit. An offer fat with sats and holding
    // none of the asset it named has deposited nothing.
    const input = offerFillInputFrom(offerOf({ offerAsset: id(ASSET) }), {
      sats: 100_000_000n,
      assets: [{ assetId: OTHER, amount: 1n }],
    })
    expect(input.offerAmount).toBe(0n)
  })
})

describe('feeding the decision it was written for', () => {
  const policy: OfferFillPolicy = {
    markets: [{ a: null, b: ASSET }],
    available: new Map<string | null, bigint>([
      [null, 10_000_000n],
      [ASSET, 1_000_000n],
    ]),
    minFillAmount: 1_000n,
    maxFillAmount: 1_000_000n,
  }

  it('fills an offer that is served, affordable and actually funded', () => {
    const input = offerFillInputFrom(offerOf({ offerAsset: id(ASSET) }), {
      sats: 330n,
      assets: [{ assetId: ASSET, amount: 5_000n }],
    })
    expect(evaluateOfferFill(input, policy)).toEqual({ fill: true })
  })

  it('refuses an offer whose deposit is not there, on the observation alone', () => {
    // THE POINT OF THE WHOLE FILE. Identical packet to the test above — same
    // want, same declared deposit asset — and the only difference is what the
    // chain holds. Read from the packet, this would fill for nothing.
    const input = offerFillInputFrom(offerOf({ offerAsset: id(ASSET) }), {
      sats: 330n,
      assets: [{ assetId: OTHER, amount: 5_000n }],
    })
    expect(evaluateOfferFill(input, policy)).toEqual({ fill: false, reason: 'offer_unfunded' })
  })

  it('refuses a pair this solver does not serve', () => {
    const input = offerFillInputFrom(offerOf({ wantAsset: id(OTHER), offerAsset: id(ASSET) }), {
      sats: 330n,
      assets: [{ assetId: ASSET, amount: 5_000n }],
    })
    expect(evaluateOfferFill(input, policy)).toEqual({ fill: false, reason: 'unsupported_pair' })
  })
})
