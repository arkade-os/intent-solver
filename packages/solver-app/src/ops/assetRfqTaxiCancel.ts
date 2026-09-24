/**
 * Cancel-by-conflict (Ruling 5): past both deadlines the solver spends every
 * pinned input to itself, so a fill it signed can never land. The exact bytes
 * are durable before they are sent, a restart only ever re-sends those bytes,
 * and a pin is released on chain evidence alone — never on a submit's answer.
 */

import { base64, hex } from '@scure/base'
import {
  assertSubmittedArkTxid,
  buildOffchainTx,
  Intent,
  matchServerCheckpoints,
  Transaction,
  type ArkProvider,
  type CSVMultisigTapscript,
  type Identity,
} from '@arkade-os/sdk'
import { outpointKey } from '@arkade-os/solver-arkade/arkade/lockupFunding.js'
import { attachEmulatorPackets, refundAssetPacket } from '@arkade-os/solver-arkade/arkade/wallet.js'
import type { AssetRfqSwapRow } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import type { CarrierAttempt, JsonObject, JsonValue } from '@arkade-os/solver-corridors/db/carrierAttempt.js'
import type { ReceiveCarrierReconcileOutcome } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import {
  carrierTaprootEvidence,
  decodeCarrierAttemptInputs,
  type CarrierCoin,
  type CarrierOutpoint,
  type CarrierPinLedger,
} from './assetRfqTaxi.js'
import { carrierFillIds, type CarrierChainReader } from './assetRfqTaxiProof.js'

export const CARRIER_CONFLICT_AFTER_SECONDS = 900

export interface CarrierConflictStore {
  cancelCarrierAttempt(id: string, expected: CarrierAttempt, next: CarrierAttempt): Promise<boolean>
  refuseCancelledCarrierAttempt(id: string, expected: CarrierAttempt, reason: string): Promise<boolean>
  readCarrierAttempt(id: string): Promise<CarrierAttempt | null>
}

export type CarrierConflictArk = Pick<ArkProvider, 'submitTx' | 'finalizeTx' | 'getPendingTxs'>

export interface CarrierConflictDeps {
  store: CarrierConflictStore
  chain: CarrierChainReader
  pins: CarrierPinLedger
  /** Getters, so nothing is resolved before an attempt is actually due. */
  ark: () => CarrierConflictArk
  serverUnrollScript: () => CSVMultisigTapscript.Type
  signer: Pick<Identity, 'sign'>
  coins: () => Promise<readonly CarrierCoin[]>
  solverKeys: readonly string[]
  serverKey: () => Uint8Array
  now: () => number
}

/** Pins held, attempt still `cancelling` or `submitting`: a human or a later pass must move it. */
export class CarrierConflictStalledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CarrierConflictStalledError'
  }
}

/** Not confirmed accepted: refused, or lost after arkd may have taken it. Pins held; the next pass re-sends it. */
export class CarrierConflictRejectedError extends Error {
  readonly txid: string
  constructor(label: string, txid: string, cause: unknown) {
    super(`${label}: conflict ${txid}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'CarrierConflictRejectedError'
    this.txid = txid
  }
}

const PENDING: ReceiveCarrierReconcileOutcome = { status: 'pending' }

const stringOf = (value: JsonValue | undefined, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is not recorded`)
  return value
}

const conflictDeadline = (snapshot: JsonObject, label: string): number => {
  const deadlines = [snapshot.valid_until, (snapshot.quote as JsonObject | undefined)?.expires_at]
  if (!deadlines.every((value) => Number.isSafeInteger(value))) {
    throw new Error(`${label} snapshot records no deadline to wait out`)
  }
  return Math.max(...(deadlines as number[])) + CARRIER_CONFLICT_AFTER_SECONDS
}

interface StoredConflict {
  txid: string
  arkTx: Transaction
  arkTxPsbt: string
  checkpoints: Transaction[]
  checkpointPsbts: string[]
  ids: ReadonlySet<string>
}

/** Re-hashed on every read: a release is keyed on ids from these bytes, not the strings beside them. */
const storedConflictOf = (
  attempt: CarrierAttempt,
  pinned: readonly CarrierOutpoint[],
  label: string,
): StoredConflict => {
  const raw = attempt.binding?.conflict as JsonObject | undefined
  if (raw === undefined || !Array.isArray(raw.checkpoints) || !Array.isArray(raw.checkpoint_txids)) {
    throw new Error(`${label} records no conflict spend`)
  }
  const arkTxPsbt = stringOf(raw.ark_tx, `${label} conflict transaction`)
  const checkpointPsbts = raw.checkpoints.map((entry, i) => stringOf(entry, `${label} conflict checkpoint ${i}`))
  const arkTx = Transaction.fromPSBT(base64.decode(arkTxPsbt))
  const checkpoints = checkpointPsbts.map((psbt) => Transaction.fromPSBT(base64.decode(psbt)))
  if (arkTx.id !== raw.txid || checkpoints.map((tx) => tx.id).join() !== raw.checkpoint_txids.join()) {
    throw new Error(`${label} conflict bytes do not hash to the ids recorded beside them`)
  }
  const spends = checkpoints.map((tx) => {
    const input = tx.getInput(0)
    return outpointKey(input.txid === undefined ? '' : hex.encode(input.txid), input.index ?? -1)
  })
  if (spends.join() !== pinned.map((coin) => outpointKey(coin.txid, coin.vout)).join()) {
    throw new Error(`${label} conflict spends ${spends.join()}, not the inputs it pinned`)
  }
  // Release reads only this transaction's txid:0, so it must be what spends every checkpoint above.
  const links = Array.from({ length: arkTx.inputsLength }, (_, i) => {
    const input = arkTx.getInput(i)
    return outpointKey(input.txid === undefined ? '' : hex.encode(input.txid), input.index ?? -1)
  })
  if (links.join() !== checkpoints.map((tx) => outpointKey(tx.id, 0)).join()) {
    throw new Error(`${label} conflict does not spend exactly its own checkpoints`)
  }
  const proceeds = stringOf(attempt.snapshot.proceeds_script, `${label} snapshot proceeds script`).toLowerCase()
  const paid = arkTx.getOutput(0)?.script
  if (paid === undefined || hex.encode(paid) !== proceeds) throw new Error(`${label} conflict does not pay the solver`)
  const ids = new Set([arkTx.id, ...checkpoints.map((tx) => tx.id)])
  return { txid: arkTx.id, arkTx, arkTxPsbt, checkpoints, checkpointPsbts, ids }
}

type Evidence = { kind: 'unspent' | 'fill' | 'conflict' } | { kind: 'stuck'; reason: string }

/** An id counts only if one side alone produces it. The conflict's checkpoint over a pinned
 * coin IS the fill's (same coin, leaf, unroll script), so in practice only its ark txid reads
 * `conflict`; nothing here releases. Truthiness: the wire spells unspent as "". */
const evidenceOf = async (
  chain: CarrierChainReader,
  pinned: readonly CarrierOutpoint[],
  conflictIds: ReadonlySet<string>,
  fillIds: ReadonlySet<string>,
): Promise<Evidence> => {
  const { vtxos } = await chain.getVtxos({ outpoints: pinned.map(({ txid, vout }) => ({ txid, vout })) })
  const ids = new Set<string>()
  for (const coin of pinned) {
    const seen = vtxos.find((vtxo) => vtxo.txid === coin.txid && vtxo.vout === coin.vout)
    for (const id of [seen?.spentBy, seen?.arkTxId, seen?.settledBy]) if (id) ids.add(id)
  }
  const spenders = [...ids]
  const foreign = spenders.find((id) => !conflictIds.has(id) && !fillIds.has(id))
  if (foreign !== undefined) {
    return { kind: 'stuck', reason: `carrier input spent by ${foreign}, which is neither the fill nor its conflict` }
  }
  const byFill = spenders.some((id) => fillIds.has(id) && !conflictIds.has(id))
  const byConflict = spenders.some((id) => conflictIds.has(id) && !fillIds.has(id))
  if (byFill && byConflict) return { kind: 'stuck', reason: 'carrier inputs spent by both the fill and its conflict' }
  return { kind: byConflict ? 'conflict' : byFill ? 'fill' : 'unspent' }
}

/** Every pinned coin via its collaborative leaf, all value to the proceeds script. */
const buildConflict = async (
  deps: CarrierConflictDeps,
  attempt: CarrierAttempt,
  pinned: readonly CarrierOutpoint[],
  label: string,
): Promise<CarrierAttempt> => {
  const live = new Map((await deps.coins()).map((coin) => [outpointKey(coin.txid, coin.vout), coin]))
  const serverKey = deps.serverKey()
  const spent = pinned.map(({ txid, vout }) => {
    const coin = live.get(outpointKey(txid, vout))
    const evidence = coin && carrierTaprootEvidence(coin, deps.solverKeys, serverKey)
    if (coin?.forfeitTapLeafScript === undefined || evidence === undefined) {
      throw new CarrierConflictStalledError(`${label}: pinned ${txid}:${vout} is unspent but not spendable from here`)
    }
    return { coin, leaf: coin.forfeitTapLeafScript, tapTree: evidence.tapTree }
  })
  const total = spent.reduce((sum, { coin }) => sum + BigInt(coin.value), 0n)
  const proceeds = hex.decode(stringOf(attempt.snapshot.proceeds_script, `${label} snapshot proceeds script`))
  const { arkTx, checkpoints } = buildOffchainTx(
    spent.map(({ coin, leaf, tapTree }) => ({
      txid: coin.txid,
      vout: coin.vout,
      value: coin.value,
      tapLeafScript: leaf,
      tapTree,
    })),
    [{ script: proceeds, amount: total }],
    deps.serverUnrollScript(),
  )
  const packet = refundAssetPacket(
    spent.map(({ coin }) => ({
      txid: coin.txid,
      vout: coin.vout,
      value: coin.value,
      assets: (coin.assets ?? []).map((held) => ({ assetId: held.assetId, amount: BigInt(held.amount) })),
    })),
    'aggregate',
  )
  if (packet) attachEmulatorPackets(arkTx, [packet])
  // Indexed: unindexed signing returns an input it cannot sign unsigned, and this is never rebuilt.
  const signed = await deps.signer.sign(
    arkTx,
    spent.map((_, i) => i),
  )
  const conflict: JsonObject = {
    txid: signed.id,
    ark_tx: base64.encode(signed.toPSBT()),
    checkpoints: checkpoints.map((tx) => base64.encode(tx.toPSBT())),
    checkpoint_txids: checkpoints.map((tx) => tx.id),
  }
  return { ...attempt, phase: 'cancelling', binding: { ...attempt.binding, conflict } }
}

/** Signs only checkpoints proven to be the stored ones, exactly as `claimSwapScript` does. */
const finalizeWith = async (
  deps: CarrierConflictDeps,
  conflict: StoredConflict,
  serverCheckpoints: string[],
  label: string,
): Promise<void> => {
  const matched = matchServerCheckpoints(serverCheckpoints, conflict.checkpoints, label)
  const final = await Promise.all(
    matched.map(async ({ server }) => base64.encode((await deps.signer.sign(server, [0])).toPSBT())),
  )
  await deps.ark().finalizeTx(conflict.txid, final)
}

/** arkd marks the inputs spent at ACCEPT and keeps the server-signed checkpoints for
 * `getPendingTxs`; that is the only way back to a finalize a restart interrupted. */
const finalizePending = async (deps: CarrierConflictDeps, conflict: StoredConflict, label: string) => {
  const message: Intent.GetPendingTxMessage = { type: 'get-pending-tx', expire_at: 0 }
  const proof = await deps.signer.sign(
    Intent.create(
      message,
      conflict.checkpoints.map((tx) => tx.getInput(0)),
    ),
    Array.from({ length: conflict.checkpoints.length + 1 }, (_, i) => i),
  )
  const held = await deps.ark().getPendingTxs({ proof: base64.encode(proof.toPSBT()), message })
  const pending = held.find((tx) => tx.arkTxid === conflict.txid)
  if (pending === undefined) {
    throw new CarrierConflictStalledError(`${label}: arkd accepted ${conflict.txid} but holds no pending copy of it`)
  }
  assertSubmittedArkTxid(pending, conflict.arkTx, label)
  await finalizeWith(deps, conflict, pending.signedCheckpointTxs, label)
  return PENDING
}

const submitStored = async (deps: CarrierConflictDeps, conflict: StoredConflict, label: string) => {
  let submitted: Awaited<ReturnType<CarrierConflictArk['submitTx']>>
  try {
    submitted = await deps.ark().submitTx(conflict.arkTxPsbt, [...conflict.checkpointPsbts])
  } catch (error) {
    // An identical resubmit of an accepted tx is refused by id, never re-accepted.
    const text = error instanceof Error ? error.message : String(error)
    if (!text.includes(`duplicated offchain tx ${conflict.txid}`)) {
      throw new CarrierConflictRejectedError(label, conflict.txid, error)
    }
    return finalizePending(deps, conflict, label)
  }
  assertSubmittedArkTxid(submitted, conflict.arkTx, label)
  await finalizeWith(deps, conflict, submitted.signedCheckpointTxs, label)
  return PENDING
}

/** arkd indexes an offchain output only on finalize, and the outpoint lookup reads that store
 * alone: any vtxo at txid:0 is the landed conflict (`isPreconfirmed` on it is normal). */
const finalizedOnChain = async (chain: CarrierChainReader, conflict: StoredConflict): Promise<boolean> => {
  const { vtxos } = await chain.getVtxos({ outpoints: [{ txid: conflict.txid, vout: 0 }] })
  return vtxos.some((vtxo) => vtxo.txid === conflict.txid && vtxo.vout === 0)
}

/** Reached only when `proveCarrierFill` returned null on this same pass. */
export const createCarrierConflictCanceller =
  (deps: CarrierConflictDeps) =>
  async (row: AssetRfqSwapRow, attempt: CarrierAttempt): Promise<ReceiveCarrierReconcileOutcome> => {
    const label = `carrier conflict ${row.id}`
    const pinned = decodeCarrierAttemptInputs(attempt.snapshot, row.id)
    const fillIds = carrierFillIds(attempt, label)

    if (attempt.phase === 'submitting') {
      if (deps.now() <= conflictDeadline(attempt.snapshot, label)) return PENDING
      const seen = await evidenceOf(deps.chain, pinned, new Set(), fillIds)
      if (seen.kind === 'stuck') {
        // A sibling that won the cancelling CAS reads as foreign from this stale envelope.
        const now = await deps.store.readCarrierAttempt(row.id)
        return now?.phase === 'submitting' ? { status: 'stuck', reason: seen.reason } : PENDING
      }
      if (seen.kind !== 'unspent') return PENDING
      const next = await buildConflict(deps, attempt, pinned, label)
      if (!(await deps.store.cancelCarrierAttempt(row.id, attempt, next))) return PENDING
      return submitStored(deps, storedConflictOf(next, pinned, label), label)
    }
    if (attempt.phase !== 'cancelling') throw new Error(`${label} is '${attempt.phase}', which has no conflict to make`)

    const conflict = storedConflictOf(attempt, pinned, label)
    if (await finalizedOnChain(deps.chain, conflict)) {
      const reason = `not filled: conflict ${conflict.txid} spent the inputs the fill needed`
      if (await deps.store.refuseCancelledCarrierAttempt(row.id, attempt, reason)) {
        for (const pin of deps.pins.heldFor(row.id)) pin.release()
      }
      return PENDING
    }
    const seen = await evidenceOf(deps.chain, pinned, conflict.ids, fillIds)
    if (seen.kind === 'stuck') return { status: 'stuck', reason: seen.reason }
    if (seen.kind === 'unspent') return submitStored(deps, conflict, label)
    if (seen.kind === 'fill') return PENDING
    return finalizePending(deps, conflict, label)
  }
