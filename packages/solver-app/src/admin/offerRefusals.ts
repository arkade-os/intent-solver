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

export interface OfferRefusalTail {
  entries: RecordedOfferRefusal[]
  /** Always true. Present so the UI can say so rather than implying an empty list is meaningful. */
  ephemeral: true
  /** How many refusals the buffer holds before the oldest is dropped. */
  capacity: number
}

export const OFFER_REFUSAL_TAIL_CAPACITY = 200

export interface OfferRefusalRecorder {
  record(refusal: RecordedOfferRefusal): void
  recent(): OfferRefusalTail
}

export const createOfferRefusalTail = (capacity = OFFER_REFUSAL_TAIL_CAPACITY): OfferRefusalRecorder => {
  const entries: RecordedOfferRefusal[] = []
  return {
    record: (refusal) => {
      // Newest first, so the drop is O(1) at the end rather than a shift at the head.
      entries.unshift(refusal)
      if (entries.length > capacity) entries.length = capacity
    },
    // A copy: a caller that sorts the result must not reshape the shared buffer.
    recent: () => ({ entries: [...entries], ephemeral: true, capacity }),
  }
}
