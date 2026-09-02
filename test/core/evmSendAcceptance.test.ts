/**
 * The quote-time gate for `arkade:BTC->ethereum:<token>`.
 *
 * The ordering runs the OPPOSITE way from the other corridors, and that is what
 * this file mostly pins. On the Lightning leg the payee's CLTV fixes the
 * outbound deadline and the Arkade refund is sized to outlast it; on the onchain
 * leg `htlcLocktimeFor` picks the HTLC's CLTV first. Here `evmTimeoutFor`
 * DERIVES the EVM deadline from the Arkade one, so the Arkade side has to be
 * chosen first or the definition is circular — and the anchor is the solver's
 * own recourse delay.
 */

import { describe, it, expect } from 'vitest'
import {
  EVM_MIN_CLAIM_WINDOW_SECONDS,
  EVM_ORDER_MARGIN_SECONDS,
  evaluateEvmSendAcceptance,
} from '@arkade-os/solver-core/core/evmSend.js'

const NOW = 1_800_000_000
const LIMITS = { minSats: 1_000, maxSats: 1_000_000 }
/** A production-shaped Arkade recourse delay: arkd's own floor is 24h. */
const CLAIM_DELAY = 24 * 3600

const accept = (over: Partial<Parameters<typeof evaluateEvmSendAcceptance>[0]> = {}) =>
  evaluateEvmSendAcceptance({
    amountSats: 50_000,
    limits: LIMITS,
    unilateralClaimDelay: CLAIM_DELAY,
    nowSeconds: NOW,
    ...over,
  })

describe('size', () => {
  it('accepts an amount inside the corridor limits', () => {
    expect(accept().accept).toBe(true)
  })

  it.each([
    ['below the minimum', 999],
    ['above the maximum', 1_000_001],
  ])('refuses one %s', (_why, amountSats) => {
    const result = accept({ amountSats })
    expect(result.accept).toBe(false)
    if (!result.accept) expect(result.reason).toBe('amount_out_of_range')
  })

  it('accepts exactly the boundaries, which are inclusive', () => {
    expect(accept({ amountSats: 1_000 }).accept).toBe(true)
    expect(accept({ amountSats: 1_000_000 }).accept).toBe(true)
  })

  it('checks size BEFORE deadlines, so an out-of-range amount is named as such', () => {
    // With an unusable delay both rules would fire; the size answer is the one
    // an operator can act on, and it is the cheaper check.
    const result = accept({ amountSats: 5, unilateralClaimDelay: 1 })
    expect(result.accept).toBe(false)
    if (!result.accept) expect(result.reason).toBe('amount_out_of_range')
  })
})

describe('the deadlines it derives', () => {
  it('anchors the Arkade refund on the solver’s own recourse plus one margin', () => {
    // There is no counterparty-chosen deadline to bound against on this leg, so
    // the server-independent bound is the only one — unlike the onchain leg,
    // where it is one of two.
    const result = accept()
    expect(result.accept).toBe(true)
    if (result.accept) {
      expect(result.refundLocktime).toBe(NOW + CLAIM_DELAY + EVM_ORDER_MARGIN_SECONDS)
    }
  })

  it('puts the EVM timeout exactly one margin before the Arkade refund', () => {
    // The ordering the solver's money depends on: it must be able to see the
    // client's claim and get its own Arkade claim settled before the client's
    // refund path opens.
    const result = accept()
    expect(result.accept).toBe(true)
    if (result.accept) {
      expect(result.refundLocktime - result.evmTimeout).toBe(EVM_ORDER_MARGIN_SECONDS)
    }
  })

  it('leaves the client the whole recourse delay to claim', () => {
    const result = accept()
    expect(result.accept).toBe(true)
    if (result.accept) expect(result.evmTimeout - NOW).toBe(CLAIM_DELAY)
  })

  it('scales with the delay rather than pinning a constant', () => {
    // A network with a longer exit delay must produce a later refund, or the
    // solver's recourse is sized for a different chain than the one it is on.
    const long = accept({ unilateralClaimDelay: 48 * 3600 })
    const short = accept({ unilateralClaimDelay: 24 * 3600 })
    expect(long.accept && short.accept).toBe(true)
    if (long.accept && short.accept) expect(long.refundLocktime).toBeGreaterThan(short.refundLocktime)
  })
})

describe('the anchor clears both constraints, so a safe pair always exists', () => {
  it('lifts a SHORT operator delay up to the minimum claim window', () => {
    // FOUND ON A LIVE STACK. The anchor has to clear two constraints: the
    // solver's recourse (`unilateralClaimDelay`) and the client's ability to
    // claim at all (`minClaimWindow`). Anchoring on the delay alone hands the
    // client a window as short as it — and on the regtest operator, whose delay
    // is under thirty minutes, that made every quote refuse with
    // `deadlines_cannot_be_ordered`. No unit test with a production-shaped 24h
    // delay could see it, because there the two never conflict.
    const short = accept({ unilateralClaimDelay: 600 })
    expect(short.accept).toBe(true)
    if (short.accept) {
      expect(short.refundLocktime).toBe(NOW + EVM_MIN_CLAIM_WINDOW_SECONDS + EVM_ORDER_MARGIN_SECONDS)
      // The client gets the whole minimum window, not the operator's 600s.
      expect(short.evmTimeout - NOW).toBe(EVM_MIN_CLAIM_WINDOW_SECONDS)
    }
  })

  it('leaves a LONG operator delay alone, so mainnet is unchanged', () => {
    const long = accept({ unilateralClaimDelay: 24 * 3600 })
    expect(long.accept).toBe(true)
    if (long.accept) expect(long.refundLocktime).toBe(NOW + 24 * 3600 + EVM_ORDER_MARGIN_SECONDS)
  })

  it.each([0, 1, 60, 600, EVM_MIN_CLAIM_WINDOW_SECONDS - 1, EVM_MIN_CLAIM_WINDOW_SECONDS])(
    'admits a delay of %i seconds rather than refusing it',
    (unilateralClaimDelay) => {
      // The consequence of the lift, stated plainly: NO operator delay makes
      // this unserveable. Every deadline refusal in the union below is now
      // unreachable from this entry point, and that is a property rather than
      // an accident — `latestSafe` is `now + max(delay, window)` and
      // `earliestSafe` is `now + window`, so the first can never be below the
      // second.
      expect(accept({ unilateralClaimDelay }).accept).toBe(true)
    },
  )

  it('honours an injected minimum claim window by lifting to IT', () => {
    const result = accept({ unilateralClaimDelay: 600, minClaimWindowSeconds: 5_000 })
    expect(result.accept).toBe(true)
    if (result.accept) expect(result.evmTimeout - NOW).toBe(5_000)
  })

  it('honours an injected margin, so a boundary can be pinned', () => {
    const result = accept({ orderMarginSeconds: 60 })
    expect(result.accept).toBe(true)
    if (result.accept) expect(result.refundLocktime - result.evmTimeout).toBe(60)
  })

  it('still refuses on SIZE, which is the only thing left that can refuse', () => {
    // Worth pinning: after the lift, `amount_out_of_range` is the sole reachable
    // refusal. If a deadline reason ever appears from here, the anchor is broken
    // rather than the input being unusual.
    const result = accept({ amountSats: 1, unilateralClaimDelay: 1 })
    expect(result.accept).toBe(false)
    if (!result.accept) expect(result.reason).toBe('amount_out_of_range')
  })
})
