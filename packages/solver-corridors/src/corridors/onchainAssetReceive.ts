/**
 * `onchain:BTC->arkade:<asset>` as a first-class `Corridor` — one per served
 * asset.
 *
 * A CORRIDOR PER MARKET, like the EVM family and unlike the four built-ins: the
 * pair carries the asset id, so the registry key and the env stem are per
 * market and the set is not known until runtime.
 *
 * IT REPORTS ITS LOCKUPS, unlike `corridors/assetRfq.ts`. That corridor has no
 * `liveLockups` because the covenant holding money there is the CLIENT's
 * deposit. Here the solver funds the lockup out of its own float, so those are
 * lockups OF OURS — the settlement layer has to register them for renewal, and
 * a corridor that stayed silent would leave its own asset unrenewable and
 * invisible to recovery.
 */

import { parkVia, type Corridor, type CorridorReader } from '@arkade-os/solver-core/core/corridor.js'
import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import { diagnose, phaseOfStates, type AdminSwap } from '@arkade-os/solver-core/core/swapView.js'
import type { CorridorRfqOutcome as RfqOutcome } from '@arkade-os/solver-core/core/corridor.js'
import { extractRfqId, zodDetail } from '@arkade-os/solver-core/core/rfqProtocol.js'
import {
  onchainAssetReceivePairFor,
  type OnchainAssetMarket,
} from '@arkade-os/solver-core/core/onchainAssetReceive.js'
import { rfqRefusalPayload } from '../wire/payloads.js'
import {
  OnchainAssetReceiveRfqRequest,
  onchainAssetReceiveRfqQuotePayload,
  onchainAssetReceiveRfqStatusPayload,
} from '../wire/onchainAssetReceivePayloads.js'
import {
  EXPOSED,
  NON_TERMINAL,
  type OnchainAssetReceiveSwapRow,
  type OnchainAssetReceiveState,
  type OnchainAssetReceiveSwapStore,
} from '../db/onchainAssetReceiveSwaps.js'
import {
  assetReceiveCovenantRowFor,
  type OnchainAssetReceiveSwapService,
} from '../receive/onchainAssetOrchestrator.js'

/**
 * The env stem for one market.
 *
 * Built from the SYMBOL rather than the asset id, for the reason the asset RFQ
 * family gives: a stem must be a legal shell identifier, and
 * `ONCHAIN_ASSET_<68 chars>` is technically legal and unusable. A collision
 * between two symbols is an operator's own naming, and the registry refuses it
 * at composition time.
 */
export const onchainAssetReceiveEnvStem = (market: Pick<OnchainAssetMarket, 'symbol'>): string =>
  `ONCHAIN_ASSET_${market.symbol.toUpperCase()}`

export const onchainAssetReceiveDescriptor = (
  market: Pick<OnchainAssetMarket, 'symbol' | 'assetId'>,
): CorridorDescriptor<OnchainAssetReceiveState> => ({
  pair: onchainAssetReceivePairFor(market.assetId),
  envStem: onchainAssetReceiveEnvStem(market),
  // The payout is an Arkade lockup, so the Arkade float funds it — whether the
  // lockup is denominated in sats or in an asset.
  payoutRail: 'arkade',
  states: {
    live: NON_TERMINAL,
    exposed: EXPOSED,
    delivered: ['settled'],
  },
})

const STATES = { live: NON_TERMINAL, exposed: EXPOSED, delivered: ['settled' as const] }

/**
 * One row for the console.
 *
 * `payoutSats` is null rather than the asset amount: the console's vocabulary is
 * SATS by contract, and a number labelled sats that is actually atomic units of
 * an 18-decimal asset is worse than no number. `amountSats` IS sats here — it is
 * the BTC the client funds the HTLC with — so it carries.
 */
export const projectOnchainAssetReceive = (row: OnchainAssetReceiveSwapRow): AdminSwap => ({
  ...diagnose(row.state, row.failureReason),
  id: row.id,
  corridor: row.pair,
  state: row.state,
  phase: phaseOfStates(STATES, row.state),
  amountSats: row.amountSats,
  payoutSats: null,
  paymentHash: row.paymentHash,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  failureReason: row.failureReason,
})

/**
 * One store backs every market, so every read filters on the served pair —
 * the same discipline `assetRfqReader` applies. Returning another market's row
 * would end the host's fall-through and hide a live swap.
 */
export const onchainAssetReceiveReader = (
  descriptor: CorridorDescriptor,
  store: OnchainAssetReceiveSwapStore,
): CorridorReader => ({
  descriptor,
  liveLockups: async () =>
    (await store.findRecoverable()).filter((row) => row.pair === descriptor.pair).map(assetReceiveCovenantRowFor),
  lockupFor: async (id) => {
    const row = await store.get(id).catch(() => null)
    if (!row || row.pair !== descriptor.pair) return null
    return { lockup: assetReceiveCovenantRowFor(row), preimage: row.preimage }
  },
  statusFor: async (rfqId) => {
    const row = await store.findByRfqId(rfqId)
    return row && row.pair === descriptor.pair ? onchainAssetReceiveRfqStatusPayload(row, rfqId) : null
  },
  findRecoverable: async () => (await store.findRecoverable()).filter((row) => row.pair === descriptor.pair),
  committedSats: () => store.committedSats(),
  page: async (options) => {
    const { rows, nextCursor } = await store.page(options)
    return { swaps: rows.filter((row) => row.pair === descriptor.pair).map(projectOnchainAssetReceive), nextCursor }
  },
  detail: async (id) => {
    try {
      const raw = await store.get(id)
      if (raw.pair !== descriptor.pair) return null
      return { raw, swap: projectOnchainAssetReceive(raw), history: await store.history(id) }
    } catch {
      return null
    }
  },
  close: () => store.close(),
})

const PARKED: readonly OnchainAssetReceiveState[] = ['stuck', 'refused']

export const onchainAssetReceiveCorridor = (
  descriptor: CorridorDescriptor,
  service: OnchainAssetReceiveSwapService,
  store: OnchainAssetReceiveSwapStore,
): Corridor => ({
  ...onchainAssetReceiveReader(descriptor, store),
  quote: (payload) => respondToOnchainAssetReceiveRfqRequest(service, descriptor.pair, payload),
  tick: async (id) => {
    await service.tick(id)
  },
  tickAll: async () => (await service.tickAll()).length,
  park: (id, reason) => parkVia(store, { live: NON_TERMINAL, parked: PARKED }, id, reason),
  claimNow: (id) => service.claimNow(id),
  refundNow: (id) => service.refundNow(id),
})

export const respondToOnchainAssetReceiveRfqRequest = async (
  service: OnchainAssetReceiveSwapService,
  servedPair: string,
  payload: unknown,
): Promise<RfqOutcome> => {
  const parsed = OnchainAssetReceiveRfqRequest.safeParse(payload)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(extractRfqId(payload), 'unsupported_payload'),
      detail: `onchain asset rfq_request schema: ${zodDetail(parsed.error)}`,
    }
  }
  const request = parsed.data
  // Byte for byte against the pair THIS corridor serves. § 2 compares asset ids
  // without normalisation, so a differently-spelled pair that reached the right
  // corridor is still refused rather than served.
  if (request.pair !== servedPair) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(request.rfq_id, 'unsupported_pair'),
      detail: `pair '${request.pair}' reached the corridor serving '${servedPair}'`,
    }
  }

  const outcome = await service.quote({
    pair: request.pair,
    paymentHash: request.profile.payment_hash,
    amountSats: request.amount,
    claimPacket: request.profile.claim_packet,
    refundPubkey: request.profile.refund_pubkey,
    payoutAddress: request.profile.payout_address,
    payoutPubkey: request.profile.payout_pubkey,
    rfqId: request.rfq_id,
  })
  if (outcome.accepted) {
    return {
      kind: 'quote',
      payload: onchainAssetReceiveRfqQuotePayload(outcome.swap, outcome.lockupDeadline, request.rfq_id),
    }
  }
  return {
    kind: 'refused',
    payload: rfqRefusalPayload(request.rfq_id, outcome.reason),
    detail: outcome.detail ? `${outcome.reason}: ${outcome.detail}` : outcome.reason,
  }
}
