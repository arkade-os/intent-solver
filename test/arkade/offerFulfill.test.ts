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
import {
  fulfillOffer,
  buildAssetPacket,
  ASSET_CARRIER_SATS,
  makerScriptHex,
} from '@arkade-os/solver-arkade/arkade/offerFulfill.js'
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
      getAddress: async () => 'tark1nobody',
      ...over,
    },
  }) as unknown as ArkadeContext

const deposit = { txid: 'a'.repeat(64), vout: 0, value: 900 }

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
})

describe('the asset packet', () => {
  const groupIds = (packet: unknown): string[] =>
    ((packet as { groups?: { assetId: { toString(): string } }[] }).groups ?? []).map((g) => g.assetId.toString())

  const inputs = (entries: [number, { assetId: string; amount: bigint }[]][]) => new Map(entries)

  it('puts the WANTED asset at group index 0', () => {
    // The fulfill script's OP_INSPECTOUTASSETLOOKUP uses lookup_index = 0, so a
    // wanted asset anywhere else makes the covenant fail. Group order follows
    // insertion order, which is why the holder of the wanted asset is inserted
    // first — reordering that silently breaks the covenant.
    const packet = buildAssetPacket({
      wantedAssetId: ASSET_ID,
      wantAmount: 500n,
      inputAssets: inputs([
        [0, [{ assetId: ASSET_ID_B, amount: 900n }]],
        [1, [{ assetId: ASSET_ID, amount: 600n }]],
      ]),
    })
    expect(groupIds(packet)[0]).toBe(ASSET_ID)
  })

  it('puts it first even when ONE COIN carries it second', () => {
    // Entry order is not enough: a single input can hold an unrelated asset
    // ahead of the wanted one, and the group order follows the first id seen.
    const packet = buildAssetPacket({
      wantedAssetId: ASSET_ID,
      wantAmount: 100n,
      inputAssets: inputs([
        [
          1,
          [
            { assetId: ASSET_ID_B, amount: 50n },
            { assetId: ASSET_ID, amount: 300n },
          ],
        ],
      ]),
    })
    expect(groupIds(packet)[0]).toBe(ASSET_ID)
  })

  it('DECLARES an asset a funding coin merely happens to carry', () => {
    // arkd refuses with ASSET_NOT_FOUND when an input owns an asset the packet
    // does not mention. Coin selection picks for the wanted asset; whatever
    // else those coins hold comes along.
    const packet = buildAssetPacket({
      wantedAssetId: ASSET_ID,
      wantAmount: 100n,
      inputAssets: inputs([
        [1, [{ assetId: ASSET_ID, amount: 100n }]],
        [2, [{ assetId: ASSET_ID_B, amount: 7n }]],
      ]),
    })
    expect(groupIds(packet)).toEqual([ASSET_ID, ASSET_ID_B])
  })

  it('routes a deposit asset to us when the maker wants sats', () => {
    const packet = buildAssetPacket({
      wantedAssetId: undefined,
      wantAmount: 1_000n,
      inputAssets: inputs([[0, [{ assetId: ASSET_ID_B, amount: 900n }]]]),
    })
    expect(groupIds(packet)).toEqual([ASSET_ID_B])
  })

  it('builds nothing when no asset moves', () => {
    expect(buildAssetPacket({ wantedAssetId: undefined, wantAmount: 1_000n, inputAssets: new Map() })).toBeNull()
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
