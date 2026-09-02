/**
 * The CLIENT's gates, run against the quotes this solver actually emits.
 *
 * ## Why this file exists
 *
 * `DEFAULT_HOLD_INVOICE_WINDOW` and `MAX_REFUND_HORIZON` drifted apart and left
 * the lightning receive corridor unpayable: every client refused the quote with
 * `claim_window_too_short` before paying a satoshi. Every test in this repo was
 * green throughout — because every test asserted OUR numbers, and the check that
 * refused us is not ours. It ships in `@arkade-os/swap`, and nothing here ran it.
 *
 * That is the gap this file closes. It imports the published client package and
 * runs its real `assertReceivable` / `assertFundable` against payloads built by
 * this repo's own wire builders. A quote these tests accept is a quote the
 * client that actually exists accepts.
 *
 * ## How this differs from `holdInvoiceWindow.test.ts`
 *
 * That file pins the RELATIONSHIP between our own constants, and hardcodes 1800
 * deliberately, as a FOREIGN policy a client is free to make stricter. Both
 * choices are still right there.
 *
 * This file makes a different claim: not "our arithmetic is self-consistent" but
 * "the shipped client accepts what we emit". The first was true all through the
 * outage. Only the second would have caught it.
 *
 * ## What it does NOT do
 *
 * It does not pin the SDK's constants — importing them to assert against them
 * would be the same circularity as before, one repository further out. It calls
 * the gate and lets the gate decide. If a future `@arkade-os/swap` tightens its
 * requirement, this file goes red on the version bump, which is the entire
 * point: that is the conversation happening at upgrade time instead of in
 * production.
 */

import { describe, it, expect } from 'vitest'
import { assertReceivable, assertFundable } from '@arkade-os/swap'
import type { RfqQuote } from '@arkade-os/swap'
import { lightningReceiveRfqQuotePayload } from '@arkade-os/solver-corridors/wire/lightningReceivePayloads.js'
import { rfqQuotePayload } from '@arkade-os/solver-corridors/wire/payloads.js'
import { DEFAULT_HOLD_INVOICE_WINDOW } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { MAX_REFUND_HORIZON } from '@arkade-os/solver-core/core/receive.js'
import {
  evaluateSendAcceptance,
  refundLocktimeFor,
  ROUTE_CLTV_BUDGET_BLOCKS,
  UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS,
  MIN_INVOICE_WINDOW,
} from '@arkade-os/solver-core/core/send.js'
import type { ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import type { SendSwapRow } from '@arkade-os/solver-corridors/db/swaps.js'

/** A fixed clock, so a deadline is a number rather than a race. */
const NOW = 1_800_000_000

/** Shape-only filler. No gate below reads these for anything but presence. */
const SOLVER_PUBKEY = 'a'.repeat(64)
const PAYMENT_HASH = 'b'.repeat(64)
const LOCKUP_ADDRESS = 'tark1qexamplelockupaddressforgatetests'

/**
 * A real regtest BOLT11, because `rfqQuotePayload` DECODES it to derive
 * `to_amount` — the send payload cannot be built from a placeholder. Same
 * invoice `test/invoice/decode.test.ts` uses; 21u = 2100 sats.
 */
const INVOICE =
  'lnbcrt21u1p5tqtaypp56yzglgfgwsm5pd49996jqvtmpf8fqdk7cq2znnjw5c2j5t8ua38qdql2djkuepqw3hjqs2jfvsxzerywfjhxuccqz95xqztfsp586s5vpsdxt05rm7hr6ycwq5ffmnx2gngv820seugky6j6z2wxqwq9qxpqysgqepuxr82pvlp8lgj7nqu8yp2f5q32323jxddx9qgtjhfhsyzvftgkwx8qv4772fzz46pwyw5ex3u7lf7na8a8403ur3gyeu22gv29rpspefzz2y'

/**
 * The receive quote this solver emits, built through the REAL wire builder.
 *
 * `refundLocktime` and `validUntil` are computed exactly as
 * `ReceiveSwapService.quote` computes them — `now + MAX_REFUND_HORIZON` and
 * `now + DEFAULT_HOLD_INVOICE_WINDOW`. `holdWindow` is a parameter only so the
 * control below can reproduce the shipped-and-broken value; every other caller
 * takes the default and therefore takes production's own derivation.
 */
const receiveQuote = (holdWindow: number = DEFAULT_HOLD_INVOICE_WINDOW): RfqQuote =>
  lightningReceiveRfqQuotePayload(
    {
      amountSats: 100_000,
      payoutSats: 99_500,
      solverPubkey: SOLVER_PUBKEY,
      refundLocktime: NOW + MAX_REFUND_HORIZON,
      paymentHash: PAYMENT_HASH,
      invoice: INVOICE,
      lockupAddress: LOCKUP_ADDRESS,
      solverRefundPkScript: '5120' + 'c'.repeat(64),
    } as unknown as ReceiveSwapRow,
    NOW + holdWindow,
    'rfq-receive',
  ) as unknown as RfqQuote

/**
 * The last moment a payer can arm the swap, as the CLIENT computes it:
 * `min(invoice expiry, valid_until)`. Both derive from the same constant here,
 * which is exactly the asymmetry `orchestrator.ts` documents — a backend that
 * shortens the invoice only widens the solver's race.
 */
const payDeadlineFor = (holdWindow: number): number => NOW + holdWindow

describe('the shipped client accepts our lightning RECEIVE quote', () => {
  it('passes assertReceivable, the gate that refused every quote during the outage', () => {
    expect(() =>
      assertReceivable({ quote: receiveQuote(), payDeadline: payDeadlineFor(DEFAULT_HOLD_INVOICE_WINDOW), now: NOW }),
    ).not.toThrow()
  })

  /**
   * THE CONTROL, and the reason to trust the assertion above.
   *
   * 5700 is the value that actually shipped and actually broke the corridor: a
   * 95-minute hold window against a 2-hour horizon leaves a 1500s claim race,
   * under the 1800s the client requires. If this test ever stops throwing, the
   * gate has gone inert — someone stubbed it, the import resolved to nothing, or
   * the package changed shape — and the passing test above would be worthless
   * without this one failing.
   */
  it('REFUSES the window that shipped, so we know the gate is live', () => {
    const broken = 95 * 60
    expect(() =>
      assertReceivable({ quote: receiveQuote(broken), payDeadline: payDeadlineFor(broken), now: NOW }),
    ).toThrow()
  })

  it('names the refusal the operator saw, not merely some error', () => {
    // The specific string mutinynet reported. A bare `toThrow()` above would
    // pass on a TypeError from a malformed fixture and prove nothing.
    const broken = 95 * 60
    try {
      assertReceivable({ quote: receiveQuote(broken), payDeadline: payDeadlineFor(broken), now: NOW })
      expect.unreachable('the broken window must be refused')
    } catch (error) {
      expect((error as { reason?: string }).reason).toBe('claim_window_too_short')
    }
  })

  it('still passes when the client checks at the last instant the quote is live', () => {
    // The worst case the gate is written against, not a comfortable midpoint.
    //
    // `now` is one second BEFORE `valid_until`, not equal to it: at
    // `now === valid_until` the quote has expired and the gate refuses with
    // `quote_expired` — correctly, and for an unrelated reason. Writing it the
    // obvious way made this test pass for the wrong reason on the first run,
    // which is worth leaving a note about rather than silently fixing.
    //
    // The claim race is measured from `payDeadline` regardless of when the
    // client checks, so moving `now` cannot rescue a window that is too narrow.
    const payDeadline = payDeadlineFor(DEFAULT_HOLD_INVOICE_WINDOW)
    expect(() => assertReceivable({ quote: receiveQuote(), payDeadline, now: payDeadline - 1 })).not.toThrow()
  })
})

describe('the shipped client accepts our lightning SEND quote', () => {
  /**
   * The send leg's gate is `assertFundable`, not `assertReceivable` — the two
   * are not interchangeable and the SDK says so: `refund_locktime` is the
   * SOLVER's on the receive corridors, so `MIN_HEADROOM_SECONDS` would gate the
   * wrong side there. On this leg it is the CLIENT's own refund and the headroom
   * check is the right one.
   */
  // The deadline this solver really quotes: the same `refundLocktimeFor` the
  // send orchestrator calls, against an ordinary invoice's CLTV terms (LND's
  // own default final delta, no route hints) and this backend's route budget.
  // Derived rather than typed so a change to the margin moves the fixture.
  const ORDINARY_LOCKTIME = refundLocktimeFor(
    {
      minFinalCltvBlocks: 40,
      worstRouteHintCltvBlocks: 0,
      bestRouteHintCltvBlocks: 0,
      routeCltvBudgetBlocks: ROUTE_CLTV_BUDGET_BLOCKS,
      enforcesRouteCltv: true,
    },
    0,
    NOW,
  )

  const sendQuote = (refundLocktime = ORDINARY_LOCKTIME): RfqQuote =>
    rfqQuotePayload(
      {
        amountSats: 2_100,
        invoice: INVOICE,
        receiverPubkey: SOLVER_PUBKEY,
        refundLocktime,
        paymentHash: PAYMENT_HASH,
        lockupAddress: LOCKUP_ADDRESS,
        receiverPkScript: null,
      } as unknown as SendSwapRow,
      NOW + 15 * 60,
      'rfq-send',
    ) as unknown as RfqQuote

  it('passes assertFundable at quote time', () => {
    expect(() => assertFundable({ quote: sendQuote(), invoiceExpiresAt: NOW + 15 * 60, now: NOW })).not.toThrow()
  })

  it('passes at the end of the funding window, not just the start', () => {
    // A client funding at the last moment still has to clear the headroom check
    // against `refund_locktime`, which does not move as `now` advances.
    //
    // The last fundable moment is `invoiceExpiresAt - MIN_INVOICE_WINDOW`, not
    // `invoiceExpiresAt` — at the expiry itself the gate refuses with `invoice
    // expired`, which is the invoice's clock rather than the money's. Expressed
    // through our own bound so the two cannot disagree about when funding stops.
    const invoiceExpiresAt = NOW + 15 * 60
    const last = invoiceExpiresAt - MIN_INVOICE_WINDOW
    expect(() => assertFundable({ quote: sendQuote(), invoiceExpiresAt, now: last })).not.toThrow()
  })

  /**
   * The Wallet of Satoshi shape — hints of [40] and [40000] — through the gate
   * that decides which of the two a deployment is bound by.
   *
   * Worth an interop test rather than only a unit one because the enforcing
   * answer is the whole point of the change: the client has to accept the quote
   * it now gets. And the non-enforcing answer is the reason the gate refuses
   * instead of quoting — a deadline a client would technically accept while
   * having its funds behind a ten-month clock is not a better outcome than a
   * refusal.
   */
  describe('an invoice whose bad route hint is one alternative among several', () => {
    const badAlternate = (enforcesRouteCltv: boolean) =>
      evaluateSendAcceptance({
        now: NOW,
        invoiceExpiresAt: NOW + 15 * 60,
        invoiceAmountSats: 2_100,
        invoiceNetwork: 'bc',
        providerNetwork: 'bc',
        limits: { minSats: 1_000, maxSats: 1_000_000 },
        minFinalCltvBlocks: 60,
        worstRouteHintCltvBlocks: 40_000,
        bestRouteHintCltvBlocks: 40,
        routeCltvBudgetBlocks: enforcesRouteCltv ? ROUTE_CLTV_BUDGET_BLOCKS : UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS,
        enforcesRouteCltv,
        unilateralClaimDelay: 0,
      })

    it('is quoted on an enforcing rail, at a deadline the shipped client accepts', () => {
      const quoted = badAlternate(true)
      if (!quoted.accept) throw new Error(`expected an accepted quote, got ${quoted.reason}`)
      // Sized off the 40, not the 40000 — within a couple of days of an
      // ordinary quote rather than ten months past it.
      expect(quoted.refundLocktime - ORDINARY_LOCKTIME).toBeLessThan(2 * 24 * 3600)
      expect(() =>
        assertFundable({ quote: sendQuote(quoted.refundLocktime), invoiceExpiresAt: NOW + 15 * 60, now: NOW }),
      ).not.toThrow()
    })

    it('never reaches a client at all on a rail that cannot cap the route', () => {
      expect(badAlternate(false)).toMatchObject({ accept: false, reason: 'cltv_too_large' })
    })
  })
})
