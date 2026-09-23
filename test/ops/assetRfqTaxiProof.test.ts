/**
 * Reconciling one submitted fill: exact evidence or nothing.
 *
 * The graph is built by `buildOffchainTx`, so every id the observer compares is
 * derived from real PSBT bytes; the indexer double answers with those same
 * bytes. Nothing here consults Taxi — `reconcile` is given no client at all,
 * which is why a `state: 'settled'` label cannot reach it.
 */

import { describe, it, expect } from 'vitest'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  buildOffchainTx,
  createAssetPacket,
  CSVMultisigTapscript,
  DefaultVtxo,
  Extension,
  getArkPsbtFields,
  setArkPsbtField,
  Transaction,
  VtxoTaprootTree,
} from '@arkade-os/sdk'
import { digestJointGraph, OFFER_FILL_TEMPLATE, setTapScriptSigEntries } from '@arkade-taxi/client'
import { AssetRfqSwapStore, type AssetRfqSwapRow } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import { createCarrierPinLedger } from '@arkade-os/solver-app/ops/assetRfqTaxi.js'
import {
  createTaxiReceiveCarrierObserver,
  type CarrierChainReader,
  type TaxiCarrierProofDeps,
} from '@arkade-os/solver-app/ops/assetRfqTaxiProof.js'

const ASSET = `${'aa'.repeat(31)}bb0100`
const DEPOSIT_TXID = '1'.repeat(64)
const COIN_A = '2'.repeat(64)
const SPONSOR_TXID = '3'.repeat(64)
const SOLVER_KEY = 'd'.repeat(64)

const xonly = (seed: number): string => hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(seed)))
const SERVER = xonly(9)

const vtxoScript = (seed: number) =>
  new DefaultVtxo.Script({
    pubKey: hex.decode(xonly(seed)),
    serverPubKey: hex.decode(SERVER),
    csvTimelock: { type: 'blocks', value: 144n },
  })

const SERVER_UNROLL = CSVMultisigTapscript.encode({
  timelock: { type: 'blocks', value: 144n },
  pubkeys: [hex.decode(SERVER)],
})

const MAKER = vtxoScript(4).pkScript
const PROCEEDS = vtxoScript(6).pkScript

const coinInput = (seed: number, txid: string, vout: number, value: number) => {
  const s = vtxoScript(seed)
  return { txid, vout, value, tapLeafScript: s.forfeit(), tapTree: s.encode() }
}

const SPONSOR_SCRIPT = vtxoScript(5).pkScript

const DEPOSIT = coinInput(1, DEPOSIT_TXID, 1, 1_000)
const SOLVER = coinInput(2, COIN_A, 0, 2_000)
const SPONSOR = coinInput(3, SPONSOR_TXID, 7, 500)

/** Input 1 (the solver coin) carries the asset; output 0 pays it to the maker. */
const ASSET_EXT = Extension.create([
  createAssetPacket(new Map([[1, [{ assetId: ASSET, amount: 10n }]]]), [
    { address: '', assets: [{ assetId: ASSET, amount: 10n }] },
  ]),
]).txOut()

/** `solverNet = 1000 + 329 - 330 - 4` = 995 = payout 2995 less the 2000 solver
 * input, so the default fixture sits EXACTLY on the floor: one sat moved away
 * from the solver fails, and a smaller fare passes. */
const AUTHORISED = { physical: 330n, contribution: 329n, maxFare: 4n }

const buildGraph = (
  outputs: { script: Uint8Array; amount: bigint }[],
  inputs: readonly (typeof DEPOSIT)[] = [DEPOSIT, SOLVER, SPONSOR],
) => {
  const built = buildOffchainTx([...inputs], [...outputs, ASSET_EXT], SERVER_UNROLL)
  const arkTx = base64.encode(built.arkTx.toPSBT())
  const checkpoints = built.checkpoints.map((c) => base64.encode(c.toPSBT()))
  const inputOwners: readonly (string | null)[] = [null, 'solver', 'sponsor'].slice(0, inputs.length)
  return {
    arkTx,
    checkpoints,
    inputOwners,
    graphId: digestJointGraph({ arkTx, checkpoints, inputOwners }, OFFER_FILL_TEMPLATE),
    finalTxid: built.arkTx.id,
    checkpointTxids: built.checkpoints.map((c) => c.id),
  }
}

const payments = (over: { carrier?: bigint; fare?: bigint; change?: bigint; payout?: bigint } = {}) => [
  { script: MAKER, amount: over.carrier ?? AUTHORISED.physical },
  { script: SPONSOR_SCRIPT, amount: over.fare ?? AUTHORISED.maxFare },
  { script: SPONSOR_SCRIPT, amount: over.change ?? 171n },
  { script: PROCEEDS, amount: over.payout ?? 2_995n },
]

const GRAPH = buildGraph(payments())

const boundTo = (graph: typeof GRAPH) => ({
  graph: {
    id: graph.graphId,
    ark_tx: graph.arkTx,
    checkpoints: [...graph.checkpoints],
    input_owners: [...graph.inputOwners],
  },
})

const bindingJson = (over: Record<string, unknown> = {}) => ({
  fill_id: 'fill-1',
  expires_at: 8_000,
  ...boundTo(GRAPH),
  ...over,
})

const snapshotJson = () => ({
  inputs: [{ txid: COIN_A, vout: 0 }],
  operation: 'swap-1',
  provider: 'http://taxi.example:7080',
  offer: 'abcd',
  deposit: { txid: DEPOSIT_TXID, vout: 1 },
  quote: { id: 'q-1', expires_at: 9_000 },
  input_expiry_floor: { kind: 'height', value: '1100000' },
  proceeds_script: hex.encode(PROCEEDS),
  physical_sats: AUTHORISED.physical.toString(),
  contribution_sats: AUTHORISED.contribution.toString(),
  max_fare_sats: AUTHORISED.maxFare.toString(),
  valid_until: 9_000,
})

const openStore = async () => {
  const store = await AssetRfqSwapStore.open(':memory:', () => 1_000)
  await store.insertQuote({
    id: 'swap-1',
    rfqId: 'a'.repeat(64),
    pair: `arkade:BTC->arkade:${ASSET}`,
    fromAssetId: null,
    toAssetId: ASSET,
    fromAmount: 1_000n,
    toAmount: 10n,
    makerPkScript: hex.encode(MAKER),
    makerPublicKey: 'b'.repeat(64),
    offerPkScript: `5120${'d'.repeat(64)}`,
    offerAddress: 'ark1qoffer',
    solverPubkey: SOLVER_KEY,
    validUntil: 9_000,
    carrierTerms: {
      mode: 'recycle',
      quoteId: 'q-1',
      physicalSats: 330n,
      loanSats: 329n,
      receiptSats: 1n,
      serviceFareSats: 4n,
      pricedSats: 5n,
      expiresAt: 9_000,
    },
  })
  await store.transition('swap-1', 'quoted', 'funded', { deposit_txid: DEPOSIT_TXID, deposit_vout: 1 })
  await store.transition('swap-1', 'funded', 'filling', {})
  return store
}

const chainOf = (
  over: {
    spentBy?: string
    arkTxId?: string
    txs?: readonly string[]
    vtxos?: readonly { txid: string; vout: number; spentBy?: string; arkTxId?: string }[]
  } = {},
): CarrierChainReader & { asked: string[][] } => {
  const asked: string[][] = []
  return {
    asked,
    getVtxos: async () => ({
      vtxos: over.vtxos ?? [
        {
          txid: DEPOSIT_TXID,
          vout: 1,
          spentBy: over.spentBy ?? GRAPH.checkpointTxids[0]!,
          ...(over.arkTxId === undefined ? {} : { arkTxId: over.arkTxId }),
        },
      ],
    }),
    getVirtualTxs: async (txids) => {
      asked.push([...txids])
      const known = new Map<string, string>([
        [GRAPH.finalTxid, GRAPH.arkTx],
        ...GRAPH.checkpointTxids.map((id, i): [string, string] => [id, GRAPH.checkpoints[i]!]),
      ])
      if (over.txs !== undefined) return { txs: [...over.txs] }
      return { txs: txids.flatMap((id) => (known.has(id) ? [known.get(id)!] : [])) }
    },
  }
}

const servedFrom = (graph: typeof GRAPH): CarrierChainReader & { asked: string[][] } =>
  chainOf({ spentBy: graph.checkpointTxids[0]!, txs: [graph.arkTx, graph.checkpoints[0]!] })

const reserialised = (at: number, over: Partial<ReturnType<Transaction['getInput']>>): string => {
  const trusted = Transaction.fromPSBT(base64.decode(GRAPH.arkTx))
  const copy = new Transaction({
    version: trusted.version,
    lockTime: trusted.lockTime,
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    disableScriptCheck: true,
  })
  for (let i = 0; i < trusted.inputsLength; i += 1) {
    const from = trusted.getInput(i)
    copy.addInput({
      txid: from.txid!,
      index: from.index!,
      sequence: from.sequence,
      witnessUtxo: from.witnessUtxo,
      tapLeafScript: from.tapLeafScript,
      ...(i === at ? over : {}),
    })
    setArkPsbtField(copy, i, VtxoTaprootTree, getArkPsbtFields(trusted, i, VtxoTaprootTree)[0]!)
  }
  for (let i = 0; i < trusted.outputsLength; i += 1) copy.addOutput(trusted.getOutput(i) as never)
  // Vacuous for today's two `over` values; kept for the parameter.
  expect(copy.id).toBe(GRAPH.finalTxid)
  return base64.encode(copy.toPSBT())
}

const harness = async (
  over: {
    phase?: 'prepared' | 'quoted' | 'submitting'
    binding?: Record<string, unknown>
    chain?: CarrierChainReader
    pin?: boolean
  } = {},
) => {
  const store = await openStore()
  const pins = createCarrierPinLedger()
  const ledger = createReservationLedger()
  const phase = over.phase ?? 'submitting'

  await store.prepareCarrierAttempt('swap-1', snapshotJson())
  if (phase !== 'prepared') {
    const prepared = (await store.readCarrierAttempt('swap-1'))!
    await store.bindCarrierAttempt('swap-1', prepared, over.binding ?? bindingJson())
  }
  if (phase === 'submitting') {
    const quoted = (await store.readCarrierAttempt('swap-1'))!
    await store.markCarrierAttemptSubmitting('swap-1', quoted)
  }
  if (over.pin !== false) pins.adopt('swap-1', ledger.reserve([{ txid: COIN_A, vout: 0 }]))

  const deps: TaxiCarrierProofDeps = { store, chain: over.chain ?? chainOf(), pins }
  const { reconcile } = createTaxiReceiveCarrierObserver(deps)
  return {
    reconcile: () => reconcile(rowOf()),
    reconcileAs: (as: AssetRfqSwapRow) => reconcile(as),
    store,
    pins,
    ledger,
    attempt: () => store.readCarrierAttempt('swap-1'),
    state: async () => (await store.get('swap-1')).state,
  }
}

const rowOf = (): AssetRfqSwapRow =>
  ({
    id: 'swap-1',
    state: 'filling',
    toAssetId: ASSET,
    toAmount: 10n,
    makerPkScript: hex.encode(MAKER),
    depositTxid: DEPOSIT_TXID,
    depositVout: 1,
  }) as AssetRfqSwapRow

describe('the observer settles only on the whole evidence chain', () => {
  it('settles on byte-derived ids, the exact deposit source and the expected payout', async () => {
    const h = await harness()

    await expect(h.reconcile()).resolves.toEqual({ status: 'settled', txid: GRAPH.finalTxid })
    expect((await h.attempt())?.phase).toBe('settled')
    expect((await h.attempt())?.fillTxid).toBe(GRAPH.finalTxid)
    expect(h.ledger.reserved().size).toBe(0)
  })

  it('reports the FINAL transaction id, which is never the checkpoint the deposit names', async () => {
    const h = await harness()

    const outcome = await h.reconcile()

    expect(outcome).toEqual({ status: 'settled', txid: GRAPH.finalTxid })
    expect(GRAPH.finalTxid).not.toBe(GRAPH.checkpointTxids[0])
  })

  it('stays pending, and keeps the pin, when the deposit shows no spend at all', async () => {
    const h = await harness({ chain: chainOf({ vtxos: [{ txid: DEPOSIT_TXID, vout: 1 }] }) })

    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })
    expect((await h.attempt())?.phase).toBe('submitting')
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
  })

  it('stays pending when the deposit is spent by a transaction this attempt never built', async () => {
    const h = await harness({ chain: chainOf({ spentBy: '7'.repeat(64) }) })

    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })
    expect((await h.attempt())?.phase).toBe('submitting')
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
  })

  it('stays pending when the spender is one of this graph’s ids but the WRONG one', async () => {
    // Checkpoint 1 is the solver coin's, byte-derived from this very graph: an
    // "is it an id I built" check would admit it.
    const h = await harness({ chain: chainOf({ spentBy: GRAPH.checkpointTxids[1]! }) })

    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
  })

  it('stays pending when the indexer serves no transaction for the id it derived', async () => {
    const h = await harness({ chain: chainOf({ txs: [] }) })

    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })
    expect((await h.attempt())?.phase).toBe('submitting')
  })

  it('surfaces a transaction served under its id but committing to something else', async () => {
    // Same body, so the same txid, with the tap leaves and taptree stripped.
    const trusted = Transaction.fromPSBT(base64.decode(GRAPH.arkTx))
    const bare = new Transaction({
      version: trusted.version,
      lockTime: trusted.lockTime,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    })
    for (let i = 0; i < trusted.inputsLength; i += 1) {
      const from = trusted.getInput(i)
      bare.addInput({ txid: from.txid!, index: from.index!, sequence: from.sequence })
    }
    for (let i = 0; i < trusted.outputsLength; i += 1) bare.addOutput(trusted.getOutput(i) as never)
    expect(bare.id).toBe(GRAPH.finalTxid)

    const h = await harness({ chain: chainOf({ txs: [base64.encode(bare.toPSBT()), GRAPH.checkpoints[0]!] }) })

    await expect(h.reconcile()).rejects.toThrow(/tap leaves|taptree|prevout/)
    expect((await h.attempt())?.phase).toBe('submitting')
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
  })

  it('surfaces a transaction whose inputs may be spent under a leaf it never signed', async () => {
    // Same taptree and id, one input re-pointed at the UNILATERAL EXIT leaf.
    const trusted = Transaction.fromPSBT(base64.decode(GRAPH.arkTx))
    const swapped = new Transaction({
      version: trusted.version,
      lockTime: trusted.lockTime,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    })
    for (let i = 0; i < trusted.inputsLength; i += 1) {
      const from = trusted.getInput(i)
      swapped.addInput({
        txid: from.txid!,
        index: from.index!,
        sequence: from.sequence,
        witnessUtxo: from.witnessUtxo,
        tapLeafScript: i === 1 ? [vtxoScript(2).exit()] : from.tapLeafScript,
      })
      setArkPsbtField(swapped, i, VtxoTaprootTree, getArkPsbtFields(trusted, i, VtxoTaprootTree)[0]!)
    }
    for (let i = 0; i < trusted.outputsLength; i += 1) swapped.addOutput(trusted.getOutput(i) as never)
    expect(swapped.id).toBe(GRAPH.finalTxid)

    const h = await harness({ chain: chainOf({ txs: [base64.encode(swapped.toPSBT()), GRAPH.checkpoints[0]!] }) })

    await expect(h.reconcile()).rejects.toThrow(/tap leaves/)
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
  })

  it('surfaces a transaction that declares a prevout script it never signed', async () => {
    const h = await harness({
      chain: chainOf({ txs: [reserialised(1, { witnessUtxo: undefined }), GRAPH.checkpoints[0]!] }),
    })

    await expect(h.reconcile()).rejects.toThrow(/prevout script/)
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
  })

  it('raises a contradiction ONCE per row, then holds quietly rather than every tick', async () => {
    const h = await harness({
      chain: chainOf({ txs: [reserialised(1, { witnessUtxo: undefined }), GRAPH.checkpoints[0]!] }),
    })

    await expect(h.reconcile()).rejects.toThrow(/prevout script/)
    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })
    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })

    expect((await h.attempt())?.phase).toBe('submitting')
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
  })

  it('still settles a contradiction that was transient, having already raised it', async () => {
    let served = reserialised(1, { witnessUtxo: undefined })
    const h = await harness({
      chain: {
        ...chainOf(),
        getVirtualTxs: async (txids) => ({
          txs: txids.map((id) => (id === GRAPH.finalTxid ? served : GRAPH.checkpoints[0]!)),
        }),
      },
    })

    await expect(h.reconcile()).rejects.toThrow(/prevout script/)
    served = GRAPH.arkTx

    await expect(h.reconcile()).resolves.toEqual({ status: 'settled', txid: GRAPH.finalTxid })
    expect(h.ledger.reserved().size).toBe(0)
  })

  it('surfaces a transaction that misdeclares what an input was worth', async () => {
    const at = Transaction.fromPSBT(base64.decode(GRAPH.arkTx)).getInput(1).witnessUtxo!
    const h = await harness({
      chain: chainOf({
        txs: [reserialised(1, { witnessUtxo: { script: at.script, amount: at.amount + 1n } }), GRAPH.checkpoints[0]!],
      }),
    })

    await expect(h.reconcile()).rejects.toThrow(/prevout value/)
  })

  it('surfaces a transaction proved against a taptree it never signed', async () => {
    // Same leaves and id, one taptree replaced — what the leaf check cannot see.
    const trusted = Transaction.fromPSBT(base64.decode(GRAPH.arkTx))
    const retreed = new Transaction({
      version: trusted.version,
      lockTime: trusted.lockTime,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    })
    for (let i = 0; i < trusted.inputsLength; i += 1) {
      const from = trusted.getInput(i)
      retreed.addInput({
        txid: from.txid!,
        index: from.index!,
        sequence: from.sequence,
        witnessUtxo: from.witnessUtxo,
        tapLeafScript: from.tapLeafScript,
      })
      const tree = i === 1 ? vtxoScript(7).encode() : getArkPsbtFields(trusted, i, VtxoTaprootTree)[0]!
      setArkPsbtField(retreed, i, VtxoTaprootTree, tree)
    }
    for (let i = 0; i < trusted.outputsLength; i += 1) retreed.addOutput(trusted.getOutput(i) as never)
    expect(retreed.id).toBe(GRAPH.finalTxid)

    const h = await harness({ chain: chainOf({ txs: [base64.encode(retreed.toPSBT()), GRAPH.checkpoints[0]!] }) })

    await expect(h.reconcile()).rejects.toThrow(/taptree/)
  })

  it('settles on an answer served with no taptree, because the id already pinned the body', async () => {
    const trusted = Transaction.fromPSBT(base64.decode(GRAPH.arkTx))
    const treeless = new Transaction({
      version: trusted.version,
      lockTime: trusted.lockTime,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    })
    for (let i = 0; i < trusted.inputsLength; i += 1) {
      const from = trusted.getInput(i)
      treeless.addInput({
        txid: from.txid!,
        index: from.index!,
        sequence: from.sequence,
        witnessUtxo: from.witnessUtxo,
        tapLeafScript: from.tapLeafScript,
      })
    }
    for (let i = 0; i < trusted.outputsLength; i += 1) treeless.addOutput(trusted.getOutput(i) as never)
    expect(treeless.id).toBe(GRAPH.finalTxid)

    const h = await harness({ chain: chainOf({ txs: [base64.encode(treeless.toPSBT()), GRAPH.checkpoints[0]!] }) })

    await expect(h.reconcile()).resolves.toEqual({ status: 'settled', txid: GRAPH.finalTxid })
    expect(h.ledger.reserved().size).toBe(0)
  })

  it('accepts a FINALIZED transaction, whose tap leaves finalization drops by design', async () => {
    // `witnessUtxo` and `unknown` (the taptree) survive `cleanFinalInput`;
    // `tapLeafScript` does not. Requiring it would wedge a CORRECT fill.
    const trusted = Transaction.fromPSBT(base64.decode(GRAPH.arkTx))
    const finalized = new Transaction({
      version: trusted.version,
      lockTime: trusted.lockTime,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    })
    for (let i = 0; i < trusted.inputsLength; i += 1) {
      const from = trusted.getInput(i)
      finalized.addInput({
        txid: from.txid!,
        index: from.index!,
        sequence: from.sequence,
        witnessUtxo: from.witnessUtxo,
      })
      setArkPsbtField(finalized, i, VtxoTaprootTree, getArkPsbtFields(trusted, i, VtxoTaprootTree)[0]!)
    }
    for (let i = 0; i < trusted.outputsLength; i += 1) finalized.addOutput(trusted.getOutput(i) as never)
    expect(finalized.getInput(1).tapLeafScript).toBeUndefined()

    const h = await harness({ chain: chainOf({ txs: [base64.encode(finalized.toPSBT()), GRAPH.checkpoints[0]!] }) })

    await expect(h.reconcile()).resolves.toEqual({ status: 'settled', txid: GRAPH.finalTxid })
    expect(h.ledger.reserved().size).toBe(0)
  })

  it('accepts a transaction the chain signed, since a signature carries no consensus weight', async () => {
    // What arkd serves back is the SIGNED transaction: witness data only.
    const signed = Transaction.fromPSBT(base64.decode(GRAPH.arkTx))
    setTapScriptSigEntries(signed, 1, [
      { pubKey: hex.decode(xonly(2)), leafHash: new Uint8Array(32).fill(3), signature: new Uint8Array(64).fill(4) },
    ])
    const h = await harness({
      chain: chainOf({ txs: [base64.encode(signed.toPSBT()), GRAPH.checkpoints[0]!] }),
    })

    await expect(h.reconcile()).resolves.toEqual({ status: 'settled', txid: GRAPH.finalTxid })
  })

  it('stays pending when the indexer serves a different transaction entirely', async () => {
    const other = buildGraph(payments({ payout: 2_900n }))
    const h = await harness({ chain: chainOf({ txs: [other.arkTx, GRAPH.checkpoints[0]!] }) })

    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })
    expect((await h.attempt())?.phase).toBe('submitting')
  })

  it('refuses a stored graph whose bytes do not hash to the id beside them', async () => {
    const h = await harness({ binding: bindingJson({ graph: { ...boundTo(GRAPH).graph, id: '0'.repeat(64) } }) })

    await expect(h.reconcile()).rejects.toThrow(/graph/)
    expect((await h.attempt())?.phase).toBe('submitting')
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
  })

  it('refuses a bound graph that pays a maker the row never named', async () => {
    const elsewhere = buildGraph([{ script: vtxoScript(7).pkScript, amount: 330n }, ...payments().slice(1)])
    const h = await harness({ binding: bindingJson(boundTo(elsewhere)), chain: servedFrom(elsewhere) })

    await expect(h.reconcile()).rejects.toThrow(/maker|receiver/)
  })

  it('refuses a bound graph that pays the solver somewhere the snapshot never approved', async () => {
    const elsewhere = buildGraph([...payments().slice(0, 3), { script: vtxoScript(8).pkScript, amount: 2_995n }])
    const h = await harness({ binding: bindingJson(boundTo(elsewhere)), chain: servedFrom(elsewhere) })

    await expect(h.reconcile()).rejects.toThrow(/proceeds/)
  })
})

/** A graph can name every right party and hash to its own id while moving the
 * wrong sats, so these drive QUANTITY through a perfect identity chain. */
describe('the observer measures the sats, not only who they went to', () => {
  const settledOn = async (graph: typeof GRAPH) =>
    harness({ binding: bindingJson(boundTo(graph)), chain: servedFrom(graph) })

  it('refuses a carrier sized for the operator rather than the quote', async () => {
    const h = await settledOn(buildGraph(payments({ carrier: 331n, payout: 2_994n })))

    await expect(h.reconcile()).rejects.toThrow(/carries the maker/)
    expect((await h.attempt())?.phase).toBe('submitting')
  })

  it('refuses a fare over the cap, wherever the graph spells it', async () => {
    // Contribution untouched at 329: the ten sats come out of the payout, which
    // is where every fare comes from however it is labelled.
    const h = await settledOn(buildGraph(payments({ fare: 14n, payout: 2_985n })))

    await expect(h.reconcile()).rejects.toThrow(/nets the solver/)
    expect((await h.attempt())?.phase).toBe('submitting')
  })

  it('refuses a fare hidden in the sponsor change rather than the fare output', async () => {
    const h = await settledOn(buildGraph(payments({ change: 181n, payout: 2_985n })))

    await expect(h.reconcile()).rejects.toThrow(/nets the solver/)
  })

  it('refuses a sponsor that contributed less than the quote it was authorised for', async () => {
    // 10 sats of the 329 never arrived: the solver's net falls by exactly that.
    const h = await settledOn(buildGraph(payments({ payout: 2_985n })))

    await expect(h.reconcile()).rejects.toThrow(/nets the solver/)
  })

  it('settles a fill that pays a smaller fare than the cap, which is not adverse', async () => {
    const h = await settledOn(buildGraph(payments({ fare: 1n, payout: 2_998n })))

    await expect(h.reconcile()).resolves.toMatchObject({ status: 'settled' })
  })

  it('refuses a graph that shorts the maker the asset it was quoted', async () => {
    const short = Extension.create([
      createAssetPacket(new Map([[1, [{ assetId: ASSET, amount: 10n }]]]), [
        { address: '', assets: [{ assetId: ASSET, amount: 9n }] },
      ]),
    ]).txOut()
    const built = buildOffchainTx([DEPOSIT, SOLVER, SPONSOR], [...payments(), short], SERVER_UNROLL)
    const arkTx = base64.encode(built.arkTx.toPSBT())
    const checkpoints = built.checkpoints.map((c) => base64.encode(c.toPSBT()))
    const inputOwners: readonly (string | null)[] = [null, 'solver', 'sponsor']
    const graph = {
      arkTx,
      checkpoints,
      inputOwners,
      graphId: digestJointGraph({ arkTx, checkpoints, inputOwners }, OFFER_FILL_TEMPLATE),
      finalTxid: built.arkTx.id,
      checkpointTxids: built.checkpoints.map((c) => c.id),
    }
    const h = await settledOn(graph)

    await expect(h.reconcile()).rejects.toThrow(/does not pay the maker 10/)
  })

  it('refuses a recycle row with no asset leg rather than skipping the check', async () => {
    const h = await harness()

    await expect(h.reconcileAs({ ...rowOf(), toAssetId: null })).rejects.toThrow(/names no asset leg/)
  })
})

/** The lever no sats floor can see: an asset routed to the operator moves no
 * sats, so only reading WHERE the packet pays catches it. */
describe('the observer checks where the assets went, not only how many', () => {
  const withPacket = async (packetOut: ReturnType<Extension['txOut']>) => {
    const built = buildOffchainTx([DEPOSIT, SOLVER, SPONSOR], [...payments(), packetOut], SERVER_UNROLL)
    const arkTx = base64.encode(built.arkTx.toPSBT())
    const checkpoints = built.checkpoints.map((c) => base64.encode(c.toPSBT()))
    const inputOwners: readonly (string | null)[] = [null, 'solver', 'sponsor']
    const graph = {
      arkTx,
      checkpoints,
      inputOwners,
      graphId: digestJointGraph({ arkTx, checkpoints, inputOwners }, OFFER_FILL_TEMPLATE),
      finalTxid: built.arkTx.id,
      checkpointTxids: built.checkpoints.map((c) => c.id),
    }
    return harness({ binding: bindingJson(boundTo(graph)), chain: servedFrom(graph) })
  }

  it('refuses a packet that pays the asset to the sponsor fare output', async () => {
    const h = await withPacket(
      Extension.create([
        createAssetPacket(new Map([[1, [{ assetId: ASSET, amount: 20n }]]]), [
          { address: '', assets: [{ assetId: ASSET, amount: 10n }] },
          { address: '', assets: [{ assetId: ASSET, amount: 10n }] },
        ]),
      ]).txOut(),
    )

    await expect(h.reconcile()).rejects.toThrow(/which is not ours/)
  })

  it('admits the surplus the solver pays back to itself', async () => {
    const h = await withPacket(
      Extension.create([
        createAssetPacket(new Map([[1, [{ assetId: ASSET, amount: 20n }]]]), [
          { address: '', assets: [{ assetId: ASSET, amount: 10n }] },
          { address: '' },
          { address: '' },
          { address: '', assets: [{ assetId: ASSET, amount: 10n }] },
        ]),
      ]).txOut(),
    )

    await expect(h.reconcile()).resolves.toMatchObject({ status: 'settled' })
  })

  it('refuses a packet that slips a second asset onto the maker output', async () => {
    const other = `${'cc'.repeat(31)}dd0100`
    const h = await withPacket(
      Extension.create([
        createAssetPacket(
          new Map([
            [
              1,
              [
                { assetId: ASSET, amount: 10n },
                { assetId: other, amount: 5n },
              ],
            ],
          ]),
          [
            {
              address: '',
              assets: [
                { assetId: ASSET, amount: 10n },
                { assetId: other, amount: 5n },
              ],
            },
          ],
        ),
      ]).txOut(),
    )

    await expect(h.reconcile()).rejects.toThrow(/and nothing else/)
  })
})

describe('the observer never releases a reservation it cannot prove idle', () => {
  it('releases and refuses an attempt the submitting marker never reached', async () => {
    const h = await harness({ phase: 'quoted' })

    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })
    expect((await h.attempt())?.phase).toBe('not_submitted')
    expect(await h.state()).toBe('refused')
    expect(h.ledger.reserved().size).toBe(0)
    expect(h.pins.heldFor('swap-1')).toHaveLength(0)
  })

  it('releases and refuses an attempt that never got past its first checkpoint', async () => {
    const h = await harness({ phase: 'prepared' })

    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })
    expect((await h.attempt())?.phase).toBe('not_submitted')
    expect(h.ledger.reserved().size).toBe(0)
  })

  it('frees the pins of an attempt another caller already proved never-submitted', async () => {
    // The same leak `settle` closes, in the one other place the pattern is live.
    const h = await harness({ phase: 'quoted' })
    const quoted = (await h.attempt())!
    await h.store.refuseNeverSubmittedCarrierAttempt('swap-1', quoted, 'not filled: another caller got there')
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])

    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })

    expect((await h.attempt())?.phase).toBe('not_submitted')
    expect(h.ledger.reserved().size).toBe(0)
    expect(h.pins.heldFor('swap-1')).toHaveLength(0)
  })

  it('keeps every pin while a submitted fill has no proof yet', async () => {
    const h = await harness({ chain: chainOf({ vtxos: [] }) })

    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
  })

  it('frees the pins through the ledger, never by row key', async () => {
    const h = await harness()
    const other = createReservationLedger()
    h.pins.adopt('swap-1', other.reserve([{ txid: '5'.repeat(64), vout: 2 }]))

    await h.reconcile()

    expect(h.ledger.reserved().size).toBe(0)
    expect(other.reserved().size).toBe(0)
    expect(h.pins.heldFor('swap-1')).toHaveLength(0)
  })

  it('re-answers a settled attempt from its own record, asking the chain nothing', async () => {
    const h = await harness()
    await h.reconcile()
    const chain = chainOf()
    const { reconcile } = createTaxiReceiveCarrierObserver({ store: h.store, chain, pins: h.pins })

    await expect(reconcile(rowOf())).resolves.toEqual({ status: 'settled', txid: GRAPH.finalTxid })
    expect(chain.asked).toEqual([])
  })

  it('stays pending on a row whose attempt has not been written yet', async () => {
    const store = await openStore()
    const pins = createCarrierPinLedger()
    const { reconcile } = createTaxiReceiveCarrierObserver({ store, chain: chainOf(), pins })

    await expect(reconcile(rowOf())).resolves.toEqual({ status: 'pending' })
  })
})

describe('the final transaction must spend the checkpoints it was built over', () => {
  it('refuses a final transaction whose inputs are not exactly checkpoint:0', async () => {
    const forged = new Transaction({
      version: 3,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    })
    // Input 0 spends checkpoint 0 at vout 1 rather than the only output it has.
    forged.addInput({ txid: GRAPH.checkpointTxids[0]!, index: 1 })
    for (const id of GRAPH.checkpointTxids.slice(1)) forged.addInput({ txid: id, index: 0 })
    for (const payment of payments()) forged.addOutput(payment)
    forged.addOutput(ASSET_EXT)
    const arkTx = base64.encode(forged.toPSBT())
    const owners = [...GRAPH.inputOwners]
    const graphId = digestJointGraph(
      { arkTx, checkpoints: [...GRAPH.checkpoints], inputOwners: owners },
      OFFER_FILL_TEMPLATE,
    )
    const h = await harness({
      binding: bindingJson({
        graph: { id: graphId, ark_tx: arkTx, checkpoints: [...GRAPH.checkpoints], input_owners: owners },
      }),
    })

    await expect(h.reconcile()).rejects.toThrow(/checkpoint/)
  })

  it('refuses a final transaction that spends the right checkpoints in the wrong order', async () => {
    const forged = new Transaction({
      version: 3,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    })
    // Every input IS a `checkpoint:0` of this graph — just not input i's.
    for (const id of [GRAPH.checkpointTxids[1]!, GRAPH.checkpointTxids[0]!, GRAPH.checkpointTxids[2]!]) {
      forged.addInput({ txid: id, index: 0 })
    }
    for (const payment of payments()) forged.addOutput(payment)
    forged.addOutput(ASSET_EXT)
    const arkTx = base64.encode(forged.toPSBT())
    const owners = [...GRAPH.inputOwners]
    const h = await harness({
      binding: bindingJson({
        graph: {
          id: digestJointGraph(
            { arkTx, checkpoints: [...GRAPH.checkpoints], inputOwners: owners },
            OFFER_FILL_TEMPLATE,
          ),
          ark_tx: arkTx,
          checkpoints: [...GRAPH.checkpoints],
          input_owners: owners,
        },
      }),
    })

    await expect(h.reconcile()).rejects.toThrow(/does not spend checkpoint/)
  })

  it('refuses a graph whose covenant checkpoint spends a deposit the row never recorded', async () => {
    const elsewhere = buildGraph(payments(), [coinInput(1, '8'.repeat(64), 3, 1_000), SOLVER, SPONSOR])
    const h = await harness({ binding: bindingJson(boundTo(elsewhere)) })

    await expect(h.reconcile()).rejects.toThrow(/deposit/)
  })
})
