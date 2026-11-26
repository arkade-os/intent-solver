import { describe, expect, it } from 'vitest'
import { evaluateReceiveFunding, minHtlcWindowFor } from '@arkade-os/solver-core/core/receive.js'
import { rawDelaySeconds } from '@arkade-os/solver-core/core/timelocks.js'
import {
  timeAPaymentMustLast,
  whatStopsThePayout,
  type ReceiveTerms,
} from '@arkade-os/solver-next/domain/swap/lightning_receive.js'
import { t } from '../support.js'

const MINUTE = 60
const NOW = t(1_800_000_000)
const after = (seconds: number) => t(NOW + seconds)

const terms = (override: Partial<ReceiveTerms> = {}): ReceiveTerms => ({
  invoiceExpiresAt: after(10 * MINUTE),
  paymentExpiresAt: after(180 * MINUTE),
  payoutComesBackAt: after(100 * MINUTE),
  secondsToTakeItBackAlone: 60 * MINUTE,
  acceptsNotBeingCoveredWithoutArkade: false,
  ...override,
})

describe('paying out a Lightning receive', () => {
  it('is allowed when the invoice is valid, the payment waits, and there is time for everything', () => {
    expect(whatStopsThePayout(terms(), NOW)).toBeNull()
  })

  it('stops on an invoice that expired, and while nobody has paid', () => {
    expect(whatStopsThePayout(terms({ invoiceExpiresAt: NOW }), NOW)).toBe('invoice_expired')
    expect(whatStopsThePayout(terms({ paymentExpiresAt: null }), NOW)).toBe('htlc_not_armed')
  })

  it('stops when the payment expires in under 90 minutes', () => {
    expect(whatStopsThePayout(terms({ paymentExpiresAt: after(90 * MINUTE - 1) }), NOW)).toBe('settle_window_too_short')
    const justEnough = terms({ paymentExpiresAt: after(90 * MINUTE), payoutComesBackAt: after(75 * MINUTE) })
    expect(whatStopsThePayout({ ...justEnough, secondsToTakeItBackAlone: 60 * MINUTE }, NOW)).toBeNull()
  })

  it('stops when our payout would come back less than 15 minutes before the payment expires', () => {
    const late = terms({ payoutComesBackAt: after(165 * MINUTE + 1) })
    expect(whatStopsThePayout(late, NOW)).toBe('refund_deadline_too_late')
    expect(whatStopsThePayout(terms({ payoutComesBackAt: after(165 * MINUTE) }), NOW)).toBeNull()
  })

  it('stops when taking it back alone would end less than 30 minutes before the payment expires', () => {
    const slow = terms({ secondsToTakeItBackAlone: 150 * MINUTE + 1 })
    expect(whatStopsThePayout(slow, NOW)).toBe('unilateral_recourse_after_htlc')
    expect(whatStopsThePayout({ ...slow, acceptsNotBeingCoveredWithoutArkade: true }, NOW)).toBeNull()
  })

  it('asks an invoice for the longest of the times it will later check', () => {
    expect(timeAPaymentMustLast(10 * MINUTE, false)).toBe(135 * MINUTE)
    expect(timeAPaymentMustLast(200 * MINUTE, false)).toBe(230 * MINUTE)
    expect(timeAPaymentMustLast(200 * MINUTE, true)).toBe(135 * MINUTE)
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

  it('give the same answer about paying out, on 300,000 random situations', () => {
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
      const ours = whatStopsThePayout(
        {
          invoiceExpiresAt: t(input.invoiceExpiresAt),
          paymentExpiresAt: input.htlcExpiresAt === null ? null : t(input.htlcExpiresAt),
          payoutComesBackAt: t(input.refundLocktime),
          secondsToTakeItBackAlone: rawDelaySeconds(raw),
          acceptsNotBeingCoveredWithoutArkade: input.acceptUnilateralGap,
        },
        t(now),
      )
      if ((today.fund ? null : today.reason) !== ours) {
        throw new Error(`differs on ${JSON.stringify(input)}: today ${JSON.stringify(today)}, ours ${ours}`)
      }
    }
  })

  it('ask an invoice for the same time', () => {
    for (const raw of RAW_DELAYS) {
      for (const accepts of [false, true]) {
        expect(timeAPaymentMustLast(rawDelaySeconds(raw), accepts)).toBe(minHtlcWindowFor(raw, accepts))
      }
    }
  })
})
