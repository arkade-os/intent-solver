import { describe, it, expect } from 'vitest'
import {
  BID_VALIDITY,
  decideOpenRfqBid,
  OPEN_RFQ_MAX_AGE_MS,
  tokenBucket,
  type OpenRfqBidInput,
} from '@arkade-os/solver-core/core/openRfq.js'
import { marketKeyForPair } from '@arkade-os/solver-core/core/marketKey.js'
import { RfqOpen, RFQ_PAIR_SEND } from '@arkade-os/solver-corridors/wire/payloads.js'

const OPEN_ID = 'a'.repeat(64)
const PAIR = RFQ_PAIR_SEND
const LIMITS = { minSats: 1000, maxSats: 100_000 }
const NOW_MS = 1_800_000_000_000

const input = (
  overrides: Partial<OpenRfqBidInput> = {},
  open: Partial<OpenRfqBidInput['open']> = {},
): OpenRfqBidInput => ({
  open: { open_id: OPEN_ID, pair: PAIR, amount_side: 'to', amount: 5000, ...open },
  eventCreatedAtMs: NOW_MS,
  servedPair: PAIR,
  limits: LIMITS,
  feeBps: 0,
  feeFlat: 0,
  nowMs: NOW_MS,
  ...overrides,
})

describe('marketKeyForPair', () => {
  it('derives the § 2 canonical key, arkade leg first', () => {
    expect(marketKeyForPair('arkade:BTC->lightning:BTC')).toBe('arkade:btc/lightning:btc')
  })

  it('gives both directions of a market the same key', () => {
    expect(marketKeyForPair('lightning:BTC->arkade:BTC')).toBe('arkade:btc/lightning:btc')
  })

  it('orders both-arkade legs lexicographically', () => {
    expect(marketKeyForPair('arkade:USDT->arkade:BTC')).toBe('arkade:btc/arkade:usdt')
    expect(marketKeyForPair('arkade:BTC->arkade:USDT')).toBe('arkade:btc/arkade:usdt')
  })

  it('orders neither-arkade legs lexicographically', () => {
    expect(marketKeyForPair('onchain:BTC->lightning:BTC')).toBe('lightning:btc/onchain:btc')
    expect(marketKeyForPair('lightning:BTC->onchain:BTC')).toBe('lightning:btc/onchain:btc')
  })

  it('refuses unknown tickers, corridors and malformed pairs loudly', () => {
    // A misderived key is a subscription that silently misses every open RFQ,
    // so this must fail at startup, not degrade.
    expect(() => marketKeyForPair('arkade:DOGE->lightning:BTC')).toThrow(/no canonical asset id/)
    expect(() => marketKeyForPair('liquid:BTC->arkade:BTC')).toThrow(/unknown corridor/)
    expect(() => marketKeyForPair('arkade:btc/lightning:btc')).toThrow(/not a directional pair/)
  })
})

describe('decideOpenRfqBid', () => {
  it('bids on a served, in-range, fresh open with the configured terms', () => {
    const decision = decideOpenRfqBid(input())
    expect(decision).toEqual({
      kind: 'bid',
      fee_bps: 0,
      fee_flat: 0,
      min: LIMITS.minSats,
      max: LIMITS.maxSats,
      valid_until: Math.floor(NOW_MS / 1000) + BID_VALIDITY,
    })
  })

  it('takes the flat fee off an exact-in size before converting to the to leg', () => {
    // 1040 on the from leg is 990 on the to leg once a 50 flat fee comes off,
    // which is under the 1000 minimum. Converting on the spread alone reads it
    // as 1040 and bids on a size the corridor cannot serve.
    const decision = decideOpenRfqBid(input({ feeBps: 0, feeFlat: 50 }, { amount: 1040, amount_side: 'from' }))
    expect(decision).toEqual({ kind: 'skip', why: 'amount outside limits' })
  })

  it('still bids when the exact-in size clears the minimum after the flat fee', () => {
    const decision = decideOpenRfqBid(input({ feeBps: 0, feeFlat: 50 }, { amount: 1050, amount_side: 'from' }))
    expect(decision).toMatchObject({ kind: 'bid' })
  })

  it('skips an exact-in size the flat fee consumes entirely', () => {
    // Not "outside limits": the corridor serves this size, it just cannot
    // serve it at this fee — the distinction pricing_unavailable draws.
    const decision = decideOpenRfqBid(input({ feeBps: 0, feeFlat: 50 }, { amount: 40, amount_side: 'from' }))
    expect(decision).toEqual({ kind: 'skip', why: 'flat fee consumes the size' })
  })

  it('carries the flat fee into the bid it returns', () => {
    const decision = decideOpenRfqBid(input({ feeBps: 25, feeFlat: 50 }))
    expect(decision).toMatchObject({ kind: 'bid', fee_bps: 25, fee_flat: 50 })
  })

  it('skips an unserved pair', () => {
    const decision = decideOpenRfqBid(input({}, { pair: 'lightning:BTC->arkade:BTC' }))
    expect(decision.kind).toBe('skip')
  })

  it('skips when the bidding window has lapsed', () => {
    const lapsed = Math.floor(NOW_MS / 1000) - 1
    expect(decideOpenRfqBid(input({}, { bids_until: lapsed })).kind).toBe('skip')
  })

  it('honours bids_until over the transport stamp: an old event with a live window still gets a bid', () => {
    const decision = decideOpenRfqBid(
      input({ eventCreatedAtMs: NOW_MS - 10 * OPEN_RFQ_MAX_AGE_MS }, { bids_until: Math.floor(NOW_MS / 1000) + 5 }),
    )
    expect(decision.kind).toBe('bid')
  })

  it('without bids_until, skips a broadcast whose transport stamp is stale', () => {
    const stale = input({ eventCreatedAtMs: NOW_MS - OPEN_RFQ_MAX_AGE_MS - 1 })
    expect(decideOpenRfqBid(stale).kind).toBe('skip')
    const fresh = input({ eventCreatedAtMs: NOW_MS - OPEN_RFQ_MAX_AGE_MS })
    expect(decideOpenRfqBid(fresh).kind).toBe('bid')
  })

  it('gates exact amounts against the limits, boundaries included', () => {
    expect(decideOpenRfqBid(input({}, { amount: LIMITS.minSats })).kind).toBe('bid')
    expect(decideOpenRfqBid(input({}, { amount: LIMITS.maxSats })).kind).toBe('bid')
    expect(decideOpenRfqBid(input({}, { amount: LIMITS.minSats - 1 })).kind).toBe('skip')
    expect(decideOpenRfqBid(input({}, { amount: LIMITS.maxSats + 1 })).kind).toBe('skip')
  })

  it('converts exact-in sizes through the spread before gating', () => {
    // 1% fee: 1009 in pays out floor(1009·10⁴/10100) = 999 — under the floor.
    const under = input({ feeBps: 100 }, { amount_side: 'from', amount: 1009 })
    expect(decideOpenRfqBid(under).kind).toBe('skip')
    const at = input({ feeBps: 100 }, { amount_side: 'from', amount: 1010 })
    expect(decideOpenRfqBid(at).kind).toBe('bid')
  })

  it('bids when a size bucket overlaps the limits, skips when disjoint', () => {
    const bucket = (min: number, max: number) =>
      decideOpenRfqBid(input({}, { amount: undefined, size_bucket: { min, max } }))
    expect(bucket(100, LIMITS.minSats).kind).toBe('bid')
    expect(bucket(LIMITS.maxSats, LIMITS.maxSats * 10).kind).toBe('bid')
    expect(bucket(100, LIMITS.minSats - 1).kind).toBe('skip')
    expect(bucket(LIMITS.maxSats + 1, LIMITS.maxSats * 10).kind).toBe('skip')
  })

  it('skips an open with no size at all rather than trusting the caller parsed one', () => {
    expect(decideOpenRfqBid(input({}, { amount: undefined })).kind).toBe('skip')
  })
})

describe('tokenBucket', () => {
  it('serves its per-minute budget, then refuses until time refills it', () => {
    const bucket = tokenBucket(2, NOW_MS)
    expect(bucket.take(NOW_MS)).toBe(true)
    expect(bucket.take(NOW_MS)).toBe(true)
    expect(bucket.take(NOW_MS)).toBe(false)
    // Half a minute refills one token at 2/min; not before.
    expect(bucket.take(NOW_MS + 29_000)).toBe(false)
    expect(bucket.take(NOW_MS + 30_000)).toBe(true)
  })

  it('caps the burst at one minute of budget however long the quiet spell', () => {
    const bucket = tokenBucket(2, NOW_MS)
    const later = NOW_MS + 3_600_000
    expect(bucket.take(later)).toBe(true)
    expect(bucket.take(later)).toBe(true)
    expect(bucket.take(later)).toBe(false)
  })

  it('does not mint tokens from a clock that goes backwards', () => {
    const bucket = tokenBucket(1, NOW_MS)
    expect(bucket.take(NOW_MS)).toBe(true)
    expect(bucket.take(NOW_MS - 120_000)).toBe(false)
  })

  it('rejects a non-positive or fractional rate', () => {
    expect(() => tokenBucket(0, NOW_MS)).toThrow()
    expect(() => tokenBucket(-1, NOW_MS)).toThrow()
    expect(() => tokenBucket(1.5, NOW_MS)).toThrow()
  })
})

describe('RfqOpen wire schema', () => {
  const base = { v: 1, type: 'rfq_open', open_id: OPEN_ID, pair: PAIR, amount_side: 'to' }

  it('accepts an exact amount or a size bucket', () => {
    expect(RfqOpen.safeParse({ ...base, amount: 5000 }).success).toBe(true)
    expect(RfqOpen.safeParse({ ...base, size_bucket: { min: 1000, max: 10_000 } }).success).toBe(true)
    expect(RfqOpen.safeParse({ ...base, amount: 5000, bids_until: 1_800_000_030 }).success).toBe(true)
  })

  it('rejects both sizes, neither size, and an inverted bucket', () => {
    expect(RfqOpen.safeParse({ ...base, amount: 5000, size_bucket: { min: 1, max: 2 } }).success).toBe(false)
    expect(RfqOpen.safeParse(base).success).toBe(false)
    expect(RfqOpen.safeParse({ ...base, size_bucket: { min: 10, max: 1 } }).success).toBe(false)
  })

  it('rejects unknown fields, in the envelope and inside the bucket', () => {
    expect(RfqOpen.safeParse({ ...base, amount: 5000, surprise: true }).success).toBe(false)
    expect(RfqOpen.safeParse({ ...base, size_bucket: { min: 1000, max: 2000, surprise: true } }).success).toBe(false)
  })

  it('rejects a malformed open_id', () => {
    expect(RfqOpen.safeParse({ ...base, open_id: 'short', amount: 5000 }).success).toBe(false)
  })
})
