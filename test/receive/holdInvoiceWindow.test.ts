/**
 * The claim race a receive quote must leave itself, and the drift that ate it.
 *
 * A payer may pay right up to `payDeadline` — which a client computes as
 * `min(invoice.expiresAt, quote.valid_until)` — and only then does the solver
 * start racing to claim the Arkade lockup before its own refund opens. The gap
 * between those two is the whole margin:
 *
 *     refundLocktime - payDeadline  >=  MIN_CLAIM_WINDOW
 *
 * `DEFAULT_HOLD_INVOICE_WINDOW` and `MAX_REFUND_HORIZON` were hardcoded
 * independently, and the gap between them was nobody's job. At `2 * HOUR` the
 * window equalled the horizon and the race was ZERO seconds. Lowered to 95
 * minutes it was 1500s — under the 1800s `@arkade-os/swap`'s `assertReceivable`
 * requires by default, so every client refused the quote with
 * `claim_window_too_short` before paying. The corridor was unpayable and its own
 * tests were green, because nothing anywhere asserted the relationship.
 *
 * These tests assert the RELATIONSHIP, never the numbers. Re-hardcoding the
 * window to any value that eats the race fails them, whichever value it is.
 */

import { describe, it, expect } from 'vitest'
import { DEFAULT_HOLD_INVOICE_WINDOW } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { MAX_REFUND_HORIZON } from '@arkade-os/solver-core/core/receive.js'
import { MIN_CLAIM_WINDOW } from '@arkade-os/solver-core/core/send.js'

/**
 * What `assertReceivable` in `@arkade-os/swap@0.0.9` demands by default.
 *
 * Duplicated as a number on purpose rather than imported: it is a FOREIGN
 * policy, and a client is free to pass a stricter one. Importing it would make
 * this test track whatever the SDK does next, when the point is that our own
 * margin must satisfy it without depending on it.
 */
const SDK_MIN_CLAIM_WINDOW_SECONDS = 1800

/** The moment after which no payment can arrive, from a quote issued at `now`. */
const payDeadline = (now: number): number => now + DEFAULT_HOLD_INVOICE_WINDOW

/** The solver's own refund, fixed at quote time and baked into the lockup address. */
const refundLocktime = (now: number): number => now + MAX_REFUND_HORIZON

describe('the receive quote leaves itself a claim race', () => {
  const now = 1_800_000_000

  it('leaves at least MIN_CLAIM_WINDOW between the last payment and its own refund', () => {
    expect(refundLocktime(now) - payDeadline(now)).toBeGreaterThanOrEqual(MIN_CLAIM_WINDOW)
  })

  it('satisfies the SDK gate that was refusing every quote', () => {
    // The specific failure this closes. 1500 < 1800 refused deterministically.
    expect(refundLocktime(now) - payDeadline(now)).toBeGreaterThanOrEqual(SDK_MIN_CLAIM_WINDOW_SECONDS)
  })

  it('tracks the horizon, so the two cannot drift apart unnoticed', () => {
    // A DRIFT DETECTOR, not a hardcoding preventer, and the difference is worth
    // being exact about: `1800` written as a literal satisfies this today,
    // because it equals the derivation. I checked, and it does pass.
    //
    // What it catches is the failure that actually happened — one constant moving
    // while the other stayed. Change `MAX_REFUND_HORIZON` with the window
    // hardcoded and this fires immediately, which is the moment the corridor
    // would otherwise become unpayable in silence. Preventing the literal itself
    // would need a source-text assertion, and that buys nothing here: a literal
    // that matches is harmless until something moves, and this is what fires then.
    expect(DEFAULT_HOLD_INVOICE_WINDOW).toBe(MAX_REFUND_HORIZON - MIN_CLAIM_WINDOW)
  })

  it('still gives a payer a usable window', () => {
    // The cost side of the derivation, pinned so a future change to either
    // constant cannot quietly shrink the invoice to something nobody can pay.
    // 15 minutes is BTCPay Server's own default invoice expiry.
    expect(DEFAULT_HOLD_INVOICE_WINDOW).toBeGreaterThanOrEqual(15 * 60)
  })

  it('never lets the invoice outlive the solver’s refund', () => {
    // The degenerate end of the old bug: a window equal to the horizon.
    expect(DEFAULT_HOLD_INVOICE_WINDOW).toBeLessThan(MAX_REFUND_HORIZON)
  })

  /**
   * `payDeadline` takes the MINIMUM of the invoice expiry and `valid_until`, and
   * both are derived from this one constant — so a backend that shortens the
   * invoice can only widen the race, and one that lengthens it cannot widen the
   * deadline past `valid_until`. This pins that asymmetry, which is what makes
   * the invariant hold regardless of what the Lightning backend does with the
   * request.
   */
  it.each([
    ['a backend that shortens the invoice', 300],
    ['a backend that honours the request', DEFAULT_HOLD_INVOICE_WINDOW],
    ['a backend that lengthens it', MAX_REFUND_HORIZON * 4],
  ])('holds the invariant against %s', (_why, backendExpirySeconds) => {
    const effective = Math.min(now + backendExpirySeconds, now + DEFAULT_HOLD_INVOICE_WINDOW)
    expect(refundLocktime(now) - effective).toBeGreaterThanOrEqual(MIN_CLAIM_WINDOW)
  })
})
