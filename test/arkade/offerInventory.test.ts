/**
 * Which balance bucket counts as inventory.
 *
 * One judgement, and the tests are mostly about the way of getting it wrong that
 * looks right: a wallet reporting millions in `total` while `available` is zero.
 * That is not hypothetical — it is the state a regtest float lands in once its
 * batch expires, and it reads as a healthy wallet until something tries to spend.
 */

import { describe, it, expect } from 'vitest'
import { offerInventoryFrom } from '@arkade-os/solver-arkade/arkade/offerInventory.js'
import { evaluateOfferFill, type OfferFillPolicy } from '@arkade-os/solver-core/core/assetOffer.js'

const ASSET = 'b227e0d9'.repeat(8) + '0000'
const OTHER = 'ffffffff'.repeat(8) + '0001'

describe('the bucket', () => {
  it('keys BTC as null, matching how the decision reads it', () => {
    // The offer packet OMITS the asset field for BTC; the decision keys markets
    // and inventory on null. A sentinel string makes every BTC leg look
    // uncovered.
    const inventory = offerInventoryFrom({ available: 250_000, availableAssets: [] })
    expect(inventory.get(null)).toBe(250_000n)
    expect(inventory.has('btc')).toBe(false)
  })

  it('carries each asset under its own id', () => {
    const inventory = offerInventoryFrom({
      available: 1_000,
      availableAssets: [
        { assetId: ASSET, amount: 5_000n },
        { assetId: OTHER, amount: 7n },
      ],
    })
    expect(inventory.get(ASSET)).toBe(5_000n)
    expect(inventory.get(OTHER)).toBe(7n)
  })

  it('sums a repeated asset rather than letting the last entry win', () => {
    // Nothing in the SDK's type says an asset appears once, and a silent
    // overwrite understates the float — which refuses offers we could fill.
    const inventory = offerInventoryFrom({
      available: 0,
      availableAssets: [
        { assetId: ASSET, amount: 400n },
        { assetId: ASSET, amount: 600n },
      ],
    })
    expect(inventory.get(ASSET)).toBe(1_000n)
  })

  it('drops non-positive asset entries instead of carrying them', () => {
    const inventory = offerInventoryFrom({
      available: 0,
      availableAssets: [
        { assetId: ASSET, amount: 0n },
        { assetId: OTHER, amount: -5n },
      ],
    })
    expect(inventory.has(ASSET)).toBe(false)
    expect(inventory.has(OTHER)).toBe(false)
  })

  it('clamps a negative sats balance to zero rather than propagating it', () => {
    // The decision compares `wantAmount <= held`, so a negative refuses
    // everything while reading like a quiet market.
    expect(offerInventoryFrom({ available: -1, availableAssets: [] }).get(null)).toBe(0n)
  })
})

describe('the trap this file exists for', () => {
  const policy = (available: ReadonlyMap<string | null, bigint>): OfferFillPolicy => ({
    markets: [{ a: null, b: ASSET }],
    available,
    minFillAmount: 1_000n,
    maxFillAmount: 10_000_000n,
  })
  /** Maker wants 100_000 sats, deposits 5_000 of ASSET. */
  const offer = { wantAssetId: null, wantAmount: 100_000n, offerAssetId: ASSET, offerAmount: 5_000n }

  it('refuses when the float is real but NOT SPENDABLE', () => {
    // Observed on a live regtest float, verbatim: available 0, recoverable
    // 7_811_436, total 7_811_436. The batch expired, so coin selection will not
    // touch a sat of it until `recoverVtxos()` runs. A wallet in this state
    // looks rich and can pay nobody.
    const expiredFloat = offerInventoryFrom({ available: 0, availableAssets: [] })
    expect(evaluateOfferFill(offer, policy(expiredFloat))).toEqual({
      fill: false,
      reason: 'insufficient_inventory',
    })
  })

  it('fills the same offer once those coins are spendable again', () => {
    // The only thing that changed is the bucket. Built from `total`, both cases
    // would say yes — and the second would be the only one that was true.
    const recovered = offerInventoryFrom({ available: 7_811_436, availableAssets: [] })
    expect(evaluateOfferFill(offer, policy(recovered))).toEqual({ fill: true })
  })
})
