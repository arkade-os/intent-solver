/**
 * A bounded, in-memory tail of recent open-RFQ bids.
 *
 * Bids are persisted NOWHERE today — `src/core/openRfq.ts` is pure and the
 * ingress publishes without recording — so this is the only way to see that a
 * solver is bidding at all. It is deliberately not a database: persistence was
 * deferred, and a ring buffer that everyone knows is ephemeral is honest in a
 * way a half-built table would not be.
 *
 * The consequence has to reach the UI, which is why `ephemeral` is part of the
 * payload rather than a comment: an empty list after a restart means "nothing
 * recorded since boot", NOT "this solver has made no bids", and an operator
 * reading the second from the first would draw exactly the wrong conclusion
 * about a quiet market.
 */

export interface RecordedBid {
  /** Unix seconds this solver answered. */
  at: number
  /** The directional pair bid on. */
  pair: string
  amountSats: number
  feeBps: number
  /** How long the bid's terms stay claimable, unix seconds. */
  validUntil: number
}

export interface BidTail {
  entries: RecordedBid[]
  /** Always true. Present so the UI can say so rather than implying an empty list is meaningful. */
  ephemeral: true
  /** How many bids the buffer holds before the oldest is dropped. */
  capacity: number
}

/** Enough to see a pattern, small enough to never matter for memory. */
export const BID_TAIL_CAPACITY = 200

export interface BidRecorder {
  record(bid: RecordedBid): void
  recent(): BidTail
}

export const createBidTail = (capacity = BID_TAIL_CAPACITY): BidRecorder => {
  const entries: RecordedBid[] = []
  return {
    record: (bid) => {
      // Newest first, so `recent()` needs no reversal and the drop is O(1) at
      // the end rather than a shift at the head on every single bid.
      entries.unshift(bid)
      if (entries.length > capacity) entries.length = capacity
    },
    // A copy: a caller that sorts or splices the result must not reshape the
    // buffer every other caller reads.
    recent: () => ({ entries: [...entries], ephemeral: true, capacity }),
  }
}
