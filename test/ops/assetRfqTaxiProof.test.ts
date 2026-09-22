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
  Transaction,
} from '@arkade-os/sdk'
import { digestJointGraph, OFFER_FILL_TEMPLATE } from '@arkade-taxi/client'
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

const DEPOSIT = coinInput(1, DEPOSIT_TXID, 1, 1_000)
const SOLVER = coinInput(2, COIN_A, 0, 2_000)

/** Input 1 (the solver coin) carries the asset; output 0 pays it to the maker. */
const ASSET_EXT = Extension.create([
  createAssetPacket(new Map([[1, [{ assetId: ASSET, amount: 10n }]]]), [
    { address: '', assets: [{ assetId: ASSET, amount: 10n }] },
  ]),
]).txOut()

const buildGraph = (outputs: { script: Uint8Array; amount: bigint }[]) => {
  const built = buildOffchainTx([DEPOSIT, SOLVER], [...outputs, ASSET_EXT], SERVER_UNROLL)
  const arkTx = base64.encode(built.arkTx.toPSBT())
  const checkpoints = built.checkpoints.map((c) => base64.encode(c.toPSBT()))
  const inputOwners: readonly (string | null)[] = [null, 'solver']
  return {
    arkTx,
    checkpoints,
    inputOwners,
    graphId: digestJointGraph({ arkTx, checkpoints, inputOwners }, OFFER_FILL_TEMPLATE),
    finalTxid: built.arkTx.id,
    checkpointTxids: built.checkpoints.map((c) => c.id),
  }
}

const GRAPH = buildGraph([
  { script: MAKER, amount: 330n },
  { script: PROCEEDS, amount: 2_670n },
])

const bindingJson = (over: Record<string, unknown> = {}) => ({
  fill_id: 'fill-1',
  expires_at: 8_000,
  graph: {
    id: GRAPH.graphId,
    ark_tx: GRAPH.arkTx,
    checkpoints: [...GRAPH.checkpoints],
    input_owners: [...GRAPH.inputOwners],
  },
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
  contribution_sats: '329',
  max_fare_sats: '4',
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
        [GRAPH.checkpointTxids[0]!, GRAPH.checkpoints[0]!],
        [GRAPH.checkpointTxids[1]!, GRAPH.checkpoints[1]!],
      ])
      if (over.txs !== undefined) return { txs: [...over.txs] }
      return { txs: txids.flatMap((id) => (known.has(id) ? [known.get(id)!] : [])) }
    },
  }
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
    reconcile: () => reconcile(row(store)),
    store,
    pins,
    ledger,
    attempt: () => store.readCarrierAttempt('swap-1'),
    state: async () => (await store.get('swap-1')).state,
  }
}

const row = (_store: AssetRfqSwapStore): AssetRfqSwapRow =>
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

  it('stays pending when the indexer serves no transaction for the id it derived', async () => {
    const h = await harness({ chain: chainOf({ txs: [] }) })

    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })
    expect((await h.attempt())?.phase).toBe('submitting')
  })

  it('stays pending when the served transaction shares its id but not its bytes', async () => {
    // Same inputs, outputs, version and locktime — so the same txid — with the
    // tap leaves and the taptree the solver committed to stripped out.
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

    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })
    expect((await h.attempt())?.phase).toBe('submitting')
  })

  it('stays pending when the indexer serves a different transaction entirely', async () => {
    const other = buildGraph([
      { script: MAKER, amount: 330n },
      { script: PROCEEDS, amount: 2_600n },
    ])
    const h = await harness({ chain: chainOf({ txs: [other.arkTx, GRAPH.checkpoints[0]!] }) })

    await expect(h.reconcile()).resolves.toEqual({ status: 'pending' })
    expect((await h.attempt())?.phase).toBe('submitting')
  })

  it('refuses a stored graph whose bytes do not hash to the id beside them', async () => {
    const tampered = bindingJson({
      graph: {
        id: '0'.repeat(64),
        ark_tx: GRAPH.arkTx,
        checkpoints: [...GRAPH.checkpoints],
        input_owners: [null, 'solver'],
      },
    })
    const h = await harness({ binding: tampered })

    await expect(h.reconcile()).rejects.toThrow(/graph/)
    expect((await h.attempt())?.phase).toBe('submitting')
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
  })

  it('refuses a bound graph that pays a maker the row never named', async () => {
    const elsewhere = buildGraph([
      { script: vtxoScript(7).pkScript, amount: 330n },
      { script: PROCEEDS, amount: 2_670n },
    ])
    const h = await harness({
      binding: bindingJson({
        graph: {
          id: elsewhere.graphId,
          ark_tx: elsewhere.arkTx,
          checkpoints: [...elsewhere.checkpoints],
          input_owners: [null, 'solver'],
        },
      }),
      chain: chainOf({ spentBy: elsewhere.checkpointTxids[0]!, txs: [elsewhere.arkTx, elsewhere.checkpoints[0]!] }),
    })

    await expect(h.reconcile()).rejects.toThrow(/maker|receiver/)
  })

  it('refuses a bound graph that pays the solver somewhere the snapshot never approved', async () => {
    const elsewhere = buildGraph([
      { script: MAKER, amount: 330n },
      { script: vtxoScript(8).pkScript, amount: 2_670n },
    ])
    const h = await harness({
      binding: bindingJson({
        graph: {
          id: elsewhere.graphId,
          ark_tx: elsewhere.arkTx,
          checkpoints: [...elsewhere.checkpoints],
          input_owners: [null, 'solver'],
        },
      }),
      chain: chainOf({ spentBy: elsewhere.checkpointTxids[0]!, txs: [elsewhere.arkTx, elsewhere.checkpoints[0]!] }),
    })

    await expect(h.reconcile()).rejects.toThrow(/proceeds/)
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

    await expect(reconcile(row(h.store))).resolves.toEqual({ status: 'settled', txid: GRAPH.finalTxid })
    expect(chain.asked).toEqual([])
  })

  it('stays pending on a row whose attempt has not been written yet', async () => {
    const store = await openStore()
    const pins = createCarrierPinLedger()
    const { reconcile } = createTaxiReceiveCarrierObserver({ store, chain: chainOf(), pins })

    await expect(reconcile(row(store))).resolves.toEqual({ status: 'pending' })
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
    forged.addInput({ txid: GRAPH.checkpointTxids[0]!, index: 1 })
    forged.addInput({ txid: GRAPH.checkpointTxids[1]!, index: 0 })
    forged.addOutput({ script: MAKER, amount: 330n })
    forged.addOutput({ script: PROCEEDS, amount: 2_670n })
    forged.addOutput(ASSET_EXT)
    const arkTx = base64.encode(forged.toPSBT())
    const graphId = digestJointGraph(
      { arkTx, checkpoints: [...GRAPH.checkpoints], inputOwners: [null, 'solver'] },
      OFFER_FILL_TEMPLATE,
    )
    const h = await harness({
      binding: bindingJson({
        graph: { id: graphId, ark_tx: arkTx, checkpoints: [...GRAPH.checkpoints], input_owners: [null, 'solver'] },
      }),
    })

    await expect(h.reconcile()).rejects.toThrow(/checkpoint/)
  })

  it('refuses a graph whose covenant checkpoint spends a deposit the row never recorded', async () => {
    const elsewhere = buildOffchainTx(
      [coinInput(1, '8'.repeat(64), 3, 1_000), SOLVER],
      [{ script: MAKER, amount: 330n }, { script: PROCEEDS, amount: 2_670n }, ASSET_EXT],
      SERVER_UNROLL,
    )
    const arkTx = base64.encode(elsewhere.arkTx.toPSBT())
    const checkpoints = elsewhere.checkpoints.map((c) => base64.encode(c.toPSBT()))
    const h = await harness({
      binding: bindingJson({
        graph: {
          id: digestJointGraph({ arkTx, checkpoints, inputOwners: [null, 'solver'] }, OFFER_FILL_TEMPLATE),
          ark_tx: arkTx,
          checkpoints,
          input_owners: [null, 'solver'],
        },
      }),
    })

    await expect(h.reconcile()).rejects.toThrow(/deposit/)
  })
})
