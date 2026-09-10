/**
 * The asset packet `fulfillOffer` actually submits, read back off the ark tx.
 *
 * These assertions used to hold against this repo's own `buildAssetPacket`.
 * That builder is gone — the spend is the SDK's `fillOffer` now — so they hold
 * against the real thing instead: only the REST providers are stubbed, the
 * Arkade builder runs, and the packet is decoded out of what reached the
 * emulator.
 *
 * The rule they pin is the covenant's: the WANTED asset must be group 0,
 * because the fulfill script's `OP_INSPECTOUTASSETLOOKUP` reads `lookup_index
 * = 0`. Every other asset on every input must still be declared or arkd
 * answers ASSET_NOT_FOUND.
 */
import { describe, it, expect, vi } from 'vitest'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { fulfillOffer } from '@arkade-os/solver-arkade/arkade/offerFulfill.js'
import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'

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
const { offerVtxoScript } = await import('@arkade-os/swap')
type Offer = import('@arkade-os/swap').Offer

const SERVER_KEY = hex.decode('4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa')
const MAKER_KEY = '71102fc86b5c576c72f411e083cc03eb83d1b55065406ba2a483208dbb5074ab'
const EMULATOR_KEY = '466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27'
const TAKER_PAYOUT = hex.decode('512035f737927627c4af1e9a39ae02b086c6b31426d0d64f01e5ce3ee8a445bbd667')
const ASSET_A = `${'aa'.repeat(32)}0000`
const ASSET_B = `${'bb'.repeat(32)}0000`

const takerKey = schnorr.getPublicKey(new Uint8Array(32).fill(0x7a))
const identity = { xOnlyPublicKey: async () => takerKey, sign: async (tx: unknown) => tx }

/** Only what `fulfillOffer` and the SDK client below it reach for. `spendable`
 * is what the gate would have handed back, which is the half this repo keeps. */
const ctx = (spendable: unknown[]): ArkadeContext =>
  ({
    wallet: {
      identity,
      arkServerPublicKey: SERVER_KEY,
      getSpendableVtxos: async () => spendable,
      getAddress: async () => new ArkAddress(SERVER_KEY, hex.decode('22'.repeat(32)), 'tark').encode(),
      getContractManager: async () => null,
    },
    identity,
    arkServerUrl: 'http://ark',
  }) as unknown as ArkadeContext

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

const fundingCoin = (value: number, assets?: { assetId: string; amount: bigint }[]) => {
  const vs = new VtxoScript([MultisigTapscript.encode({ pubkeys: [takerKey, SERVER_KEY] }).script])
  // `forfeitTapLeafScript`, not `tapLeafScript`: that is the field a real
  // ExtendedVirtualCoin carries and the one `fulfillOffer` forwards.
  return {
    ...mintCoin(value),
    forfeitTapLeafScript: vs.leaves[0],
    tapTree: vs.encode(),
    ...(assets ? { assets } : {}),
  }
}

const offerFor = (over: Record<string, unknown>): Offer => {
  const terms = {
    wantAmount: 500n,
    makerPkScript: hex.decode(`5120${MAKER_KEY}`),
    makerPublicKey: hex.decode(MAKER_KEY),
    emulatorPubkey: hex.decode(EMULATOR_KEY),
    ...over,
  } as Omit<Offer, 'swapPkScript'>
  return { ...terms, swapPkScript: offerVtxoScript(terms, SERVER_KEY).pkScript } as Offer
}

/** Group ids in packet order — the covenant's own requirement. */
const groupIds = (packet: unknown): string[] =>
  ((packet as { groups?: { assetId: { toString(): string } }[] }).groups ?? []).map((g) => g.assetId.toString())

const packetGroups = () =>
  groupIds(Extension.fromTx(Transaction.fromPSBT(base64.decode(state.arkTx!))).getAssetPacket())

describe('the asset packet fulfillOffer submits', () => {
  const deposit = (assets?: { assetId: string; amount: bigint }[]) => {
    const coin = { ...mintCoin(60_000), ...(assets ? { assets } : {}) }
    state.vtxos = [coin]
    return { txid: coin.txid, vout: coin.vout, value: coin.value }
  }

  it('puts the WANTED asset at group index 0', async () => {
    state.arkTx = undefined
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const coins = [fundingCoin(80_000, [{ assetId: ASSET_A, amount: 600n }])]

    await fulfillOffer(
      ctx(coins),
      'http://emulator.test',
      offerFor({ wantAsset: asset.AssetId.fromString(ASSET_A) }),
      at,
    )

    expect(packetGroups()[0]).toBe(ASSET_A)
    expect(packetGroups()).toEqual([ASSET_A, ASSET_B])
  })

  it('hoists the wanted asset even when ONE COIN carries it second', async () => {
    // the tight case: entry order alone cannot hoist it
    state.arkTx = undefined
    const at = deposit()
    const coins = [
      fundingCoin(80_000, [
        { assetId: ASSET_B, amount: 7n },
        { assetId: ASSET_A, amount: 500n },
      ]),
    ]

    await fulfillOffer(
      ctx(coins),
      'http://emulator.test',
      offerFor({ wantAsset: asset.AssetId.fromString(ASSET_A) }),
      at,
    )

    expect(packetGroups()).toEqual([ASSET_A, ASSET_B])
  })

  it('routes a deposit asset to the taker when the maker wants sats', async () => {
    state.arkTx = undefined
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])

    await fulfillOffer(
      ctx([fundingCoin(80_000)]),
      'http://emulator.test',
      offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }),
      at,
    )

    expect(packetGroups()).toEqual([ASSET_B])
  })
})
