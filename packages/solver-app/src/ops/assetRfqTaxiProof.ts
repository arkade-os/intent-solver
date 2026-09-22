/**
 * Reconciling one submitted fill: exact evidence, or it stays pending.
 *
 * Every id compared here is derived from PSBT bytes the solver built itself and
 * committed at checkpoint 2 — never from a Taxi label, a `state`, or a graph
 * digest taken on trust. The indexer is asked only to serve transactions back,
 * and what it serves has to be those same bytes. Missing or contradictory
 * evidence keeps the attempt liable and its coins pinned: an ambiguous fill is
 * never released, by this or anything else.
 */

import { base64, hex } from '@scure/base'
import { Extension, Transaction } from '@arkade-os/sdk'
import { unsignedPsbtBytes, verifyOfferFillPlan } from '@arkade-taxi/client'
import type { AssetRfqSwapRow } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import type { CarrierAttempt, JsonObject, JsonValue } from '@arkade-os/solver-corridors/db/carrierAttempt.js'
import type {
  ReceiveCarrierQuotes,
  ReceiveCarrierReconcileOutcome,
} from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import { decodeCarrierAttemptInputs, type CarrierOutpoint, type CarrierPinLedger } from './assetRfqTaxi.js'

/** The two spend facts a virtual output carries: `spentBy` is normally the
 * CHECKPOINT id and `arkTxId` the final transaction's. */
export interface CarrierSpentVtxo {
  txid: string
  vout: number
  spentBy?: string
  arkTxId?: string
  settledBy?: string
}

export interface CarrierChainReader {
  getVtxos(opts: { outpoints: { txid: string; vout: number }[] }): Promise<{ vtxos: readonly CarrierSpentVtxo[] }>
  getVirtualTxs(txids: string[]): Promise<{ txs: readonly string[] }>
}

/** Deliberately without `prepareCarrierAttempt` or `markCarrierAttemptSubmitting`:
 * reconciliation cannot start an attempt or advance one towards a submit. */
export interface CarrierProofStore {
  readCarrierAttempt(id: string): Promise<CarrierAttempt | null>
  settleCarrierAttempt(id: string, expected: CarrierAttempt, fillTxid: string): Promise<boolean>
  refuseNeverSubmittedCarrierAttempt(id: string, expected: CarrierAttempt, reason: string): Promise<boolean>
}

export interface TaxiCarrierProofDeps {
  store: CarrierProofStore
  chain: CarrierChainReader
  pins: CarrierPinLedger
}

export interface CarrierFillProof {
  /** The FINAL transaction's own id, derived from its bytes. */
  txid: string
  /** The checkpoint that spends the deposit — what `spentBy` normally names. */
  depositCheckpointTxid: string
}

const CANONICAL_TXID = /^[0-9a-f]{64}$/

const outpointOf = (value: JsonValue | undefined, label: string): CarrierOutpoint => {
  const raw = value as { txid?: unknown; vout?: unknown } | undefined
  if (typeof raw?.txid !== 'string' || !CANONICAL_TXID.test(raw.txid)) throw new Error(`${label}: no canonical txid`)
  if (!Number.isInteger(raw.vout) || (raw.vout as number) < 0) throw new Error(`${label}: no canonical vout`)
  return { txid: raw.txid, vout: raw.vout as number }
}

const stringField = (value: JsonValue | undefined, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is not recorded`)
  return value
}

interface BoundGraph {
  arkTx: string
  checkpoints: string[]
  graphId: string
  inputOwners: (string | null)[]
}

const boundGraphOf = (attempt: CarrierAttempt, label: string): BoundGraph => {
  const raw = attempt.binding?.graph as JsonObject | undefined
  if (raw === undefined) throw new Error(`${label} has no bound graph to reconcile against`)
  const checkpoints = raw.checkpoints
  const owners = raw.input_owners
  if (!Array.isArray(checkpoints) || !Array.isArray(owners)) throw new Error(`${label} bound graph is malformed`)
  const graph: BoundGraph = {
    arkTx: stringField(raw.ark_tx, `${label} bound graph transaction`),
    checkpoints: checkpoints.map((entry, i) => stringField(entry, `${label} bound graph checkpoint ${i}`)),
    graphId: stringField(raw.id, `${label} bound graph id`),
    inputOwners: owners.map((owner) => (owner === null ? null : stringField(owner, `${label} bound graph owner`))),
  }
  // The stored blob proves nothing by being stored: re-hash it, so a rolled
  // back or edited row cannot hand this observer a graph it never built.
  if (!verifyOfferFillPlan(graph)) throw new Error(`${label} bound graph does not hash to the id beside it`)
  return graph
}

const assetPaidTo = (tx: Transaction, assetId: string, vout: number): bigint => {
  let packet
  try {
    packet = Extension.fromTx(tx).getAssetPacket()
  } catch {
    return 0n
  }
  return (packet?.groups ?? [])
    .filter((group) => group.assetId?.toString() === assetId)
    .flatMap((group) => group.outputs)
    .filter((output) => output.vout === vout)
    .reduce((total, output) => total + output.amount, 0n)
}

/**
 * The whole of what the solver built, re-derived from its own committed bytes.
 * Every failure in here is a contradiction between two things the SOLVER owns —
 * the row and the checkpoint — so each one throws rather than reading as an
 * absent answer from the chain.
 */
const reconstruct = (row: AssetRfqSwapRow, attempt: CarrierAttempt, label: string) => {
  const graph = boundGraphOf(attempt, label)
  const finalTx = Transaction.fromPSBT(base64.decode(graph.arkTx))
  const checkpoints = graph.checkpoints.map((psbt) => Transaction.fromPSBT(base64.decode(psbt)))
  const checkpointTxids = checkpoints.map((tx) => tx.id)

  if (finalTx.inputsLength !== checkpoints.length) {
    throw new Error(`${label} spends ${finalTx.inputsLength} inputs over ${checkpoints.length} checkpoints`)
  }
  checkpointTxids.forEach((txid, i) => {
    const spent = finalTx.getInput(i)
    if (spent.txid === undefined || hex.encode(spent.txid) !== txid || spent.index !== 0) {
      throw new Error(`${label} input ${i} does not spend checkpoint ${txid}:0`)
    }
  })

  const spends = checkpoints.map((tx) => {
    const input = tx.getInput(0)
    return `${input.txid === undefined ? '' : hex.encode(input.txid)}:${String(input.index)}`
  })
  const deposit = outpointOf(attempt.snapshot.deposit, `${label} snapshot deposit`)
  const depositIndex = spends.indexOf(`${deposit.txid}:${deposit.vout}`)
  if (depositIndex < 0 || graph.inputOwners[depositIndex] !== null) {
    throw new Error(`${label} bound graph spends no offer deposit at ${deposit.txid}:${deposit.vout}`)
  }
  const selected = decodeCarrierAttemptInputs(attempt.snapshot, row.id).map((coin) => `${coin.txid}:${coin.vout}`)
  const owned = graph.inputOwners.flatMap((owner, i) => (owner === 'solver' ? [spends[i]!] : []))
  if (owned.join(',') !== selected.join(',')) {
    throw new Error(
      `${label} bound graph spends solver inputs ${owned.join(',')}, not the ${selected.join(',')} it pinned`,
    )
  }

  const receiver = finalTx.getOutput(0)
  if (receiver?.script === undefined || hex.encode(receiver.script) !== row.makerPkScript.toLowerCase()) {
    throw new Error(`${label} bound graph output 0 does not pay the maker the row named`)
  }
  const proceeds = stringField(attempt.snapshot.proceeds_script, `${label} snapshot proceeds script`).toLowerCase()
  const pays = Array.from({ length: finalTx.outputsLength }, (_, i) => finalTx.getOutput(i)).some(
    (output) => output?.script !== undefined && hex.encode(output.script) === proceeds,
  )
  if (!pays) throw new Error(`${label} bound graph pays the solver proceeds nowhere`)
  if (row.toAssetId !== null && assetPaidTo(finalTx, row.toAssetId, 0) !== row.toAmount) {
    throw new Error(`${label} bound graph does not pay the maker ${row.toAmount} of ${row.toAssetId}`)
  }

  return { finalTx, txid: finalTx.id, checkpoints, checkpointTxids, depositIndex, deposit }
}

/** Null is "the chain has not shown me enough", never "it is not settled". */
export const proveCarrierFill = async (
  row: AssetRfqSwapRow,
  attempt: CarrierAttempt,
  chain: CarrierChainReader,
): Promise<CarrierFillProof | null> => {
  const label = `carrier fill ${row.id}`
  const built = reconstruct(row, attempt, label)
  const depositCheckpointTxid = built.checkpointTxids[built.depositIndex]!

  const { vtxos } = await chain.getVtxos({ outpoints: [{ txid: built.deposit.txid, vout: built.deposit.vout }] })
  const funded = vtxos.find((vtxo) => vtxo.txid === built.deposit.txid && vtxo.vout === built.deposit.vout)
  // Truthiness, never presence: the wire spells "unspent" as an empty string.
  const spends = [funded?.spentBy, funded?.arkTxId, funded?.settledBy].filter((id): id is string => !!id)
  if (spends.length === 0) return null
  // The deposit's spender is one of the two ids THIS graph produces, or it is
  // somebody else's transaction and nothing here is proven.
  if (!spends.some((id) => id === depositCheckpointTxid || id === built.txid)) return null

  const wanted = [depositCheckpointTxid, built.txid]
  const { txs } = await chain.getVirtualTxs([...wanted])
  const served = new Map<string, Transaction>()
  for (const raw of txs) {
    try {
      const tx = Transaction.fromPSBT(base64.decode(raw))
      served.set(tx.id, tx)
    } catch {
      // An unparseable answer is one fewer piece of evidence, not a verdict.
    }
  }
  const expected = new Map<string, Transaction>([
    [depositCheckpointTxid, built.checkpoints[built.depositIndex]!],
    [built.txid, built.finalTx],
  ])
  for (const id of wanted) {
    const onChain = served.get(id)
    if (onChain === undefined) return null
    if (hex.encode(unsignedPsbtBytes(onChain)) !== hex.encode(unsignedPsbtBytes(expected.get(id)!))) return null
  }
  return { txid: built.txid, depositCheckpointTxid }
}

const releaseEveryPin = (pins: CarrierPinLedger, id: string): void => {
  for (const pin of pins.heldFor(id)) pin.release()
}

export const createTaxiReceiveCarrierObserver = (
  deps: TaxiCarrierProofDeps,
): Pick<ReceiveCarrierQuotes, 'reconcile'> => ({
  reconcile: async (row): Promise<ReceiveCarrierReconcileOutcome> => {
    const attempt = await deps.store.readCarrierAttempt(row.id)
    // No attempt at all: the write that precedes the first POST has not landed,
    // so nothing was asked of the operator and there is nothing to observe yet.
    if (attempt === null) return { status: 'pending' }
    if (attempt.phase === 'settled') {
      const txid = attempt.fillTxid
      if (txid === undefined) throw new Error(`carrier fill ${row.id} is settled against no transaction`)
      releaseEveryPin(deps.pins, row.id)
      return { status: 'settled', txid }
    }
    // Already terminal: its own winner released, and this row is `refused`.
    if (attempt.phase === 'not_submitted') return { status: 'pending' }
    if (attempt.phase !== 'submitting') {
      // The submitting marker is committed BEFORE the submit POST, so a durable
      // phase short of it is proof nothing was ever sent.
      const reason = `not filled: reconciliation found the attempt still '${attempt.phase}', so it never submitted`
      if (await deps.store.refuseNeverSubmittedCarrierAttempt(row.id, attempt, reason)) {
        releaseEveryPin(deps.pins, row.id)
      }
      return { status: 'pending' }
    }

    const proof = await proveCarrierFill(row, attempt, deps.chain)
    if (proof === null) return { status: 'pending' }
    // The coins are spent by a transaction this call just proved, so the
    // reservation over them is the one thing that is now certainly stale.
    if (await deps.store.settleCarrierAttempt(row.id, attempt, proof.txid)) releaseEveryPin(deps.pins, row.id)
    return { status: 'settled', txid: proof.txid }
  },
})
