import { describe, expect, it } from 'vitest'
import { evaluateReceiveFunding, minHtlcWindowFor } from '@arkade-os/solver-core/core/receive.js'
import { rawDelaySeconds } from '@arkade-os/solver-core/core/timelocks.js'
import {
  timeTheHtlcMustLast,
  whatStopsTheFill,
  type ReceiveTerms,
} from '@arkade-os/solver-next/domain/swap/lightning_receive.js'
import { t } from '../support.js'

const MINUTE = 60
const NOW = t(1_800_000_000)
const after = (seconds: number) => t(NOW + seconds)

const terms = (override: Partial<ReceiveTerms> = {}): ReceiveTerms => ({
  invoiceExpiresAt: after(10 * MINUTE),
  htlcExpiresAt: after(180 * MINUTE),
  refundOpensAt: after(100 * MINUTE),
  secondsToRefundAlone: 60 * MINUTE,
  acceptsNoRefundAlone: false,
  ...override,
})

describe('filling a Lightning receive', () => {
  it('is allowed when the invoice is valid, the hold is armed, and there is time for everything', () => {
    expect(whatStopsTheFill(terms(), NOW)).toBeNull()
  })

  it('stops on an invoice that expired, and while the hold is not armed', () => {
    expect(whatStopsTheFill(terms({ invoiceExpiresAt: NOW }), NOW)).toBe('invoice_expired')
    expect(whatStopsTheFill(terms({ htlcExpiresAt: null }), NOW)).toBe('htlc_not_armed')
  })

  it('calls an expired invoice expired even while a payment is held on it', () => {
    expect(whatStopsTheFill(terms({ invoiceExpiresAt: NOW, htlcExpiresAt: after(180 * MINUTE) }), NOW)).toBe(
      'invoice_expired',
    )
  })

  it('still judges a refund that is already open: it opens before the HTLC expires', () => {
    expect(whatStopsTheFill(terms({ refundOpensAt: after(-10 * MINUTE) }), NOW)).toBeNull()
  })

  it('refuses terms that cannot be right: a block height for a time, or a negative delay', () => {
    expect(() => whatStopsTheFill(terms({ refundOpensAt: t(900_000) }), NOW)).toThrow('not a block height')
    for (const delay of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => whatStopsTheFill(terms({ secondsToRefundAlone: delay }), NOW)).toThrow('must not be negative')
    }
  })

  it('stops when the HTLC expires in under 90 minutes', () => {
    expect(whatStopsTheFill(terms({ htlcExpiresAt: after(90 * MINUTE - 1) }), NOW)).toBe('settle_window_too_short')
    const justEnough = terms({ htlcExpiresAt: after(90 * MINUTE), refundOpensAt: after(75 * MINUTE) })
    expect(whatStopsTheFill({ ...justEnough, secondsToRefundAlone: 60 * MINUTE }, NOW)).toBeNull()
  })

  it('stops when our refund opens less than 15 minutes before the HTLC expires', () => {
    const late = terms({ refundOpensAt: after(165 * MINUTE + 1) })
    expect(whatStopsTheFill(late, NOW)).toBe('refund_deadline_too_late')
    expect(whatStopsTheFill(terms({ refundOpensAt: after(165 * MINUTE) }), NOW)).toBeNull()
  })

  it('stops when our refund alone opens less than 30 minutes before the HTLC expires', () => {
    const slow = terms({ secondsToRefundAlone: 150 * MINUTE + 1 })
    expect(whatStopsTheFill(slow, NOW)).toBe('unilateral_recourse_after_htlc')
    expect(whatStopsTheFill({ ...slow, acceptsNoRefundAlone: true }, NOW)).toBeNull()
  })

  it('asks an invoice for the longest of the times it will later check', () => {
    expect(timeTheHtlcMustLast(10 * MINUTE, false)).toBe(135 * MINUTE)
    expect(timeTheHtlcMustLast(200 * MINUTE, false)).toBe(230 * MINUTE)
    expect(timeTheHtlcMustLast(200 * MINUTE, true)).toBe(135 * MINUTE)
  })
})

// Seeded so a failure can be replayed.
const random = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296
}

describe('the rules in production today', () => {
  const next = random(20261126)
  const between = (low: number, high: number) => low + Math.floor(next() * (high - low + 1))
  // Around every threshold, where an off-by-one would hide.
  const EDGES = [0, 1, 15, 30, 75, 90, 105, 120, 135, 150, 165, 180].flatMap((m) => [
    m * MINUTE - 1,
    m * MINUTE,
    m * MINUTE + 1,
  ])
  const seconds = () => (next() < 0.5 ? EDGES[between(0, EDGES.length - 1)]! : between(-600, 5 * 3600))
  const RAW_DELAYS = [1, 6, 28, 144, 511, 512, 1024, 4096, 86_528, 5400, 9000, 9001]

  it('give the same answer about filling, on 300,000 random situations', () => {
    for (let i = 0; i < 300_000; i++) {
      const now = between(1_700_000_000, 1_900_000_000)
      const raw = RAW_DELAYS[between(0, RAW_DELAYS.length - 1)]!
      const input = {
        invoiceExpiresAt: now + seconds(),
        htlcExpiresAt: next() < 0.1 ? null : now + seconds(),
        refundLocktime: now + seconds(),
        unilateralRefundWithoutReceiverDelay: raw,
        acceptUnilateralGap: next() < 0.3,
        now,
      }
      const today = evaluateReceiveFunding(input)
      const ours = whatStopsTheFill(
        {
          invoiceExpiresAt: t(input.invoiceExpiresAt),
          htlcExpiresAt: input.htlcExpiresAt === null ? null : t(input.htlcExpiresAt),
          refundOpensAt: t(input.refundLocktime),
          secondsToRefundAlone: rawDelaySeconds(raw),
          acceptsNoRefundAlone: input.acceptUnilateralGap,
        },
        t(now),
      )
      if ((today.fund ? null : today.reason) !== ours) {
        throw new Error(`differs on ${JSON.stringify(input)}: today ${JSON.stringify(today)}, ours ${ours}`)
      }
    }
  })

  it('never fill either when the refund locktime is a block height: neither side takes it for a time', () => {
    for (let i = 0; i < 20_000; i++) {
      const now = between(1_700_000_000, 1_900_000_000)
      const input = {
        invoiceExpiresAt: now + seconds(),
        htlcExpiresAt: next() < 0.1 ? null : now + seconds(),
        refundLocktime: between(1, 499_999_999),
        unilateralRefundWithoutReceiverDelay: 1024,
        acceptUnilateralGap: next() < 0.3,
        now,
      }
      let todayFills = false
      try {
        todayFills = evaluateReceiveFunding(input).fund
      } catch {
        todayFills = false
      }
      expect(todayFills).toBe(false)
      expect(() =>
        whatStopsTheFill(
          {
            invoiceExpiresAt: t(input.invoiceExpiresAt),
            htlcExpiresAt: input.htlcExpiresAt === null ? null : t(input.htlcExpiresAt),
            refundOpensAt: t(input.refundLocktime),
            secondsToRefundAlone: 1024,
            acceptsNoRefundAlone: input.acceptUnilateralGap,
          },
          t(now),
        ),
      ).toThrow('not a block height')
    }
  })

  it('ask an invoice for the same time', () => {
    for (const raw of RAW_DELAYS) {
      for (const accepts of [false, true]) {
        expect(timeTheHtlcMustLast(rawDelaySeconds(raw), accepts)).toBe(minHtlcWindowFor(raw, accepts))
      }
    }
  })
})
