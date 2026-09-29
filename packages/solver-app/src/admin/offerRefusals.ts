/**
 * A bounded, in-memory tail of offers this solver DECLINED.
 *
 * Refusals are persisted nowhere and must not be: `ops/assetOffers.ts`'s
 * `refuse()` writes no row because `consumeOfferTxs` reads a PUBLIC relay, so a
 * row per refusal would let anyone grow the operator's database. Same shape and
 * same reason as `admin/bids.ts`, `ephemeral` included: an empty list after a
 * restart means "nothing recorded since boot", NOT "nothing was refused".
 */

import type { OfferFillRefusal } from '@arkade-os/solver-core/core/assetOffer.js'

export interface RecordedOfferRefusal {
  /** Unix seconds this solver declined. */
  at: number
  /** The funded offer output declined, `txid:vout`. */
  outpoint: string
  reason: OfferFillRefusal
  /** The bounds in force and which source set them, when a bound is what refused. */
  detail: string
}

export const OFFER_REFUSAL_TAIL_CAPACITY = 200

/** Newest first and bounded; `recent()` hands back copies, so a caller cannot reshape the shared buffer. */
export const createTail = <T extends object>(capacity: number) => {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('refusal capacity must be positive')
  const entries: T[] = []
  return {
    record: (entry: T): void => {
      entries.unshift(entry)
      if (entries.length > capacity) entries.length = capacity
    },
    recent: () => ({ entries: entries.map((entry) => ({ ...entry })), ephemeral: true as const, capacity }),
  }
}

export const createOfferRefusalTail = (capacity = OFFER_REFUSAL_TAIL_CAPACITY) =>
  createTail<RecordedOfferRefusal>(capacity)

export type OfferRefusalRecorder = ReturnType<typeof createOfferRefusalTail>
