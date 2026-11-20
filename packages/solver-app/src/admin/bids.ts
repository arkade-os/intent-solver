/** Published open-RFQ price previews, bounded in memory and cleared on restart. */
import type { OpenRfq } from '@arkade-os/solver-core/core/openRfq.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'

export interface RecordedBid {
  /** Unix seconds this solver answered. */
  at: number
  /** The directional pair bid on. */
  pair: string
  amountSide: 'from' | 'to'
  fromAmount: string
  toAmount: string
  /** Preview expiry, unix seconds. */
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

/** `OpenRfqBidderDeps.onBid`, filing each bid into `tail`. */
export const recordBidsIn =
  (tail: BidRecorder, now: () => number = nowSeconds) =>
  (open: OpenRfq, bid: { from_amount: string; to_amount: string; valid_until: number }): void =>
    tail.record({
      at: now(),
      pair: open.pair,
      amountSide: open.amount_side,
      fromAmount: bid.from_amount,
      toAmount: bid.to_amount,
      validUntil: bid.valid_until,
    })
