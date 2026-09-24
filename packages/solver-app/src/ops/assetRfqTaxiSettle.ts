/**
 * Settling one recycle fill: durable intent before every external effect.
 *
 * Three checkpoints, each committed before the boundary it guards. A reply
 * lost after one is recoverable; a reply lost before one cannot have moved
 * money. Each CAS is given the envelope THIS call knows it wrote, never a
 * re-read, which would let a racing worker's checkpoint base this one's.
 * Nothing returns a txid: only chain evidence resolves a submitted fill.
 */

import { hex } from '@scure/base'
import {
  signJointGraphForOwner,
  TaxiError,
  verifyOfferFillPlan,
  type JointGraph,
  type TaxiClient,
} from '@arkade-taxi/client'
import type { Identity } from '@arkade-os/sdk'
import type { ReleaseReservation } from '@arkade-os/solver-arkade/arkade/reservations.js'
import type { AssetLeg } from '@arkade-os/solver-core/core/assetRfq.js'
import type { AssetRfqSwapRow } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import type { CarrierAttempt, JsonObject } from '@arkade-os/solver-corridors/db/carrierAttempt.js'
import {
  receiveCarrierTaxiOf,
  type ReceiveCarrierQuotes,
  type ReceiveCarrierSettleOutcome,
} from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import {
  assetIdValue,
  carrierTaprootEvidence,
  clearsFloor,
  encodeCarrierAttemptInputs,
  type CarrierCoin,
  type CarrierOutpoint,
  type CarrierPin,
  type CarrierPinLedger,
  type CarrierTaprootEvidence,
} from './assetRfqTaxi.js'
import { outpointKey, usableSatsOf } from '@arkade-os/solver-arkade/arkade/lockupFunding.js'

type Locktime = Readonly<{ kind: 'height' | 'time'; value: bigint }>
type VerifiedSwapFill = Parameters<TaxiClient['submitSwapFill']>[0]
type SwapFillGraphWire = Parameters<TaxiClient['submitSwapFill']>[1]

/** Backoff before each re-POST on `not_ready`: the Taxi's runtime check takes seconds, and this settle holds the
 * orchestrator's fill queue while it waits. */
export const CARRIER_NOT_READY_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000]

declare const carrierSnapshot: unique symbol

/** REQUIRED, not optional: the compiler refuses a snapshot that skipped the
 * shared input codec. The symbol has no runtime existence to serialize. */
export type CarrierAttemptSnapshot = JsonObject & { readonly [carrierSnapshot]: true }

/** Methods, not arrow properties: bivariance lets the real store's
 * `snapshot: unknown` satisfy the narrowed parameter above. */
export interface CarrierAttemptStore {
  readCarrierAttempt(id: string): Promise<CarrierAttempt | null>
  prepareCarrierAttempt(id: string, snapshot: CarrierAttemptSnapshot): Promise<boolean>
  bindCarrierAttempt(id: string, expected: CarrierAttempt, binding: JsonObject): Promise<boolean>
  markCarrierAttemptSubmitting(id: string, expected: CarrierAttempt): Promise<boolean>
  refuseNeverSubmittedCarrierAttempt(id: string, expected: CarrierAttempt, reason: string): Promise<boolean>
  refuseUnattemptedCarrierFill(id: string, reason: string): Promise<boolean>
}

export interface CarrierFillRebuildRequest {
  row: AssetRfqSwapRow
  offerHex: string
  inputs: readonly CarrierCoin[]
  proceedsScript: Uint8Array
  /** The three sats the solver AUTHORISED. The rebuild builds with these rather
   * than the quote's, and refuses a quote that priced itself differently. */
  physicalSats: bigint
  contributionSats: bigint
  maxFareSats: bigint
  quotedGraph: SwapFillGraphWire
}

/** `rebuild` must derive the graph from the solver's own inputs and the offer,
 * never from the operator's bytes; `sign` touches only solver-owned inputs. */
export interface CarrierFillSeams {
  rebuild: (request: CarrierFillRebuildRequest) => Promise<JointGraph>
  sign: (expected: JointGraph) => Promise<JointGraph>
}

/** The Taxi one row's fill goes to, and what its attempt records about it. */
export interface CarrierTaxi {
  /** The guard's normalised form for a Taxi the row named; `TAXI_URL` verbatim otherwise. */
  provider: string
  /** Only a Taxi the row named carries one: the key its quote was verified against. */
  providerKey?: string
  swapFills: Pick<TaxiClient, 'requestVerifiedSwapFillQuote' | 'submitSwapFill'>
}

export interface TaxiCarrierSettleDeps {
  store: CarrierAttemptStore
  /** Throws, before anything is pinned, for a Taxi this solver cannot or may not reach. */
  taxiFor: (row: AssetRfqSwapRow) => CarrierTaxi
  resolve: ReceiveCarrierQuotes['resolve']
  coins: () => Promise<readonly CarrierCoin[]>
  reserved: () => ReadonlySet<string>
  reserve: (outpoints: readonly CarrierOutpoint[]) => ReleaseReservation
  pins: CarrierPinLedger
  dustSats: bigint
  offerHex: (row: AssetRfqSwapRow) => string
  proceedsScript: Uint8Array
  solverKeys: readonly string[]
  /** What a solver input's forfeit leaf must be collaborative with — a getter
   * so a signer rotation is live without a restart. */
  serverKey: () => Uint8Array
  fill: CarrierFillSeams
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const contributionOf = (coin: CarrierCoin, leg: AssetLeg, dustSats: bigint): bigint => {
  if (leg === null) return BigInt(Math.max(usableSatsOf(coin, Number(dustSats)), 0))
  return (coin.assets ?? [])
    .filter((held) => held.assetId === leg)
    .reduce((total, held) => total + BigInt(held.amount), 0n)
}

/** A selected coin paired with the evidence that qualified it, so the request
 * builder uses selection's own answer rather than deriving a second one. */
export interface CarrierSelectedInput {
  coin: CarrierCoin
  evidence: CarrierTaprootEvidence
}

/** Ordered by outpoint rather than by value or expiry: the set has to be a
 * function of the inventory alone, so a reconciler re-deriving it after a
 * restart gets the same answer this call got. */
export const selectCarrierInputs = (args: {
  coins: readonly CarrierCoin[]
  reserved: ReadonlySet<string>
  floor: Locktime
  dustSats: bigint
  leg: AssetLeg
  amount: bigint
  solverKeys: readonly string[]
  serverKey: Uint8Array
}): readonly CarrierSelectedInput[] => {
  const eligible = args.coins
    .filter((coin) => !args.reserved.has(outpointKey(coin.txid, coin.vout)))
    .filter((coin) => clearsFloor(coin, args.floor))
    .map((coin) => ({ coin, evidence: carrierTaprootEvidence(coin, args.solverKeys, args.serverKey) }))
    .filter((entry): entry is CarrierSelectedInput => entry.evidence !== undefined)
    .filter((entry) => contributionOf(entry.coin, args.leg, args.dustSats) > 0n)
    .sort((a, b) => outpointKey(a.coin.txid, a.coin.vout).localeCompare(outpointKey(b.coin.txid, b.coin.vout)))
  const picked: CarrierSelectedInput[] = []
  let total = 0n
  for (const entry of eligible) {
    picked.push(entry)
    total += contributionOf(entry.coin, args.leg, args.dustSats)
    if (total >= args.amount) return picked
  }
  throw new Error(`carrier fill inventory holds ${total} of the ${args.amount} it must pay on ${args.leg ?? 'sats'}`)
}

const locktimeJson = (floor: Locktime): JsonObject => ({ kind: floor.kind, value: floor.value.toString() })

const sameLocktime = (a: Locktime, b: Locktime): boolean => a.kind === b.kind && a.value === b.value

const carrierAttemptSnapshotFor = (parts: {
  row: AssetRfqSwapRow
  quoteId: string
  quoteExpiresAt: number
  floor: Locktime
  inputs: readonly CarrierOutpoint[]
  deposit: CarrierOutpoint
  offerHex: string
  taxi: CarrierTaxi
  proceedsScript: Uint8Array
  physicalSats: bigint
  contributionSats: bigint
  maxFareSats: bigint
  validUntil: number
}): CarrierAttemptSnapshot =>
  // The ONE mint of the brand, reachable only through the codec below.
  mintSnapshot({
    ...encodeCarrierAttemptInputs(parts.inputs),
    operation: parts.row.id,
    // A record of which Taxi holds this graph; nothing reads it back yet, and a reader must use it, not config.
    provider: parts.taxi.provider,
    ...(parts.taxi.providerKey === undefined ? {} : { provider_key: parts.taxi.providerKey }),
    offer: parts.offerHex,
    deposit: { txid: parts.deposit.txid, vout: parts.deposit.vout },
    quote: { id: parts.quoteId, expires_at: parts.quoteExpiresAt },
    input_expiry_floor: locktimeJson(parts.floor),
    proceeds_script: hex.encode(parts.proceedsScript),
    physical_sats: parts.physicalSats.toString(),
    contribution_sats: parts.contributionSats.toString(),
    max_fare_sats: parts.maxFareSats.toString(),
    valid_until: parts.validUntil,
  })

const mintSnapshot = (fields: JsonObject): CarrierAttemptSnapshot => fields as unknown as CarrierAttemptSnapshot

/** `offer-covenant` is the provider-signed deposit, which the fill template
 * spells as a null owner. */
const quotedInputOwners = (wire: SwapFillGraphWire): readonly (string | null)[] =>
  wire.inputs.map((input) => (input.owner === 'offer-covenant' ? null : input.owner))

/** An index loop: JSON reads a hole or `undefined` as the covenant's `null`, and `every` skips holes. */
export const sameInputOwners = (a: readonly (string | null)[], b: readonly (string | null)[]): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Only the signed transactions are replaced: every economic field the submit
 * pre-flight compares stays the operator's own bytes. */
const solverGraphWire = (quoted: SwapFillGraphWire, signed: JointGraph): SwapFillGraphWire => ({
  ...quoted,
  arkTx: signed.arkTx,
  checkpoints: [...signed.checkpoints],
})

/** Owner-restricted by construction: the bindings come from the graph the
 * solver built itself, so a relabelled owner cannot steer what gets signed. */
export const carrierFillSigner =
  (identity: Identity) =>
  async (expected: JointGraph): Promise<JointGraph> => {
    const owned = expected.inputOwners.flatMap((owner, inputIndex) => (owner === 'solver' ? [inputIndex] : []))
    if (owned.length === 0) throw new Error('carrier fill assigns no input to this solver')
    return signJointGraphForOwner({
      expected,
      owner: 'solver',
      bindings: owned.map((inputIndex) => ({ inputIndex, identity })),
    })
  }

export const createTaxiReceiveCarrierSettler = (deps: TaxiCarrierSettleDeps): Pick<ReceiveCarrierQuotes, 'settle'> => {
  const settleOnce = async (row: AssetRfqSwapRow): Promise<ReceiveCarrierSettleOutcome> => {
    const terms = row.carrierTerms
    if ((terms?.mode !== 'recycle' && terms?.mode !== 'recycle_receiver') || terms.quoteId === undefined) {
      throw new Error(`asset rfq swap ${row.id} is not a recycle, so it has no carrier fill to settle`)
    }
    if (row.toAssetId === null) throw new Error(`carrier fill ${row.id} pays no asset leg to recycle a carrier for`)
    if (row.depositTxid === null || row.depositVout === null) {
      throw new Error(`carrier fill ${row.id} records no deposit outpoint to spend`)
    }
    if ((await deps.store.readCarrierAttempt(row.id)) !== null) {
      throw new Error(`carrier fill ${row.id} already has an attempt; reconciliation owns it, never a second submit`)
    }
    const taxi = deps.taxiFor(row)

    const request = {
      quoteId: terms.quoteId,
      makerPkScript: row.makerPkScript,
      makerPublicKey: row.makerPublicKey,
      assetId: row.toAssetId,
      now: deps.now(),
      admission: false,
      ...receiveCarrierTaxiOf(terms),
    }
    const floor = (await deps.resolve(request)).inputExpiryFloor
    const coins = await deps.coins()
    const serverKey = deps.serverKey()
    const inputs = selectCarrierInputs({
      coins,
      reserved: deps.reserved(),
      floor,
      dustSats: deps.dustSats,
      leg: row.toAssetId,
      amount: row.toAmount,
      solverKeys: deps.solverKeys,
      serverKey,
    })

    const outpoints = inputs.map(({ coin }) => ({ txid: coin.txid, vout: coin.vout }))
    const deposit = { txid: row.depositTxid, vout: row.depositVout }
    const validUntil = Math.min(row.validUntil, terms.expiresAt)
    const offerHex = deps.offerHex(row)
    const snapshot = carrierAttemptSnapshotFor({
      row,
      quoteId: terms.quoteId,
      quoteExpiresAt: terms.expiresAt,
      floor,
      inputs: outpoints,
      deposit,
      offerHex,
      taxi,
      proceedsScript: deps.proceedsScript,
      physicalSats: terms.physicalSats,
      contributionSats: terms.loanSats,
      maxFareSats: terms.serviceFareSats,
      validUntil,
    })

    // Still before the write that names them, and after the last refusal that
    // would leave no attempt for reconciliation to release this pin from.
    // Everything between is synchronous, so nothing can interleave here.
    const pin = deps.pins.adopt(row.id, deps.reserve(outpoints))

    const prepared: CarrierAttempt = { phase: 'prepared', snapshot }
    let wrote = false
    let liable = false
    try {
      wrote = true
      if (!(await deps.store.prepareCarrierAttempt(row.id, snapshot))) {
        // The CAS LOST: the attempt is not this caller's to end, and only
        // the pin above is its to free.
        wrote = false
        pin.release()
        throw new Error(`carrier fill ${row.id} could not prepare its attempt; the operator was asked nothing`)
      }
      const { verified } = await taxi.swapFills.requestVerifiedSwapFillQuote({
        operationId: row.id,
        receiveQuoteId: terms.quoteId,
        offerHex,
        solverInputs: inputs.map(({ coin, evidence }) => ({
          txid: coin.txid,
          vout: coin.vout,
          value: BigInt(coin.value),
          tapTree: evidence.tapTree,
          spendLeaf: evidence.spendLeaf,
          // EVERY asset the coin owns: arkd refuses a spend whose packet omits
          // one an input carries.
          assets: (coin.assets ?? []).map((held) => ({
            assetId: assetIdValue(held.assetId),
            amount: BigInt(held.amount),
          })),
        })),
        solverProceedsScript: deps.proceedsScript,
        solverKeys: [...deps.solverKeys],
        contributionSats: terms.loanSats,
        maxFare: { currency: 'sats', units: terms.serviceFareSats },
        fundingTxid: deposit.txid,
        fundingVout: deposit.vout,
        // PINNED: it participates in request identity, so a recomputed value
        // is a conflict rather than the same request.
        validUntil,
        now: deps.now(),
      })

      const quoted = verified.quote.graph
      const expected = await deps.fill.rebuild({
        row,
        offerHex,
        inputs: inputs.map(({ coin }) => coin),
        proceedsScript: deps.proceedsScript,
        physicalSats: terms.physicalSats,
        contributionSats: terms.loanSats,
        maxFareSats: terms.serviceFareSats,
        quotedGraph: quoted,
      })
      if (!verifyOfferFillPlan(expected)) throw new Error(`carrier fill ${row.id} rebuilt a graph off its own template`)
      if (!sameInputOwners(expected.inputOwners, quotedInputOwners(quoted))) {
        throw new Error(`carrier fill ${row.id} was quoted input owners it did not build`)
      }
      // The digest binds bytes, owners and template together: an equal one is
      // the whole graph re-derived, not a field-by-field echo.
      if (expected.graphId !== quoted.graphId) {
        throw new Error(`carrier fill ${row.id} rebuilt ${expected.graphId}, not the quoted ${quoted.graphId}`)
      }

      const binding: JsonObject = {
        fill_id: verified.fillId,
        expires_at: verified.expiresAt,
        graph: {
          id: expected.graphId,
          ark_tx: expected.arkTx,
          checkpoints: [...expected.checkpoints],
          // Carried because the digest commits to them: without the owners
          // reconciliation cannot re-hash the bytes it is handed.
          input_owners: [...expected.inputOwners],
        },
      }
      if (!(await deps.store.bindCarrierAttempt(row.id, prepared, binding))) {
        throw new Error(`carrier fill ${row.id} could not bind its graph; nothing has been signed`)
      }

      const signed = await deps.fill.sign(expected)

      // The last gate: the authority this attempt was admitted under must
      // still be the one the operator serves, now bound to this fill.
      const current = await deps.resolve({ ...request, now: deps.now(), boundFillId: verified.fillId })
      if (!sameLocktime(current.inputExpiryFloor, floor)) {
        throw new Error(
          `carrier fill ${row.id} pinned an input expiry floor of ${floor.value} and the operator now serves ${current.inputExpiryFloor.value}`,
        )
      }
      // The coin AS IT IS NOW: re-testing the object selected before the
      // boundary could not fail, whatever had changed.
      const live = new Map((await deps.coins()).map((coin) => [outpointKey(coin.txid, coin.vout), coin]))
      for (const { coin } of inputs) {
        const fresh = live.get(outpointKey(coin.txid, coin.vout))
        if (fresh === undefined) throw new Error(`carrier fill ${row.id} no longer holds ${coin.txid}:${coin.vout}`)
        if (!clearsFloor(fresh, floor)) {
          throw new Error(`carrier fill ${row.id} input ${coin.txid}:${coin.vout} no longer clears its floor`)
        }
      }

      const bound: CarrierAttempt = { phase: 'quoted', snapshot, binding }
      if (!(await deps.store.markCarrierAttemptSubmitting(row.id, bound))) {
        throw new Error(`carrier fill ${row.id} could not mark itself submitting; nothing has been sent`)
      }
      liable = true
      await submitWhileNotReady(deps, taxi, verified, solverGraphWire(quoted, signed))
    } catch (error) {
      if (wrote && !liable) await releaseIfProvenNeverSubmitted(deps, pin, messageOf(error))
      throw error
    }
    return { status: 'submitted' }
  }
  return {
    settle: async (row) => {
      try {
        return await settleOnce(row)
      } catch (error) {
        // Refuses only a row still holding no attempt; one this cannot write is left to reconciliation's own.
        await deps.store.refuseUnattemptedCarrierFill(row.id, `not filled: ${messageOf(error)}`).catch(() => false)
        throw error
      }
    },
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Runs past `submitting`, so no exit here releases. The Taxi already holds the signatures, and a named one is
 * untrusted: its `not_ready` is no proof it will never submit, so the SAME bytes are re-sent, never rebuilt. */
const submitWhileNotReady = async (
  deps: Pick<TaxiCarrierSettleDeps, 'now' | 'sleep'>,
  taxi: CarrierTaxi,
  verified: VerifiedSwapFill,
  graph: SwapFillGraphWire,
): Promise<void> => {
  for (const delay of [...CARRIER_NOT_READY_RETRY_MS, undefined]) {
    try {
      await taxi.swapFills.submitSwapFill(verified, graph)
      return
    } catch (error) {
      if (!(error instanceof TaxiError && error.code === 'not_ready') || delay === undefined) throw error
      if (deps.now() + Math.ceil(delay / 1000) >= verified.expiresAt) throw error
      await deps.sleep(delay)
      if (deps.now() >= verified.expiresAt) throw error
    }
  }
}

/** Routed on the DURABLE phase, never on what this call believes it did: a
 * checkpoint write that threw may still have landed, and the row is the only
 * thing that knows. */
const releaseIfProvenNeverSubmitted = async (
  deps: TaxiCarrierSettleDeps,
  pin: CarrierPin,
  reason: string,
): Promise<void> => {
  const current = await deps.store.readCarrierAttempt(pin.id)
  // No attempt means the write that precedes the first POST never landed.
  if (current === null) return pin.release()
  // `not_submitted` is somebody's WON terminal CAS, and that CAS refuses any
  // prior phase but `prepared`/`quoted` — so it is durable proof this row never
  // submitted. The winner freed its own pin; this one is the loser's, over
  // coins nothing spent, and no later caller can ever reach it: the row is
  // `refused`, which reconciliation never visits.
  if (current.phase === 'not_submitted') return pin.release()
  // Anything past `quoted` may have been submitted, and keeps its pin for good.
  if (current.phase !== 'prepared' && current.phase !== 'quoted') return
  // Only the caller that WINS the terminal CAS may release, and only its own.
  if (await deps.store.refuseNeverSubmittedCarrierAttempt(pin.id, current, `not filled: ${reason}`)) {
    pin.release()
  }
}
