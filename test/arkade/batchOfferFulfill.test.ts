import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CSVMultisigTapscript, DefaultVtxo, REGTEST_EMULATOR_PUBKEY, SingleKey, type VirtualCoin } from '@arkade-os/sdk'
import type { FillFunding, FillOutpoint } from '@arkade-os/swap/protocol'
import { hex } from '@scure/base'
import {
  BatchChangeDoesNotFitError,
  fulfillOffers,
  type BatchOfferFill,
} from '@arkade-os/solver-arkade/arkade/batchOfferFulfill.js'
import { offerScriptFrom } from '@arkade-os/solver-arkade/arkade/offerTerms.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { RFQ_ASSET_SWAP_DIRECTED_NONCE, RFQ_ASSET_SWAP_V2 } from '@arkade-os/solver-core/core/rfqContract.js'

const identityFor = (n: number) => SingleKey.fromPrivateKey(new Uint8Array(32).fill(n))
const identity = identityFor(1)
const taker = await identity.xOnlyPublicKey()
const server = await identityFor(2).xOnlyPublicKey()
const maker = await identityFor(3).xOnlyPublicKey()
const emulator = hex.decode(REGTEST_EMULATOR_PUBKEY).slice(-32)
const otherEmulator = await identityFor(4).xOnlyPublicKey()
const exitDelay = { type: 'blocks', value: 144n } as const
const solverScript = new DefaultVtxo.Script({ pubKey: taker, serverPubKey: server, csvTimelock: exitDelay })
const makerScript = new DefaultVtxo.Script({ pubKey: maker, serverPubKey: server, csvTimelock: exitDelay })
const assetId = `${'a1'.repeat(32)}0000`

const fill = (
  n: number,
  {
    version = RFQ_ASSET_SWAP_DIRECTED_NONCE,
    emulatorPubkey = emulator,
    sellsAsset = false,
  }: {
    version?: string
    emulatorPubkey?: Uint8Array
    sellsAsset?: boolean
  } = {},
): BatchOfferFill => {
  const { offer } = offerScriptFrom({ serverPubkey: server, emulatorPubkey, hrp: 'tark', exitDelay, taker })(
    {
      rfqId: n.toString(16).padStart(64, '0'),
      wantAmount: sellsAsset ? 500n : 9n,
      wantAssetId: sellsAsset ? null : assetId,
      offerAssetId: sellsAsset ? assetId : null,
      makerPkScript: hex.encode(makerScript.pkScript),
      makerPublicKey: hex.encode(maker),
    },
    version,
  )
  return { offer, deposit: { txid: '33'.repeat(32), vout: n, value: sellsAsset ? 330 : 20_000 } }
}

const indexed = (
  outpoint: FillOutpoint & { value: number },
  pkScript: Uint8Array,
  assets: VirtualCoin['assets'] = [],
): VirtualCoin => ({
  txid: outpoint.txid,
  vout: outpoint.vout,
  value: outpoint.value,
  status: { confirmed: false },
  createdAt: new Date(0),
  script: hex.encode(pkScript),
  isUnrolled: false,
  assets,
})

const batch = (
  fills: readonly BatchOfferFill[],
  { fundingSats = 2_000, fundingAsset = 25n, maxVtxoSats = -1n } = {},
) => {
  const funding: FillFunding = {
    txid: '44'.repeat(32),
    vout: 0,
    value: fundingSats,
    tapTree: solverScript.encode(),
    tapLeafScript: solverScript.forfeit(),
    assets: [{ assetId, amount: fundingAsset }],
  }
  const vtxos = fills.map(({ offer, deposit }) =>
    indexed(deposit, offer.swapPkScript, offer.offerAsset ? [{ assetId, amount: 50n }] : []),
  )
  const getVtxos = vi.fn(async ({ outpoints }: { outpoints: readonly FillOutpoint[] }) => ({
    vtxos: vtxos.filter((coin) => outpoints.some(({ txid, vout }) => coin.txid === txid && coin.vout === vout)),
  }))
  const ctx = {
    wallet: {
      arkServerPublicKey: server,
      identity,
      getAddress: async () => solverScript.address('tark', server).encode(),
      arkProvider: {
        getInfo: async () => ({
          network: 'regtest',
          signerPubkey: hex.encode(server),
          vtxoMaxAmount: maxVtxoSats,
          unilateralExitDelay: 144n,
          checkpointTapscript: hex.encode(
            CSVMultisigTapscript.encode({ timelock: exitDelay, pubkeys: [server] }).script,
          ),
        }),
      },
      indexerProvider: { getVtxos },
    },
    reservations: createReservationLedger(),
    dustSats: 330n,
    vtxoMinSats: 330n,
  } as unknown as ArkadeContext
  const markSubmitting = vi.fn(async () => true)
  return {
    submit: () => fulfillOffers(ctx, 'http://emulator.test', fills, [funding], { markSubmitting }),
    markSubmitting,
    ctx,
  }
}

const network = vi.fn()
beforeEach(() => {
  network.mockReset()
  vi.stubGlobal('fetch', network)
})
afterEach(() => {
  vi.unstubAllGlobals()
  expect(network).not.toHaveBeenCalled()
})

describe('fulfillOffers pre-submit guards', () => {
  it('rejects a directly supplied baseline covenant', async () => {
    const { submit, markSubmitting } = batch([fill(0), fill(1, { version: RFQ_ASSET_SWAP_V2 })])
    await expect(submit()).rejects.toThrow(/requires a directed covenant/)
    expect(markSubmitting).not.toHaveBeenCalled()
  })

  it('rejects directed offers bound to different emulator keys', async () => {
    const { submit, markSubmitting } = batch([fill(0), fill(1, { emulatorPubkey: otherEmulator })])
    await expect(submit()).rejects.toThrow(/must share an emulator key/)
    expect(markSubmitting).not.toHaveBeenCalled()
  })

  it('rejects when individually safe input values sum past the safe integer domain', async () => {
    const { submit, markSubmitting } = batch([fill(0), fill(1)], { fundingSats: Number.MAX_SAFE_INTEGER })
    await expect(submit()).rejects.toThrow(/input total exceeds the safe integer domain/)
    expect(markSubmitting).not.toHaveBeenCalled()
  })

  it('requires wallet funding to cover the maker assets even when a deposit carries the same asset', async () => {
    const { submit, markSubmitting, ctx } = batch([fill(0), fill(1, { sellsAsset: true })], { fundingAsset: 8n })
    await expect(submit()).rejects.toThrow(/funding does not cover the maker payouts/)
    expect(markSubmitting).not.toHaveBeenCalled()
    expect(ctx.reservations.reserved().size).toBe(0)
  })

  it('rejects change that cannot fit within the allowed capped outputs', async () => {
    const { submit, markSubmitting } = batch([fill(0), fill(1)], { maxVtxoSats: 1_000n })
    await expect(submit()).rejects.toThrow(BatchChangeDoesNotFitError)
    expect(markSubmitting).not.toHaveBeenCalled()
  })
})
