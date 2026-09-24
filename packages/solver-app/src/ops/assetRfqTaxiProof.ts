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
import { Extension, getArkPsbtFields, Transaction, VtxoTaprootTree } from '@arkade-os/sdk'
import { verifyOfferFillPlan } from '@arkade-taxi/client'
import {
  assertAssetPayouts,
  assertSolverSatsFloor,
  solverSatsFlow,
  type CarrierAuthorisedSats,
} from './assetRfqTaxiRebuild.js'
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
  /** Ruling 5's canceller, reached only on a pass that proved nothing. Absent, an unproven fill pends forever. */
  cancel?: (row: AssetRfqSwapRow, attempt: CarrierAttempt) => Promise<ReceiveCarrierReconcileOutcome>
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

const satsField = (value: JsonValue | undefined, label: string): bigint => {
  const raw = stringField(value, label)
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${label} is not a canonical decimal`)
  return BigInt(raw)
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

/** Every id the bound fill produces, from re-hashed bytes: a pinned coin spent by
 * one of these is the fill landing, never a third party. */
export const carrierFillIds = (attempt: CarrierAttempt, label: string): ReadonlySet<string> => {
  const graph = boundGraphOf(attempt, label)
  return new Set([graph.arkTx, ...graph.checkpoints].map((psbt) => Transaction.fromPSBT(base64.decode(psbt)).id))
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

  const authorised: CarrierAuthorisedSats = {
    physicalSats: satsField(attempt.snapshot.physical_sats, `${label} snapshot physical sats`),
    contributionSats: satsField(attempt.snapshot.contribution_sats, `${label} snapshot contribution sats`),
    maxFareSats: satsField(attempt.snapshot.max_fare_sats, `${label} snapshot max fare sats`),
  }
  const receiver = finalTx.getOutput(0)
  if (receiver?.script === undefined || hex.encode(receiver.script) !== row.makerPkScript.toLowerCase()) {
    throw new Error(`${label} bound graph output 0 does not pay the maker the row named`)
  }
  if (receiver.amount !== authorised.physicalSats) {
    throw new Error(
      `${label} bound graph carries the maker ${receiver.amount} sats, not the authorised ${authorised.physicalSats}`,
    )
  }
  const proceeds = stringField(attempt.snapshot.proceeds_script, `${label} snapshot proceeds script`).toLowerCase()
  const outputs = Array.from({ length: finalTx.outputsLength }, (_, i) => finalTx.getOutput(i))
  if (!outputs.some((output) => output?.script !== undefined && hex.encode(output.script) === proceeds)) {
    throw new Error(`${label} bound graph pays the solver proceeds nowhere`)
  }
  assertSolverSatsFloor(
    solverSatsFlow(finalTx, checkpoints, graph.inputOwners, depositIndex, hex.decode(proceeds), `${label} bound graph`),
    authorised,
    `${label} bound graph`,
  )
  // A recycle with no asset leg cannot exist — `settle` refuses one before any
  // attempt is written — so this is a contradiction, never a case to skip.
  if (row.toAssetId === null) throw new Error(`${label} reconciles a recycle row that names no asset leg`)
  assertAssetPayouts(finalTx, proceeds, row, `${label} bound graph`)

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
    // Not served yet is ordinary. Served under this id while committing to
    // something else is not, and must not read as "not confirmed yet": an
    // attempt that pends forever holds its coins forever.
    if (onChain === undefined) return null
    assertSameSpendCommitment(onChain, expected.get(id)!, `${label} transaction ${id}`)
  }
  return { txid: built.txid, depositCheckpointTxid }
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  a === undefined || b === undefined ? a === b : hex.encode(a) === hex.encode(b)

const tapLeavesOf = (tx: Transaction, at: number): readonly string[] =>
  (tx.getInput(at).tapLeafScript ?? [])
    .map(
      ([control, script]) =>
        `${control.version}:${hex.encode(control.internalKey)}:${control.merklePath.map(hex.encode).join('/')}:${hex.encode(script)}`,
    )
    .sort()

/** TAP METADATA ONLY, and only while these bytes are EVIDENCE: nothing spends
 * them, so a missing leaf is a thinner answer. Never widen to `witnessUtxo`. */
const sameOrAbsent = (got: readonly string[], want: readonly string[]): boolean =>
  got.length === 0 || got.join(',') === want.join(',')

/** Only what the txid leaves out — both sides are keyed on an id recomputed from
 * their own bytes. `witnessUtxo.script` is the live one: the taproot output key. */
const assertSameSpendCommitment = (candidate: Transaction, trusted: Transaction, label: string): void => {
  const differs = (what: string): never => {
    throw new Error(`${label} is served with a different ${what} than the one this solver signed`)
  }
  // Asserted, not assumed: a caller keying by label would unmake the rest.
  if (candidate.id !== trusted.id) differs('transaction')
  for (let i = 0; i < trusted.inputsLength; i += 1) {
    const got = candidate.getInput(i)
    const want = trusted.getInput(i)
    // Strict where finalization KEEPS a field (`PSBTInputFinalKeys`), tolerant
    // below where it drops one: missing this wedges, missing a taptree settles.
    if (!sameBytes(got.witnessUtxo?.script, want.witnessUtxo?.script)) differs(`input ${i} prevout script`)
    if (got.witnessUtxo?.amount !== want.witnessUtxo?.amount) differs(`input ${i} prevout value`)
    if (!sameOrAbsent(tapLeavesOf(candidate, i), tapLeavesOf(trusted, i))) differs(`input ${i} tap leaves`)
    const trees = (of: Transaction): readonly string[] =>
      getArkPsbtFields(of, i, VtxoTaprootTree).map(hex.encode).sort()
    if (!sameOrAbsent(trees(candidate), trees(trusted))) differs(`input ${i} taptree`)
  }
}

const releaseEveryPin = (pins: CarrierPinLedger, id: string): void => {
  for (const pin of pins.heldFor(id)) pin.release()
}

export const createTaxiReceiveCarrierObserver = (
  deps: TaxiCarrierProofDeps,
): Pick<ReceiveCarrierQuotes, 'reconcile'> => ({ reconcile: observeWith(deps, new Set<string>()) })

/** The hold is the invariant; the silence is not. `raised` is PER ADAPTER. */
const observeWith =
  (deps: TaxiCarrierProofDeps, raised: Set<string>) =>
  async (row: AssetRfqSwapRow): Promise<ReceiveCarrierReconcileOutcome> => {
    const attempt = await deps.store.readCarrierAttempt(row.id)
    // The write that precedes the first POST never landed, so there is nothing
    // to observe and nothing that ever will be. NOT a refusal and NOT a release:
    // a null attempt also spells a settle short of its first checkpoint, which
    // escalating fences off anyway — every attempt write CASes on `filling`.
    if (attempt === null) {
      return { status: 'stuck', reason: 'receive-carrier settlement stopped before preparing an attempt' }
    }
    if (attempt.phase === 'settled') {
      const txid = attempt.fillTxid
      if (txid === undefined) throw new Error(`carrier fill ${row.id} is settled against no transaction`)
      releaseEveryPin(deps.pins, row.id)
      return { status: 'settled', txid }
    }
    // Durable proof nothing can land: the refusal CAS writes `not_submitted` only
    // over `prepared`/`quoted`, and `cancelled` only once the chain showed the
    // conflict spend. Any other holder's pin is `settle`'s leak.
    if (attempt.phase === 'not_submitted' || attempt.phase === 'cancelled') {
      releaseEveryPin(deps.pins, row.id)
      return { status: 'pending' }
    }
    if (attempt.phase !== 'submitting' && attempt.phase !== 'cancelling') {
      // The submitting marker is committed BEFORE the submit POST, so a durable
      // phase short of it is proof nothing was ever sent.
      const reason = `not filled: reconciliation found the attempt still '${attempt.phase}', so it never submitted`
      if (await deps.store.refuseNeverSubmittedCarrierAttempt(row.id, attempt, reason)) {
        releaseEveryPin(deps.pins, row.id)
      }
      return { status: 'pending' }
    }

    let proof: CarrierFillProof | null
    try {
      proof = await proveCarrierFill(row, attempt, deps.chain)
    } catch (error) {
      if (raised.has(row.id)) return { status: 'pending' }
      raised.add(row.id)
      throw error
    }
    if (proof === null) return deps.cancel === undefined ? { status: 'pending' } : deps.cancel(row, attempt)
    // The coins are spent by a transaction this call just proved, so the
    // reservation over them is the one thing that is now certainly stale.
    if (await deps.store.settleCarrierAttempt(row.id, attempt, proof.txid)) releaseEveryPin(deps.pins, row.id)
    return { status: 'settled', txid: proof.txid }
  }
