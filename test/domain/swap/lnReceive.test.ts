import { describe, expect, it } from 'vitest'
import * as legacy from '@arkade-os/solver-core/core/receive.js'
import { rawDelaySeconds } from '@arkade-os/solver-core/core/timelocks.js'
import {
  lnReceivePolicies,
  MIN_SETTLE_WINDOW,
  REFUND_ALONE_MARGIN,
  REFUND_RETRY_WINDOW,
  SETTLE_SAFETY_MARGIN,
} from '@arkade-os/solver-core/domain/swap/ln_receive.js'
import type { LegStatus, Observation } from '@arkade-os/solver-core/domain/swap/observation.js'
import { Quote } from '@arkade-os/solver-core/domain/swap/quote.js'
import { REFUND_CENSORSHIP_GRACE } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { btc, quoted, ref, t } from '../support.js'

const NOW = 1_800_000_000
const MINUTE = 60

const leg: LegStatus = {
  funding: 'none',
  matured: false,
  spent: { by: 'nobody' },
  refundOpen: false,
  expiresAt: null,
  refundOpensAt: null,
  refundAloneDelay: null,
  lock: 'none',
  claim: 'none',
  refund: 'none',
}

const seen = (now: number, from: Partial<LegStatus> = {}, to: Partial<LegStatus> = {}): Observation => ({
  now: t(now),
  from: { ...leg, ...from },
  to: { ...leg, ...to },
  peer: null,
  keyCurrent: true,
  approval: 'not_required',
  ownInvoice: false,
})

const swapValidUntil = (validUntil: number) =>
  quoted({ quote: Quote.of(t(validUntil), { fee: btc(10n), spreadBps: 0 }), at: t(NOW - 1_000) })

describe('LN receive rules', () => {
  it('uses the same numbers as the legacy corridor', () => {
    expect(MIN_SETTLE_WINDOW).toBe(legacy.MIN_SETTLE_WINDOW)
    expect(SETTLE_SAFETY_MARGIN).toBe(legacy.SETTLE_SAFETY_MARGIN)
    expect(REFUND_ALONE_MARGIN).toBe(legacy.UNILATERAL_RECOURSE_MARGIN)
    expect(REFUND_RETRY_WINDOW).toBe(REFUND_CENSORSHIP_GRACE)
  })

  it('allows and refuses a payout exactly as evaluateReceiveFunding does', () => {
    const offsets = [-1, 0, 1]
    const around = (base: number) => offsets.map((offset) => base + offset)
    // 9216 s is a delay the contract can encode, so the last group sits exactly on the refund-alone limit.
    const timeouts = [
      null,
      ...around(NOW + MIN_SETTLE_WINDOW),
      ...around(NOW + 3 * 60 * MINUTE),
      ...around(NOW + 9216 + REFUND_ALONE_MARGIN),
    ]
    const invoiceExpiries = around(NOW)
    const delays = [1536, 9216, 28]
    let compared = 0

    for (const acceptGap of [false, true]) {
      const policies = lnReceivePolicies({ acceptRefundAloneGap: acceptGap })
      for (const htlcExpiresAt of timeouts) {
        const refundDeadlines = htlcExpiresAt === null ? [NOW] : [NOW, ...around(htlcExpiresAt - SETTLE_SAFETY_MARGIN)]
        for (const invoiceExpiresAt of invoiceExpiries) {
          for (const refundLocktime of refundDeadlines) {
            for (const delay of delays) {
              const old = legacy.evaluateReceiveFunding({
                invoiceExpiresAt,
                htlcExpiresAt,
                refundLocktime,
                unilateralRefundWithoutReceiverDelay: delay,
                acceptUnilateralGap: acceptGap,
                now: NOW,
              })
              const result = policies.canFill(
                swapValidUntil(invoiceExpiresAt),
                seen(
                  NOW,
                  { expiresAt: htlcExpiresAt === null ? null : t(htlcExpiresAt) },
                  { refundOpensAt: t(refundLocktime), refundAloneDelay: rawDelaySeconds(delay) },
                ),
              )
              expect(result).toEqual(old.fund ? { ok: true } : { ok: false, reason: `refused to fund: ${old.reason}` })
              compared += 1
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(300)
  })

  it('refuses when a deadline is not known', () => {
    const policies = lnReceivePolicies({ acceptRefundAloneGap: false })
    const swap = swapValidUntil(NOW + 100)
    const from = { expiresAt: t(NOW + 4 * 60 * MINUTE) }
    expect(policies.canFill(swap, seen(NOW, from, { refundAloneDelay: 1536 }))).toMatchObject({ ok: false })
    expect(policies.canFill(swap, seen(NOW, from, { refundOpensAt: t(NOW) }))).toMatchObject({ ok: false })
  })

  it('never resends a payout that the rail does not show', () => {
    const { onLockMissing } = lnReceivePolicies({ acceptRefundAloneGap: false })
    const swap = swapValidUntil(NOW + 100)
    expect(onLockMissing(swap, seen(NOW, {}, { refundOpensAt: t(NOW + 1) }))).toBe('wait')
    expect(onLockMissing(swap, seen(NOW, {}, { refundOpensAt: t(NOW) }))).toBe('stuck')
  })

  it('retries a failed settle only until the Lightning payment times out', () => {
    const { onClaimFailed } = lnReceivePolicies({ acceptRefundAloneGap: false })
    const swap = swapValidUntil(NOW + 100)
    expect(onClaimFailed(swap, seen(NOW, { expiresAt: t(NOW + 1) }))).toBe('retry')
    expect(onClaimFailed(swap, seen(NOW, { expiresAt: t(NOW) }))).toBe('stuck')
    expect(onClaimFailed(swap, seen(NOW))).toBe('stuck')
  })

  it('retries a failed refund for six hours, then calls an operator', () => {
    const { onRefundFailed } = lnReceivePolicies({ acceptRefundAloneGap: false })
    const swap = swapValidUntil(NOW + 100)
    swap.lock('from', t(NOW - 900), ref('held'))
    swap.locking('to', t(NOW - 800))
    swap.lock('to', t(NOW - 700), ref('txid-out'))
    swap.refunding('to', t(NOW))
    expect(onRefundFailed(swap, seen(NOW + REFUND_RETRY_WINDOW - 1))).toBe('retry')
    expect(onRefundFailed(swap, seen(NOW + REFUND_RETRY_WINDOW))).toBe('stuck')
  })
})
