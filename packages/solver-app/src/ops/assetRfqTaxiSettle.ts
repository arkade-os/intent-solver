/** Persist before external effects; CAS against this caller's envelope and settle only on chain evidence. */

import { hex } from '@scure/base'
import { signJointGraphForOwner, type TaxiClient, type VerifiedReceiveQuote } from '@arkade-taxi/client'
import type { Identity } from '@arkade-os/sdk'
import { OFFER_FILL_TEMPLATE, verifyOfferFillPlan, type JointGraph } from '@arkade-os/swap'
import type { ReleaseReservation } from '@arkade-os/solver-arkade/arkade/reservations.js'
import type { AssetLeg } from '@arkade-os/solver-core/core/assetRfq.js'
import { messageOf } from '@arkade-os/solver-core/util/poll.js'
import type { AssetRfqSwapRow } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import type { CarrierAttempt, JsonObject } from '@arkade-os/solver-corridors/db/carrierAttempt.js'
import {
  CARRIER_FILL_MARGIN_SECONDS,
  receiveCarrierTaxiOf,
  type ReceiveCarrierQuotes,
  type ReceiveCarrierSettleOutcome,
} from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import {
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
type FillRequest = Parameters<TaxiClient['submitFill']>[0]

export interface CarrierAttemptStore {
  readCarrierAttempt(id: string): Promise<CarrierAttempt | null>
  prepareCarrierAttempt(id: string, snapshot: JsonObject): Promise<boolean>
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
  /** Rebuild from authorised economics and reject differently priced quotes. */
  physicalSats: bigint
  contributionSats: bigint
  maxFareSats: bigint
  quote: VerifiedReceiveQuote
}

/** Derive the graph locally and sign only solver-owned inputs. */
export interface CarrierFillSeams {
  rebuild: (request: CarrierFillRebuildRequest) => Promise<JointGraph>
  sign: (expected: JointGraph) => Promise<JointGraph>
}

export interface CarrierTaxi {
  /** The guard's normalised form for a Taxi the row named; `TAXI_URL` verbatim otherwise. */
  provider: string
  /** Only a Taxi the row named carries one: the key its quote was verified against. */
  providerKey?: string
  fills: Pick<TaxiClient, 'submitFill'>
}

export interface TaxiCarrierSettleDeps {
  store: CarrierAttemptStore
  taxiFor: (row: AssetRfqSwapRow) => CarrierTaxi
  resolve: ReceiveCarrierQuotes['resolve']
  receiveQuote: (request: Parameters<ReceiveCarrierQuotes['resolve']>[0]) => Promise<VerifiedReceiveQuote>
  coins: () => Promise<readonly CarrierCoin[]>
  reserved: () => ReadonlySet<string>
  reserve: (outpoints: readonly CarrierOutpoint[]) => ReleaseReservation
  pins: CarrierPinLedger
  dustSats: bigint
  offerHex: (row: AssetRfqSwapRow) => string
  proceedsScript: Uint8Array
  solverKeys: readonly string[]
  /** Resolve collaborative signer keys on demand so rotations take effect. */
  serverKey: () => Uint8Array
  fill: CarrierFillSeams
  now: () => number
}

const contributionOf = (coin: CarrierCoin, leg: AssetLeg, dustSats: bigint): bigint => {
  if (leg === null) return BigInt(Math.max(usableSatsOf(coin, Number(dustSats)), 0))
  return (coin.assets ?? [])
    .filter((held) => held.assetId === leg)
    .reduce((total, held) => total + BigInt(held.amount), 0n)
}

export interface CarrierSelectedInput {
  coin: CarrierCoin
  evidence: CarrierTaprootEvidence
}

/** Sort by outpoint so reconciliation reproduces selection after a restart. */
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
}): JsonObject => ({
  ...encodeCarrierAttemptInputs(parts.inputs),
  operation: parts.row.id,
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

/** Signer bindings come from the locally built graph, preventing owner relabelling. */
export const carrierFillSigner =
  (identity: Identity) =>
  async (expected: JointGraph): Promise<JointGraph> => {
    const owned = expected.inputOwners.flatMap((owner, inputIndex) => (owner === 'solver' ? [inputIndex] : []))
    if (owned.length === 0) throw new Error('carrier fill assigns no input to this solver')
    return signJointGraphForOwner({
      expected,
      owner: 'solver',
      template: OFFER_FILL_TEMPLATE,
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
    const quote = await deps.receiveQuote(request)
    const floor = { kind: quote.quote.inputExpiryFloor.kind, value: BigInt(quote.quote.inputExpiryFloor.value) }
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
    // Not `row.validUntil`: that bounds the decision to fill, and the quote stopped short of this to leave time to
    // act. Adding that margin back bounds a Taxi whose own expiry runs past the window this row was quoted for.
    const validUntil = Math.min(
      terms.expiresAt,
      quote.descriptor.expiresAt,
      row.validUntil + CARRIER_FILL_MARGIN_SECONDS,
    )
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

    // Pin after synchronous refusals but before the durable input write.
    const pin = deps.pins.adopt(row.id, deps.reserve(outpoints))

    const prepared: CarrierAttempt = { phase: 'prepared', snapshot }
    let wrote = false
    let liable = false
    try {
      wrote = true
      if (!(await deps.store.prepareCarrierAttempt(row.id, snapshot))) {
        // Losing the prepare CAS releases only this caller's pin.
        wrote = false
        pin.release()
        throw new Error(`carrier fill ${row.id} could not prepare its attempt; the operator was asked nothing`)
      }
      const expected = await deps.fill.rebuild({
        row,
        offerHex,
        inputs: inputs.map(({ coin }) => coin),
        proceedsScript: deps.proceedsScript,
        physicalSats: terms.physicalSats,
        contributionSats: terms.loanSats,
        maxFareSats: terms.serviceFareSats,
        quote,
      })
      if (!verifyOfferFillPlan(expected)) throw new Error(`carrier fill ${row.id} rebuilt a graph off its own template`)

      const binding: JsonObject = {
        operation_id: row.id,
        quote_id: terms.quoteId,
        expires_at: validUntil,
        graph: {
          id: expected.graphId,
          ark_tx: expected.arkTx,
          checkpoints: [...expected.checkpoints],
          input_owners: [...expected.inputOwners],
        },
      }
      if (!(await deps.store.bindCarrierAttempt(row.id, prepared, binding))) {
        throw new Error(`carrier fill ${row.id} could not bind its graph; nothing has been signed`)
      }

      const signed = await deps.fill.sign(expected)

      // Recheck the admitted operator authority after signing.
      const current = await deps.resolve({ ...request, now: deps.now() })
      if (!sameLocktime(current.inputExpiryFloor, floor)) {
        throw new Error(
          `carrier fill ${row.id} pinned an input expiry floor of ${floor.value} and the operator now serves ${current.inputExpiryFloor.value}`,
        )
      }
      // Recheck current coin state, not the pre-boundary selection.
      const live = new Map((await deps.coins()).map((coin) => [outpointKey(coin.txid, coin.vout), coin]))
      for (const { coin } of inputs) {
        const fresh = live.get(outpointKey(coin.txid, coin.vout))
        if (fresh === undefined) throw new Error(`carrier fill ${row.id} no longer holds ${coin.txid}:${coin.vout}`)
        if (!clearsFloor(fresh, floor)) {
          throw new Error(`carrier fill ${row.id} input ${coin.txid}:${coin.vout} no longer clears its floor`)
        }
      }

      // The Taxi refuses an expired fill at submit, and by then this attempt would be liable.
      if (deps.now() >= validUntil) {
        throw new Error(`carrier fill ${row.id} expired before it was sent, at ${validUntil}`)
      }
      const bound: CarrierAttempt = { phase: 'quoted', snapshot, binding }
      if (!(await deps.store.markCarrierAttemptSubmitting(row.id, bound))) {
        throw new Error(`carrier fill ${row.id} could not mark itself submitting; nothing has been sent`)
      }
      const submission: FillRequest = {
        operationId: row.id,
        quoteId: terms.quoteId,
        arkTx: signed.arkTx,
        checkpoints: [...signed.checkpoints],
        taxiInputIndexes: expected.inputOwners.flatMap((owner, index) => (owner === 'sponsor' ? [index] : [])),
        covenantOutputIndex: 0,
        assetUnits: row.toAmount,
        validUntil,
      }
      liable = true
      await taxi.fills.submitFill(submission)
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
        await deps.store.refuseUnattemptedCarrierFill(row.id, `not filled: ${messageOf(error)}`).catch(() => false)
        throw error
      }
    },
  }
}

/** Read durable phase: a failed checkpoint write may still have landed. */
const releaseIfProvenNeverSubmitted = async (
  deps: TaxiCarrierSettleDeps,
  pin: CarrierPin,
  reason: string,
): Promise<void> => {
  const current = await deps.store.readCarrierAttempt(pin.id)
  // No attempt means the write that precedes the first POST never landed.
  if (current === null) return pin.release()
  // not_submitted is durable proof of a terminal CAS from prepared or quoted.
  if (current.phase === 'not_submitted') return pin.release()
  // Anything past `quoted` may have been submitted, and keeps its pin for good.
  if (current.phase !== 'prepared' && current.phase !== 'quoted') return
  // Only the caller that WINS the terminal CAS may release, and only its own.
  if (await deps.store.refuseNeverSubmittedCarrierAttempt(pin.id, current, `not filled: ${reason}`)) {
    pin.release()
  }
}
