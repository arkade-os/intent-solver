/**
 * The directed carrier fill: the offer it rebuilds from, the taker's pre-signature on the deposit
 * the Taxi gates, and the bytes it posts. The Taxi's server path is replayed offline through the
 * 1.1.0 client's own seal, sign and prepare; its app admission, the emulator and arkd are not.
 */
import { describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { base64, hex } from '@scure/base'
import {
  arkade,
  CSVMultisigTapscript,
  EmulatorPacket,
  Extension,
  MultisigTapscript,
  P2A,
  SingleKey,
  Transaction,
  VtxoScript,
} from '@arkade-os/sdk'
import { decodeOffer } from '@arkade-os/swap/protocol'
import { digestJointGraph, OFFER_FILL_TEMPLATE, type JointGraph } from '@arkade-os/swap'
import { prepareFillSubmission, sealFillGraph, signFillForTaxi } from '@arkade-taxi/client'
import { offerExitDelay, offerScriptFrom } from '@arkade-os/solver-arkade/arkade/offerTerms.js'
import { quotedOfferHexFor } from '@arkade-os/solver-arkade/arkade/quotedOfferSettle.js'
import { RFQ_ASSET_SWAP_DIRECTED, RFQ_ASSET_SWAP_DIRECTED_NONCE } from '@arkade-os/solver-core/core/rfqContract.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { createCarrierPinLedger } from '@arkade-os/solver-app/ops/assetRfqTaxi.js'
import { carrierFillSigner, createTaxiReceiveCarrierSettler } from '@arkade-os/solver-app/ops/assetRfqTaxiSettle.js'

const seed = (n: number) => new Uint8Array(32).fill(n)
const SERVER_KEY = schnorr.getPublicKey(seed(0x59))
const EMULATOR_KEY = schnorr.getPublicKey(seed(0x5a))
const solver = SingleKey.fromPrivateKey(seed(0x53))
const taxi = SingleKey.fromPrivateKey(seed(0x54))
const solverKey = schnorr.getPublicKey(seed(0x53))
const taxiKey = schnorr.getPublicKey(seed(0x54))
const GATE_SCRIPT = new Uint8Array([0x51])
const gateKey = arkade.computeArkadeScriptPublicKey(EMULATOR_KEY, GATE_SCRIPT)
const CHECKPOINT = CSVMultisigTapscript.encode({
  timelock: { type: 'blocks', value: 10n },
  pubkeys: [SERVER_KEY],
}).script
const payTo = (n: number) => hex.decode(`5120${hex.encode(schnorr.getPublicKey(seed(n)))}`)
const ASSET = `${'12'.repeat(32)}0000`
const me = hex.encode(solverKey)

const spendEdge = (leaf: Uint8Array, n: number) => {
  const source = new VtxoScript([leaf])
  const next = new VtxoScript([CHECKPOINT, leaf])
  const checkpoint = new Transaction({ version: 3, lockTime: 0 })
  checkpoint.addInput({
    txid: seed(n),
    index: 0,
    witnessUtxo: { script: source.pkScript, amount: 1_000n },
    tapLeafScript: source.leaves,
  })
  checkpoint.addOutput({ script: next.pkScript, amount: 1_000n })
  checkpoint.addOutput(P2A)
  const input = {
    txid: checkpoint.id,
    index: 0,
    witnessUtxo: { script: next.pkScript, amount: 1_000n },
    tapLeafScript: [next.findLeaf(hex.encode(leaf))],
  }
  return { checkpoint, input }
}

/** offer-fill/1: the directed deposit the Taxi gates, the solver's funding and the Taxi's carrier. */
const directedFill = (depositKeys = [solverKey, SERVER_KEY, gateKey]): JointGraph => {
  const edges = [
    spendEdge(MultisigTapscript.encode({ pubkeys: depositKeys }).script, 0x71),
    spendEdge(MultisigTapscript.encode({ pubkeys: [solverKey, SERVER_KEY] }).script, 0x72),
    spendEdge(MultisigTapscript.encode({ pubkeys: [taxiKey, SERVER_KEY] }).script, 0x73),
  ]
  const ark = new Transaction({ version: 3, lockTime: 0 })
  for (const { input } of edges) ark.addInput(input)
  ark.addOutput({ script: payTo(0xa1), amount: 2_000n })
  ark.addOutput({ script: payTo(0xb2), amount: 1_000n })
  ark.addOutput(Extension.create([EmulatorPacket.create([{ vin: 0, script: GATE_SCRIPT }])]).txOut())
  const plan = {
    arkTx: base64.encode(ark.toPSBT()),
    checkpoints: edges.map(({ checkpoint }) => base64.encode(checkpoint.toPSBT())),
    inputOwners: [null, 'solver', 'sponsor'],
  }
  return { ...plan, graphId: digestJointGraph(plan, OFFER_FILL_TEMPLATE) }
}

const keysOn = (psbt: string, index: number) =>
  (Transaction.fromPSBT(base64.decode(psbt)).getInput(index).tapScriptSig ?? [])
    .map(([data]) => hex.encode(data.pubKey))
    .sort()

describe('the offer a Taxi fill rebuilds from', () => {
  const derivation = {
    serverPubkey: schnorr.getPublicKey(seed(2)),
    emulatorPubkey: schnorr.getPublicKey(seed(4)),
    hrp: 'tark',
    exitDelay: offerExitDelay(605_184),
    taker: solverKey,
  }
  it.each([RFQ_ASSET_SWAP_DIRECTED, RFQ_ASSET_SWAP_DIRECTED_NONCE])(
    'is the %s offer the row was quoted on, taker included',
    (contractVersion) => {
      const terms = {
        rfqId: 'f'.repeat(64),
        wantAmount: 19_900n,
        wantAssetId: ASSET,
        offerAssetId: null,
        makerPkScript: `5120${'cc'.repeat(32)}`,
        makerPublicKey: hex.encode(schnorr.getPublicKey(seed(3))),
      }
      const row = {
        id: 'row',
        ...terms,
        fromAssetId: null,
        fromAmount: 20_000n,
        toAssetId: ASSET,
        toAmount: 19_900n,
        depositTxid: null,
        depositVout: null,
        contractVersion,
        offerPkScript: offerScriptFrom(derivation)(terms, contractVersion).pkScript,
      }
      const offer = decodeOffer(hex.decode(quotedOfferHexFor(derivation)(row)))
      expect(hex.encode(offer.swapPkScript)).toBe(row.offerPkScript)
      expect(offer.taker).toEqual(solverKey)
      expect(offer.nonce !== undefined).toBe(contractVersion === RFQ_ASSET_SWAP_DIRECTED_NONCE)
      expect(() => quotedOfferHexFor(derivation)({ ...row, toAmount: 1n })).toThrow('derive')
    },
  )
})

describe('the carrier fill signer', () => {
  it("signs the directed deposit as its taker, and the Taxi's own path carries that signature through", async () => {
    const signed = await carrierFillSigner(solver)(directedFill())
    expect(keysOn(signed.arkTx, 0)).toEqual([me])
    expect(keysOn(signed.checkpoints[0]!, 0)).toEqual([me])
    expect(keysOn(signed.arkTx, 1)).toEqual([me])
    expect(keysOn(signed.arkTx, 2)).toEqual([])

    const sealed = sealFillGraph({ arkTx: signed.arkTx, checkpoints: [...signed.checkpoints], taxiInputIndexes: [2] })
    const partial = await signFillForTaxi({ expected: sealed, bindings: [{ inputIndex: 2, identity: taxi }] })
    const prepared = prepareFillSubmission({ expected: sealed, partial, ownerKeys: { taxi: [hex.encode(taxiKey)] } })
    expect(keysOn(prepared.arkTx, 0)).toEqual([me])
    expect(keysOn(prepared.checkpointTxs[0]!, 0)).toEqual([me])
    expect(keysOn(prepared.arkTx, 2)).toEqual([hex.encode(taxiKey)])
  })

  it('refuses a deposit whose fulfill leaf does not name this solver', async () => {
    await expect(carrierFillSigner(solver)(directedFill([taxiKey, SERVER_KEY, gateKey]))).rejects.toThrow('taker')
  })
})

describe('the carrier fill settle', () => {
  it('binds the signed graph before it posts, and posts exactly the bytes it bound', async () => {
    const store = await AssetRfqSwapStore.open(':memory:', () => 1_000)
    const carrierTerms = {
      mode: 'recycle' as const,
      quoteId: 'q-1',
      physicalSats: 330n,
      loanSats: 329n,
      receiptSats: 1n,
      serviceFareSats: 0n,
      pricedSats: 1n,
      expiresAt: 1_600,
    }
    await store.insertQuote({
      id: 'row',
      rfqId: 'row',
      pair: `arkade:BTC->arkade:${ASSET}`,
      fromAssetId: null,
      fromAmount: 20_000n,
      toAssetId: ASSET,
      toAmount: 100n,
      makerPkScript: `5120${'aa'.repeat(32)}`,
      makerPublicKey: 'bb'.repeat(32),
      offerPkScript: `5120${'dd'.repeat(32)}`,
      offerAddress: 'ark1qoffer',
      solverPubkey: me,
      validUntil: 1_500,
      carrierTerms,
    })
    await store.transition('row', 'quoted', 'funded', { deposit_txid: 'ff'.repeat(32), deposit_vout: 0 })
    await store.transition('row', 'funded', 'filling')
    const funding = new VtxoScript([MultisigTapscript.encode({ pubkeys: [solverKey, SERVER_KEY] }).script])
    const coin = {
      txid: '0a'.repeat(32),
      vout: 0,
      value: 5_000,
      expiresAtHeight: 2_000,
      assets: [{ assetId: ASSET, amount: 100n }],
      tapTree: funding.encode(),
      forfeitTapLeafScript: funding.leaves[0]!,
      script: hex.encode(funding.pkScript),
    }
    const floor = { kind: 'height' as const, value: 1_500n }
    const submitFill = vi.fn(async (_request: unknown) => ({}) as never)
    const settle = createTaxiReceiveCarrierSettler({
      store,
      taxiFor: () => ({ provider: 'https://taxi.example', fills: { submitFill } }),
      resolve: async () => ({ inputExpiryFloor: floor }) as never,
      receiveQuote: async () =>
        ({ quote: { inputExpiryFloor: { kind: 'height', value: '1500' } }, descriptor: { expiresAt: 1_600 } }) as never,
      coins: async () => [coin],
      reserved: () => new Set(),
      reserve: () => () => {},
      pins: createCarrierPinLedger(),
      dustSats: 330n,
      offerHex: () => '00',
      proceedsScript: payTo(0xc3),
      solverKeys: [me],
      serverKey: () => SERVER_KEY,
      fill: { rebuild: async () => directedFill(), sign: carrierFillSigner(solver) },
      now: () => 1_000,
    }).settle

    expect(await settle(await store.get('row'))).toEqual({ status: 'submitted' })
    const bound = (await store.readCarrierAttempt('row'))!
    const graph = bound.binding!.graph as { ark_tx: string; checkpoints: string[] }
    expect(bound.phase).toBe('submitting')
    expect(keysOn(graph.ark_tx, 0)).toEqual([me])
    expect(submitFill).toHaveBeenCalledOnce()
    expect(submitFill.mock.calls[0]![0]).toMatchObject({
      operationId: 'row',
      arkTx: graph.ark_tx,
      checkpoints: graph.checkpoints,
      taxiInputIndexes: [2],
    })
    await store.close()
  })
})
