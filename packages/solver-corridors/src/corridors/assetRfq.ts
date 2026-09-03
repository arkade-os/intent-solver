/**
 * `arkade:<X>->arkade:<Y>` as a first-class `Corridor` — one per served market
 * per direction.
 *
 * Thin, the same call the four built-in adapters make: the money path lives in
 * `asset/assetRfqOrchestrator.ts` and is not touched here. This only wraps it so
 * the registry-driven hosts — RFQ ingress, the sweep loop, the admin console —
 * reach it like any other corridor.
 *
 * A CORRIDOR PER DIRECTION, like the EVM family and unlike the four built-ins.
 * The pair carries the asset id, so the registry key is per market per
 * direction and so is the env stem (`ASSET_USDA_BUY`). A market with a
 * direction disabled (`max: 0n`) still registers and refuses by amount, which
 * is the honest answer — the pair IS served, at no size.
 *
 * WHAT THIS CORRIDOR DOES NOT HAVE, each stated rather than silently omitted,
 * because `Corridor`'s contract says an absent capability is a documented
 * degradation:
 *
 * - No `refundSweep` and no `refundNow`. § 7.2's refund is `cancel`, a 2-of-2
 *   of the FUNDER and the Arkade Service. This solver holds neither key, so
 *   there is no refund it could push on a client's behalf — the client
 *   withdraws its own unfilled deposit whenever it likes. An operator button
 *   here would be one that cannot work.
 * - No `claimNow`. There is no claim: `fulfill` pays the client and takes the
 *   deposit in one transaction, so the only forced action worth having is
 *   `park`, which every corridor has.
 * - No `tickHot`. Latency here is dominated by waiting for a client deposit,
 *   which the ordinary sweep observes.
 * - No `liveLockups`/`lockupFor`. Those report ARKADE LOCKUPS OF OURS that the
 *   settlement layer must register for renewal and recovery, and this corridor
 *   funds none: the covenant holding money is the CLIENT's offer deposit, and
 *   it is the client's contract manager that watches it. Absence here means
 *   "no such lockup of mine", which is the truth, rather than "skip me".
 */

import { parkVia, type Corridor, type CorridorReader } from '@arkade-os/solver-core/core/corridor.js'
import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import { diagnose, phaseOfStates, type AdminSwap } from '@arkade-os/solver-core/core/swapView.js'
import type { CorridorRfqOutcome as RfqOutcome } from '@arkade-os/solver-core/core/corridor.js'
import { extractRfqId, zodDetail } from '@arkade-os/solver-core/core/rfqProtocol.js'
import { rfqRefusalPayload } from '../wire/payloads.js'
import {
  AssetRfqRequest,
  assetRfqPairFor,
  assetRfqQuotePayload,
  assetRfqStatusPayload,
} from '../wire/assetRfqPayloads.js'
import {
  EXPOSED,
  NON_TERMINAL,
  type AssetRfqSwapRow,
  type AssetRfqSwapState,
  type AssetRfqSwapStore,
} from '../db/assetRfqSwaps.js'
import type { AssetRfqMarket, AssetRfqSwapService } from '../asset/assetRfqOrchestrator.js'

/** Which way round a market is being served. */
export type AssetRfqDirection = 'sell_base' | 'buy_base'

/**
 * The env stem for one market and direction.
 *
 * Built from the market's SYMBOL rather than its asset id, for the reason the
 * EVM family gives: an env stem must be a legal shell identifier, and a 68-hex
 * asset id makes `ASSET_<68 chars>_BUY` — technically legal and unusable. The
 * symbol is operator-facing config, so a collision between two markets is an
 * operator's own naming and the registry refuses it at composition time.
 */
export const assetRfqEnvStem = (market: { symbol: string }, direction: AssetRfqDirection): string =>
  `ASSET_${market.symbol.toUpperCase()}_${direction === 'sell_base' ? 'BUY' : 'SELL'}`

/**
 * The legs of a market in one direction: what the client gives and gets.
 *
 * `sell_base` is the client GIVING base — the naming is the maker's side, kept
 * identical to `assetOfferPrice.ts`'s `OfferDirection` so the two paths do not
 * describe one direction with two words.
 */
export const assetRfqLegs = (
  market: Pick<AssetRfqMarket, 'base' | 'quote'>,
  direction: AssetRfqDirection,
): { from: string | null; to: string | null } =>
  direction === 'sell_base' ? { from: market.base, to: market.quote } : { from: market.quote, to: market.base }

export const assetRfqDescriptor = (
  market: Pick<AssetRfqMarket, 'base' | 'quote' | 'symbol'>,
  direction: AssetRfqDirection,
): CorridorDescriptor<AssetRfqSwapState> => {
  const legs = assetRfqLegs(market, direction)
  return {
    pair: assetRfqPairFor(legs.from, legs.to),
    envStem: assetRfqEnvStem(market, direction),
    // Both legs are Arkade, so the payout always comes out of the Arkade float
    // — whether it is paid in sats or in an asset.
    payoutRail: 'arkade',
    states: {
      live: NON_TERMINAL,
      exposed: EXPOSED,
      // `filled` and nothing else. `refused` covers both a declined quote and
      // one that lapsed — neither delivered anything, and neither left this
      // solver out of pocket.
      delivered: ['filled'],
    },
  }
}

const STATES_ONLY = {
  states: { live: NON_TERMINAL, exposed: EXPOSED, delivered: ['filled' as const] },
}

/**
 * One row for the console.
 *
 * `amountSats`/`payoutSats` are the console's own vocabulary and are SATS by
 * contract, so they carry a leg only when that leg really is sats. On the other
 * direction they are null rather than an asset amount rendered as if it were
 * sats — a number labelled sats that is actually 10^18 units of a stablecoin is
 * worse than no number.
 */
export const projectAssetRfq = (row: AssetRfqSwapRow): AdminSwap => ({
  ...diagnose(row.state, row.failureReason),
  id: row.id,
  corridor: row.pair,
  state: row.state,
  phase: phaseOfStates(STATES_ONLY.states, row.state),
  amountSats: row.fromAssetId === null ? Number(row.fromAmount) : 0,
  payoutSats: row.toAssetId === null ? Number(row.toAmount) : null,
  // No hash lock anywhere in this class, so there is no payment hash to show.
  paymentHash: null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  failureReason: row.failureReason,
})

export const assetRfqReader = (descriptor: CorridorDescriptor, store: AssetRfqSwapStore): CorridorReader => ({
  descriptor,
  statusFor: async (rfqId) => {
    const row = await store.findByRfqId(rfqId)
    // Only OUR rows, and null for anything else: a refusal here would end the
    // host's fall-through and hide a live swap belonging to the next corridor.
    // A row is ours only if its pair is the one this corridor serves — one
    // store backs every asset market, so the id alone does not decide it.
    return row && row.pair === descriptor.pair ? assetRfqStatusPayload(row, rfqId) : null
  },
  findRecoverable: async () =>
    (await store.findRecoverable())
      .filter((row) => row.pair === descriptor.pair)
      // The script worth watching is the CLIENT's offer deposit — the only
      // contract in this corridor that holds money.
      .map((row) => ({ id: row.id, pkScript: row.offerPkScript })),
  committedSats: () => store.committedSats(),
  page: async (options) => {
    const { rows, nextCursor } = await store.page(options)
    return { swaps: rows.filter((row) => row.pair === descriptor.pair).map(projectAssetRfq), nextCursor }
  },
  detail: async (id) => {
    try {
      const raw = await store.get(id)
      if (raw.pair !== descriptor.pair) return null
      return { raw, swap: projectAssetRfq(raw), history: await store.history(id) }
    } catch {
      return null
    }
  },
  close: () => store.close(),
})

/** Where a parked row lands — this corridor's own two terminal words. */
const ASSET_RFQ_PARKED: readonly AssetRfqSwapState[] = ['stuck', 'refused']

export const assetRfqCorridor = (
  descriptor: CorridorDescriptor,
  service: AssetRfqSwapService,
  store: AssetRfqSwapStore,
): Corridor => ({
  ...assetRfqReader(descriptor, store),
  quote: (payload) => respondToAssetRfqRequest(service, descriptor.pair, payload),
  tick: (id) => service.tick(id),
  tickAll: async () => (await service.tickAll()).length,
  park: (id, reason) => parkVia(store, { live: NON_TERMINAL, parked: ASSET_RFQ_PARKED }, id, reason),
})

/**
 * This corridor's own RFQ arm: validate against ITS schema, then quote or
 * refuse.
 *
 * The refusal vocabulary stays the closed RFQ set — `rfqRefusalPayload` maps
 * every internal reason through `toRfqReason`, and the host checks it again on
 * the way out precisely because a corridor is third-party code from where it
 * sits.
 */
export const respondToAssetRfqRequest = async (
  service: AssetRfqSwapService,
  servedPair: string,
  payload: unknown,
): Promise<RfqOutcome> => {
  const parsed = AssetRfqRequest.safeParse(payload)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(extractRfqId(payload), 'unsupported_payload'),
      detail: `asset rfq_request schema: ${zodDetail(parsed.error)}`,
    }
  }
  const request = parsed.data

  // Byte-for-byte against the pair THIS corridor serves. § 2 is explicit that
  // asset ids are compared without normalisation, so a differently-spelled pair
  // that reached the right corridor is still refused rather than served.
  if (request.pair !== servedPair) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(request.rfq_id, 'unsupported_pair'),
      detail: `pair '${request.pair}' reached the corridor serving '${servedPair}'`,
    }
  }

  const outcome = await service.quote({
    rfqId: request.rfq_id,
    pair: request.pair,
    amount: request.amount,
    amountSide: request.amount_side,
    makerPkScript: request.profile.maker_pk_script,
    makerPublicKey: request.profile.maker_public_key,
  })
  if (outcome.accepted) {
    return { kind: 'quote', payload: assetRfqQuotePayload(outcome.swap, request.rfq_id) }
  }
  return {
    kind: 'refused',
    payload: rfqRefusalPayload(request.rfq_id, outcome.reason),
    detail: outcome.detail ? `${outcome.reason}: ${outcome.detail}` : outcome.reason,
  }
}
