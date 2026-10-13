/**
 * The guards on the fill, and the asset packet's two ordering rules.
 *
 * The transaction construction is NOT covered here — mocking a way through it
 * would assert that covenant code "works" on the strength of the mock.
 * `test/e2e/assetOffer.e2e.test.ts` settles a real offer instead.
 */
import { describe, it, expect } from 'vitest'
import { offerVtxoScript, type Offer } from '@arkade-os/swap'
import { schnorr } from '@noble/curves/secp256k1.js'
import { asset } from '@arkade-os/sdk'
import { fulfillOffer, ASSET_CARRIER_SATS, makerScriptHex } from '@arkade-os/solver-arkade/arkade/offerFulfill.js'
import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'

const xonly = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const SERVER = xonly(2)
const ASSET_ID = '41bcbb06921a0e9f6fe4f1b003b878cbb43d9ca3f6d14cab7940090458765a390000'
const ASSET_ID_B = '7cfc24fc9b275633780502ba8d7bf8431501b52246856df8d402e4bc9627ebc90000'

const terms = {
  wantAmount: 1_000n,
  wantAsset: undefined as unknown,
  offerAsset: undefined as unknown,
  makerPkScript: new Uint8Array(34).fill(0xcc),
  makerPublicKey: xonly(3),
  emulatorPubkey: xonly(4),
}
const offerWith = (over: Record<string, unknown> = {}): Offer => ({ ...terms, ...over }) as unknown as Offer
const honest = offerVtxoScript(offerWith({ swapPkScript: new Uint8Array(34) }), SERVER).pkScript

/** Only what the guards reach before any network call. */
const ctx = (over: Record<string, unknown> = {}): ArkadeContext =>
  ({
    wallet: {
      arkServerPublicKey: SERVER,
      getVtxos: async () => [],
      getSpendableVtxos: async () => [],
      getAddress: async () => 'tark1nobody',
      ...over,
    },
  }) as unknown as ArkadeContext

const deposit = { txid: 'a'.repeat(64), vout: 0, value: 900 }

const coin = { txid: 'b'.repeat(64), vout: 0, value: 100_000 }

const refusalOf = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => '',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

describe('fulfillOffer refuses before it spends', () => {
  it('aborts on an offer whose script does not match its terms (§ 5.1)', async () => {
    // Re-checked here rather than trusted from the caller: this is the function
    // that spends, and the MUST is about fulfillment.
    await expect(
      fulfillOffer(ctx(), 'http://emulator.test', offerWith({ swapPkScript: new Uint8Array(34).fill(0xab) }), deposit),
    ).rejects.toThrow(/offer inconsistency/)
  })

  it('aborts when the terms were changed under an honest script', async () => {
    await expect(
      fulfillOffer(ctx(), 'http://emulator.test', offerWith({ wantAmount: 9_000n, swapPkScript: honest }), deposit),
    ).rejects.toThrow(/offer inconsistency/)
  })

  it('refuses an offer naming an asset on both legs', async () => {
    // § 2.1: exactly one leg names an asset. Both is malformed, and guessing
    // which one the covenant meant is not a decision to make while spending.
    const both = offerWith({
      wantAsset: asset.AssetId.fromString(ASSET_ID),
      offerAsset: asset.AssetId.fromString(ASSET_ID_B),
    })
    const consistent = offerVtxoScript(both, SERVER).pkScript
    await expect(
      fulfillOffer(ctx(), 'http://emulator.test', offerWith({ ...both, swapPkScript: consistent }), deposit),
    ).rejects.toThrow(/exactly one leg/)
  })

  it('refuses when no coin can pay the maker', async () => {
    await expect(
      fulfillOffer(ctx(), 'http://emulator.test', offerWith({ swapPkScript: honest }), deposit),
    ).rejects.toThrow(/no spendable coins/)
  })

  it('will not fund a fill out of a coin the spending gate withholds', async () => {
    const withheld = ctx({ getVtxos: async () => [coin], getSpendableVtxos: async () => [] })
    await expect(
      fulfillOffer(withheld, 'http://emulator.test', offerWith({ swapPkScript: honest }), deposit),
    ).rejects.toThrow(/no spendable coins/)
  })

  it('and takes that same coin once the gate reports it spendable', async () => {
    const offered = ctx({ getVtxos: async () => [], getSpendableVtxos: async () => [coin] })
    const message = await refusalOf(
      fulfillOffer(offered, 'http://emulator.test', offerWith({ swapPkScript: honest }), deposit),
    )
    expect(message).not.toMatch(/no spendable coins/)
  })
})

describe('constants the covenant depends on', () => {
  it('carries the dust value an asset output[0] takes', () => {
    expect(ASSET_CARRIER_SATS).toBe(330n)
  })

  it('reports the maker script an offer pays', () => {
    expect(makerScriptHex(offerWith())).toBe('cc'.repeat(34))
  })
})
