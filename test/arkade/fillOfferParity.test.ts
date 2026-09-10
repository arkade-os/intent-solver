/**
 * `fulfillOffer` reorders a vin-keyed map and calls `createAssetPacket`;
 * `fillOffer` makes one `withAsset` call per asset and relies on call order.
 * Both claim the WANTED asset lands at group index 0 — the lookup index
 * `OP_INSPECTOUTASSETLOOKUP` reads, so the covenant refuses anything else.
 *
 * Neither claim survives being read, so this runs the SDK through the REAL
 * builder (only the REST providers are stubbed), decodes the packet back out of
 * the ark tx, and compares it to what `buildAssetPacket` builds.
 */
import { describe, it, expect, vi } from 'vitest'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { buildAssetPacket } from '@arkade-os/solver-arkade/arkade/offerFulfill.js'

const state = vi.hoisted(() => ({
  vtxos: [] as unknown[],
  arkTx: undefined as string | undefined,
  prevTxs: new Map<string, string>(),
}))

vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@arkade-os/sdk')>()
  const SERVER = hex.decode('4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa')
  return {
    ...mod,
    RestArkProvider: class {
      async getInfo() {
        return {
          signerPubkey: `02${hex.encode(SERVER)}`,
          checkpointTapscript: hex.encode(
            mod.CSVMultisigTapscript.encode({
              timelock: { type: 'blocks', value: 10n },
              pubkeys: [SERVER],
            }).script,
          ),
        }
      }
    },
    RestIndexerProvider: class {
      async getVtxos() {
        return { vtxos: state.vtxos }
      }
      async getVirtualTxs(txids: string[]) {
        return { txs: txids.map((t) => state.prevTxs.get(t)).filter((p): p is string => p !== undefined) }
      }
    },
    RestEmulatorProvider: class {
      constructor(readonly url: string) {}
      async submitTx(arkTx: string, checkpointTxs: string[]) {
        state.arkTx = arkTx
        return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs }
      }
    },
  }
})

const { ArkAddress, Extension, MultisigTapscript, Transaction, VtxoScript, asset } = await import('@arkade-os/sdk')
const { encodeOffer, fillOffer, offerVtxoScript } = await import('@arkade-os/swap')
type Offer = import('@arkade-os/swap').Offer

const SERVER_KEY = hex.decode('4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa')
const MAKER_KEY = '71102fc86b5c576c72f411e083cc03eb83d1b55065406ba2a483208dbb5074ab'
const EMULATOR_KEY = '466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27'
const TAKER_PAYOUT = hex.decode('512035f737927627c4af1e9a39ae02b086c6b31426d0d64f01e5ce3ee8a445bbd667')
const ASSET_A = `${'aa'.repeat(32)}0000`
const ASSET_B = `${'bb'.repeat(32)}0000`

const takerKey = schnorr.getPublicKey(new Uint8Array(32).fill(0x7a))
const wallet = {
  identity: { xOnlyPublicKey: async () => takerKey, sign: async (tx: unknown) => tx },
  getAddress: async () => new ArkAddress(SERVER_KEY, hex.decode('22'.repeat(32)), 'tark').encode(),
  getContractManager: async () => null,
} as unknown as Parameters<typeof fillOffer>[0]

let minted = 0
const mintCoin = (value: number) => {
  const seed = ++minted
  const key = new Uint8Array([0x51, 0x20, ...schnorr.getPublicKey(new Uint8Array(32).fill(seed))])
  const tx = new Transaction({ version: 3 })
  tx.addInput({ txid: new Uint8Array(32).fill(seed), index: seed, witnessUtxo: { script: key, amount: BigInt(value) } })
  tx.addOutput({ script: key, amount: BigInt(value) })
  state.prevTxs.set(tx.id, base64.encode(tx.toPSBT()))
  return { txid: tx.id, vout: 0, value }
}

const fundingCoin = (value: number, assets?: { assetId: string; amount: number }[]) => {
  const vs = new VtxoScript([MultisigTapscript.encode({ pubkeys: [takerKey, SERVER_KEY] }).script])
  return { ...mintCoin(value), tapLeafScript: vs.leaves[0], tapTree: vs.encode(), ...(assets ? { assets } : {}) }
}

const offerFor = (over: Record<string, unknown>) => {
  const terms = {
    wantAmount: 500n,
    makerPkScript: hex.decode(`5120${MAKER_KEY}`),
    makerPublicKey: hex.decode(MAKER_KEY),
    emulatorPubkey: hex.decode(EMULATOR_KEY),
    ...over,
  } as Omit<Offer, 'swapPkScript'>
  const script = offerVtxoScript(terms, SERVER_KEY)
  return hex.encode(encodeOffer({ ...terms, swapPkScript: script.pkScript }))
}

/** Group ids in packet order — the property both implementations pin. */
const groupIds = (packet: unknown): string[] =>
  ((packet as { groups?: { assetId: { toString(): string } }[] }).groups ?? []).map((g) => g.assetId.toString())

const sdkPacketGroups = () =>
  groupIds(Extension.fromTx(Transaction.fromPSBT(base64.decode(state.arkTx!))).getAssetPacket())

describe('fillOffer builds the packet fulfillOffer builds', () => {
  it('puts the WANTED asset at group index 0, as buildAssetPacket does', async () => {
    state.arkTx = undefined
    const deposit = { ...mintCoin(60_000), assets: [{ assetId: ASSET_B, amount: 900 }] }
    state.vtxos = [deposit]
    const coin = fundingCoin(80_000, [{ assetId: ASSET_A, amount: 600 }])

    await fillOffer(wallet, 'http://ark', offerFor({ wantAsset: asset.AssetId.fromString(ASSET_A) }), {
      fund: [coin] as never,
      emulator: 'http://emulator.test',
      payoutScript: TAKER_PAYOUT,
    })

    const ours = buildAssetPacket({
      wantedAssetId: ASSET_A,
      wantAmount: 500n,
      inputAssets: new Map([
        [0, [{ assetId: ASSET_B, amount: 900n }]],
        [1, [{ assetId: ASSET_A, amount: 600n }]],
      ]),
    })
    expect(sdkPacketGroups()).toEqual(groupIds(ours))
    expect(sdkPacketGroups()[0]).toBe(ASSET_A)
  })

  it('hoists the wanted asset even when ONE COIN carries it second', async () => {
    // the tight case: entry order alone cannot hoist it
    state.arkTx = undefined
    state.vtxos = [mintCoin(60_000)]
    const carries = fundingCoin(80_000, [
      { assetId: ASSET_B, amount: 7 },
      { assetId: ASSET_A, amount: 500 },
    ])

    await fillOffer(wallet, 'http://ark', offerFor({ wantAsset: asset.AssetId.fromString(ASSET_A) }), {
      fund: [carries] as never,
      emulator: 'http://emulator.test',
      payoutScript: TAKER_PAYOUT,
    })

    const ours = buildAssetPacket({
      wantedAssetId: ASSET_A,
      wantAmount: 500n,
      inputAssets: new Map([
        [
          1,
          [
            { assetId: ASSET_B, amount: 7n },
            { assetId: ASSET_A, amount: 500n },
          ],
        ],
      ]),
    })
    expect(sdkPacketGroups()).toEqual(groupIds(ours))
    expect(sdkPacketGroups()).toEqual([ASSET_A, ASSET_B])
  })

  it('routes a deposit asset to the taker when the maker wants sats', async () => {
    state.arkTx = undefined
    state.vtxos = [{ ...mintCoin(60_000), assets: [{ assetId: ASSET_B, amount: 900 }] }]

    await fillOffer(wallet, 'http://ark', offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }), {
      fund: [fundingCoin(80_000)] as never,
      emulator: 'http://emulator.test',
      payoutScript: TAKER_PAYOUT,
    })

    const ours = buildAssetPacket({
      wantedAssetId: undefined,
      wantAmount: 500n,
      inputAssets: new Map([[0, [{ assetId: ASSET_B, amount: 900n }]]]),
    })
    expect(sdkPacketGroups()).toEqual(groupIds(ours))
    expect(sdkPacketGroups()).toEqual([ASSET_B])
  })
})
