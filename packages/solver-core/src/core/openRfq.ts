/**
 * Open-RFQ bidding, the solver side (docs/rfq-protocol.md § 4.6).
 *
 * Everything here is pure — clock, fee and limits injected — so every gate is
 * testable without a relay. The ingress owns the I/O: subscribe by market-key
 * topic, parse, ask this module whether to bid, publish.
 *
 * The posture is deliberately asymmetric. Broadcasts are cheap to receive and
 * NEVER answered with refusals (a shared bus turns refusals into spam
 * amplification), so every gate here fails toward silence. But a bid we do
 * send is a signed price commitment that caps ALL conforming directed traffic
 * on the pair until `valid_until` — so bids are short-lived, priced from the
 * same config the quotes use, and rate-limited.
 */

import type { RfqOpenPayload } from './rfqProtocol.js'
import type { Limits } from './limits.js'
import { MINUTE } from './timelocks.js'

/**
 * How long a bid's terms are claimable, seconds. Short on purpose: every
 * unexpired bid is a standing cap on our directed quotes (§ 4.6), and a
 * client only needs seconds between collecting bids and closing.
 */
export const BID_VALIDITY = 5 * MINUTE

/**
 * When an open RFQ carries no `bids_until`, ignore broadcasts whose transport
 * stamp is older than this (ms). Sanctioned by § 4.6: broadcast freshness is
 * a relevance filter, not a protocol deadline — without it, subscription
 * replay after a reconnect would have us bidding on the relay's entire
 * backlog.
 */
export const OPEN_RFQ_MAX_AGE_MS = 60_000

/** A schema-valid `rfq_open`, minus the envelope — derived from the wire
 * schema so this module cannot drift from what the ingress parses. */
export type OpenRfq = Omit<RfqOpenPayload, 'v' | 'type'>

export interface OpenRfqBidInput {
  open: OpenRfq
  /** Transport stamp of the broadcast event, unix ms. */
  eventCreatedAtMs: number
  /** The directional pair this solver serves. */
  servedPair: string
  limits: Limits
  /** The solver's spread; the SAME value the registry card publishes. */
  feeBps: number
  /**
   * The solver's flat charge, atomic units of the from leg, zero for none.
   * The part of the price that does not scale with size.
   */
  feeFlat: number
  nowMs: number
}

export type OpenRfqBidDecision =
  | { kind: 'bid'; fee_bps: number; fee_flat: number; min: number; max: number; valid_until: number }
  | { kind: 'skip'; why: string }

/**
 * Decide whether to bid on an open RFQ. Every skip is silent on the wire; the
 * `why` exists for logs and tests only and must never be published.
 */
export const decideOpenRfqBid = (input: OpenRfqBidInput): OpenRfqBidDecision => {
  const { open, limits, feeBps, feeFlat, nowMs } = input
  const now = Math.floor(nowMs / 1000)

  if (open.pair !== input.servedPair) return { kind: 'skip', why: 'unserved pair' }

  // A lapsed window means our bid could only arrive after the client stopped
  // collecting — and an unclaimable bid still caps our directed quotes, so
  // skipping is the paranoid choice, not just the polite one.
  if (open.bids_until !== undefined) {
    if (now > open.bids_until) return { kind: 'skip', why: 'bidding window lapsed' }
  } else if (nowMs - input.eventCreatedAtMs > OPEN_RFQ_MAX_AGE_MS) {
    return { kind: 'skip', why: 'no bids_until and transport stamp stale' }
  }

  // Bounds are to-leg amounts (§ 4.6). An exact-in size converts through our own
  // price — the from leg pays the spread AND the flat charge, so the flat comes off
  // before the spread converts what remains. On bps alone, a size the flat fee has
  // already eaten would read as servable.
  if (open.amount !== undefined) {
    if (open.amount_side !== 'to' && open.amount <= feeFlat) {
      // Not "outside limits": the corridor serves this size, it just cannot
      // serve it at this fee. Same distinction pricing_unavailable draws.
      return { kind: 'skip', why: 'flat fee consumes the size' }
    }
    const toAmount =
      open.amount_side === 'to' ? open.amount : Math.floor(((open.amount - feeFlat) * 10_000) / (10_000 + feeBps))
    if (toAmount < limits.minSats || toAmount > limits.maxSats) {
      return { kind: 'skip', why: 'amount outside limits' }
    }
  } else if (open.size_bucket !== undefined) {
    // A bucket only needs to OVERLAP our range: the bid's min/max tell the
    // client the exact bounds before it commits to anything.
    if (open.size_bucket.max < limits.minSats || open.size_bucket.min > limits.maxSats) {
      return { kind: 'skip', why: 'size bucket disjoint from limits' }
    }
  } else {
    // The wire schema enforces exactly-one-of; this branch is unreachable
    // through it, but this module must not trust its caller's parsing.
    return { kind: 'skip', why: 'no size' }
  }

  return {
    kind: 'bid',
    fee_bps: feeBps,
    fee_flat: feeFlat,
    min: limits.minSats,
    max: limits.maxSats,
    valid_until: now + BID_VALIDITY,
  }
}

export interface TokenBucket {
  /** Take one token; false = rate-limited. */
  take(nowMs: number): boolean
}

/**
 * The bid rate limiter: `perMinute` tokens, refilled continuously, burst
 * capped at one minute's worth. Bids are the only spend a broadcast can force
 * on us (§ 4.6), so the bucket is taken only when we actually bid.
 */
export const tokenBucket = (perMinute: number, startMs: number): TokenBucket => {
  if (!Number.isInteger(perMinute) || perMinute <= 0) {
    throw new Error(`token bucket rate must be a positive integer, got ${perMinute}`)
  }
  let tokens = perMinute
  let lastMs = startMs
  return {
    take(nowMs: number): boolean {
      // A clock that goes backwards must not mint tokens.
      const elapsed = Math.max(0, nowMs - lastMs)
      lastMs = nowMs
      tokens = Math.min(perMinute, tokens + (elapsed * perMinute) / 60_000)
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}

/**
 * Whether to bid on an open RFQ, and at what terms.
 *
 * `decideOpenRfqBid` is the default and is a pure function of the broadcast,
 * the served pair, the corridor's limits and its fee. That is the right default
 * and a poor ceiling: bidding is where a solver competes, and an operator
 * running a real book wants to price a bid against inventory, against what it
 * already won this minute, or against who is asking — none of which a pure
 * function over the broadcast can see.
 *
 * TWO RULES A REPLACEMENT MAY NOT RELAX, both enforced around the call in
 * `ingress/relay.ts` rather than here:
 *
 * - SILENCE, never a refusal. § 4.6 inverts § 4's rule: a broadcast this solver
 *   cannot serve is answered by saying nothing at all. Returning `skip` is how
 *   a strategy declines; there is no refusal shape to return, deliberately.
 * - The rate limit still applies. A strategy that wants to bid more often does
 *   not get to; `maxBidsPerMinute` is the operator's budget, not the
 *   strategy's, and the token is taken only when a bid is actually published.
 *
 * A bid is also a PROMISE the quote must keep: `rfqBidPayload` carries both fee
 * components precisely because a bid quoting only `fee_bps` while the corridor
 * also charges a flat fee advertises a better rate than the quote will honour.
 */
export interface BiddingStrategy {
  decide(input: OpenRfqBidInput): OpenRfqBidDecision
}

/** The default: § 4.6's rules, exactly as `decideOpenRfqBid` implements them. */
export const defaultBidding: BiddingStrategy = { decide: decideOpenRfqBid }
