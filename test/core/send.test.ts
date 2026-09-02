import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LOCKUP_TIMEOUT,
  evaluateCouplingDeadlines,
  evaluateSendAcceptance,
  evaluateSendPayment,
  MIN_CLAIM_WINDOW,
  MIN_INVOICE_WINDOW,
  payableCltvBlocks,
  refundLocktimeFor,
  REFUND_SAFETY_MARGIN,
  ROUTE_CLTV_BUDGET_BLOCKS,
  UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS,
  SECONDS_PER_BLOCK,
  worstCaseHtlcBlocks,
  hintCltvBlocks,
  deadlineContainsHtlc,
  type SendAcceptanceInput,
  type SendPaymentInput,
} from '@arkade-os/solver-core/core/send.js'
import { MAX_CLIENT_CLTV_BLOCKS } from '@arkade-os/solver-core/invoice/decode.js'

/**
 * The CLTV terms, with no route hint and an enforcing backend unless stated.
 *
 * One hint argument, applied to BOTH totals: every case here is about the
 * selected value, and the selection itself (`hintCltvBlocks`) is pinned in
 * `test/core/send.test.ts`.
 */
const cltvOf = (
  minFinalCltvBlocks: number,
  routeHintCltvBlocks = 0,
  routeCltvBudgetBlocks = ROUTE_CLTV_BUDGET_BLOCKS,
  enforcesRouteCltv = true,
) => ({
  minFinalCltvBlocks,
  worstRouteHintCltvBlocks: routeHintCltvBlocks,
  bestRouteHintCltvBlocks: routeHintCltvBlocks,
  routeCltvBudgetBlocks,
  enforcesRouteCltv,
})

const NOW = 1_800_000_000

const acceptance = (over: Partial<SendAcceptanceInput> = {}): SendAcceptanceInput => ({
  now: NOW,
  // Long enough for the whole `DEFAULT_LOCKUP_TIMEOUT` funding window; the
  // short-invoice cases, where the window is clipped, are asserted below.
  invoiceExpiresAt: NOW + 4 * 3600,
  invoiceAmountSats: 50_000,
  invoiceNetwork: 'bcrt',
  providerNetwork: 'bcrt',
  limits: { minSats: 1_000, maxSats: 1_000_000 },
  minFinalCltvBlocks: 18,
  worstRouteHintCltvBlocks: 0,
  bestRouteHintCltvBlocks: 0,
  routeCltvBudgetBlocks: ROUTE_CLTV_BUDGET_BLOCKS,
  enforcesRouteCltv: true,
  unilateralClaimDelay: 4096,
  ...over,
})

const payment = (over: Partial<SendPaymentInput> = {}): SendPaymentInput => ({
  now: NOW,
  invoiceExpiresAt: NOW + 3600,
  // What `refundLocktimeFor` actually produces for this invoice, not a round
  // number: its floor is `worstCaseHtlcBlocks * SECONDS_PER_BLOCK +
  // REFUND_SAFETY_MARGIN` (77h at a final delta of 18), so the 2h this fixture
  // used to carry was a deadline the quote path could never have issued — and
  // one no CLTV budget fits inside.
  refundLocktime: refundLocktimeFor(cltvOf(18), 4096, NOW),
  minFinalCltvBlocks: 18,
  worstRouteHintCltvBlocks: 0,
  bestRouteHintCltvBlocks: 0,
  routeCltvBudgetBlocks: ROUTE_CLTV_BUDGET_BLOCKS,
  enforcesRouteCltv: true,
  lockedSats: 50_000,
  expectedSats: 50_000,
  ...over,
})

describe('evaluateSendAcceptance', () => {
  it('accepts a live, in-range invoice on the right network', () => {
    expect(evaluateSendAcceptance(acceptance())).toEqual({
      accept: true,
      refundLocktime: expect.any(Number),
      lockupDeadline: expect.any(Number),
    })
  })

  it('refuses an invoice for another network', () => {
    expect(evaluateSendAcceptance(acceptance({ invoiceNetwork: 'bc' }))).toEqual({
      accept: false,
      reason: 'wrong_network',
    })
  })

  it('refuses a zero-amount invoice', () => {
    expect(evaluateSendAcceptance(acceptance({ invoiceAmountSats: 0 }))).toEqual({
      accept: false,
      reason: 'zero_amount_invoice',
    })
  })

  it.each([
    ['below the minimum', 999],
    ['above the maximum', 1_000_001],
  ])('refuses an amount %s', (_label, invoiceAmountSats) => {
    expect(evaluateSendAcceptance(acceptance({ invoiceAmountSats }))).toEqual({
      accept: false,
      reason: 'amount_out_of_range',
    })
  })

  it.each([
    ['at the boundary', 1_000],
    ['at the maximum', 1_000_000],
  ])('accepts an amount %s', (_label, invoiceAmountSats) => {
    expect(evaluateSendAcceptance(acceptance({ invoiceAmountSats })).accept).toBe(true)
  })

  it('refuses an already expired invoice', () => {
    expect(evaluateSendAcceptance(acceptance({ invoiceExpiresAt: NOW })).accept).toBe(false)
    expect(evaluateSendAcceptance(acceptance({ invoiceExpiresAt: NOW - 1 }))).toEqual({
      accept: false,
      reason: 'invoice_expired',
    })
  })

  it('refuses only once no fundable window is left at all', () => {
    // The floor is exactly `MIN_INVOICE_WINDOW`, and it is reached rather than
    // chosen: below it the funding window computed for the quote has already
    // closed, so there is genuinely nothing to offer.
    expect(evaluateSendAcceptance(acceptance({ invoiceExpiresAt: NOW + MIN_INVOICE_WINDOW }))).toEqual({
      accept: false,
      reason: 'invoice_expires_too_soon',
    })
    expect(evaluateSendAcceptance(acceptance({ invoiceExpiresAt: NOW + MIN_INVOICE_WINDOW + 1 })).accept).toBe(true)
  })

  it("accepts BOLT11's own default one-hour expiry", () => {
    // `src/invoice/decode.ts` applies 3600s to any invoice carrying no `x` tag,
    // so a floor above an hour refuses the most ordinary invoice there is.
    expect(evaluateSendAcceptance(acceptance({ invoiceExpiresAt: NOW + 3600 })).accept).toBe(true)
  })

  it('leaves the whole funding window on an invoice with room for it', () => {
    const quoted = evaluateSendAcceptance(acceptance())
    if (!quoted.accept) throw new Error(`expected an accepted quote, got ${quoted.reason}`)
    expect(quoted.lockupDeadline).toBe(NOW + DEFAULT_LOCKUP_TIMEOUT)
  })

  it('takes the funding window from a configured lockupTimeout', () => {
    expect(evaluateSendAcceptance(acceptance({ lockupTimeout: 300 }))).toEqual({
      accept: true,
      refundLocktime: expect.any(Number),
      lockupDeadline: NOW + 300,
    })
  })

  it('fits the funding window to a short invoice instead of refusing it', () => {
    // A quarter-hour invoice — BTCPay Server's default, and under the 17 min a
    // fixed `lockupTimeout + MIN_INVOICE_WINDOW` floor demanded. Nothing about a
    // short invoice is unsafe: `refundLocktime` is derived from the payee's CLTV
    // delta, never from the invoice clock.
    const invoiceExpiresAt = NOW + 15 * 60
    const quoted = evaluateSendAcceptance(acceptance({ invoiceExpiresAt }))
    if (!quoted.accept) throw new Error(`expected an accepted quote, got ${quoted.reason}`)
    expect(quoted.lockupDeadline).toBe(invoiceExpiresAt - MIN_INVOICE_WINDOW)
  })

  it('lets whichever of the invoice and the configured timeout binds first win', () => {
    // Both terms are live at once, so neither may be dropped: a ten-minute
    // invoice under the default 15-minute window is clipped by the INVOICE...
    expect(evaluateSendAcceptance(acceptance({ invoiceExpiresAt: NOW + 600 }))).toMatchObject({
      accept: true,
      lockupDeadline: NOW + 600 - MIN_INVOICE_WINDOW,
    })
    // ...while the same invoice under a five-minute window is clipped by the
    // TIMEOUT. Before this, the first case was refused outright.
    expect(evaluateSendAcceptance(acceptance({ invoiceExpiresAt: NOW + 600, lockupTimeout: 300 }))).toMatchObject({
      accept: true,
      lockupDeadline: NOW + 300,
    })
  })

  it.each([
    ['a three-minute invoice', 3 * 60],
    ['a quarter-hour invoice', 15 * 60],
    ['an invoice at the old fixed floor', 17 * 60],
    ['an hour-long invoice', 3600],
  ])('keeps %s payable at its own funding deadline', (_label, life) => {
    // The property the funding window exists for, and the reason shortening it is
    // safe: whatever we accept, a client funding at the deadline we quoted is
    // never then refused for expiry. Previously this held only above a fixed
    // floor; now it holds for every invoice we accept.
    const invoiceExpiresAt = NOW + life
    const quoted = evaluateSendAcceptance(acceptance({ invoiceExpiresAt }))
    if (!quoted.accept) throw new Error(`expected an accepted quote, got ${quoted.reason}`)
    expect(
      evaluateSendPayment(
        payment({ invoiceExpiresAt, refundLocktime: quoted.refundLocktime, now: quoted.lockupDeadline }),
      ),
    ).toEqual({ pay: true })
  })
})

describe('evaluateSendPayment', () => {
  it('pays when funded, live and well clear of the refund path', () => {
    expect(evaluateSendPayment(payment())).toEqual({ pay: true })
  })

  it('refuses to pay against an expired invoice', () => {
    // The gate that matters: quoting and funding are minutes apart, so an invoice
    // that was live at quote time can be dead by the time funds arrive.
    expect(evaluateSendPayment(payment({ invoiceExpiresAt: NOW }))).toEqual({
      pay: false,
      reason: 'invoice_expired',
    })
    expect(evaluateSendPayment(payment({ invoiceExpiresAt: NOW - 1 })).pay).toBe(false)
  })

  it('refuses when the invoice is about to lapse mid-attempt', () => {
    expect(evaluateSendPayment(payment({ invoiceExpiresAt: NOW + MIN_INVOICE_WINDOW - 1 }))).toEqual({
      pay: false,
      reason: 'invoice_expires_too_soon',
    })
  })

  it('refuses once the refund path is close enough to race the claim', () => {
    expect(evaluateSendPayment(payment({ refundLocktime: NOW + MIN_CLAIM_WINDOW - 1 }))).toEqual({
      pay: false,
      reason: 'claim_window_too_short',
    })
  })

  it('refuses at the claim window boundary too, because no CLTV budget fits there', () => {
    // This asserted `pay: true` while the CLTV ceiling was a fixed delta that
    // never consulted the deadline. Clearing `MIN_CLAIM_WINDOW` is necessary and
    // NOT sufficient: 90 minutes cannot contain an HTLC the payee may hold for
    // `minFinalCltvBlocks` alone, so paying here is precisely the case where the
    // outbound HTLC outlives the client's refund.
    expect(evaluateSendPayment(payment({ refundLocktime: NOW + MIN_CLAIM_WINDOW }))).toEqual({
      pay: false,
      reason: 'cltv_budget_too_short',
    })
  })

  it('refuses a short lockup', () => {
    expect(evaluateSendPayment(payment({ lockedSats: 49_999 }))).toEqual({
      pay: false,
      reason: 'lockup_insufficient',
    })
  })

  it('accepts an overpaid lockup', () => {
    expect(evaluateSendPayment(payment({ lockedSats: 50_001 })).pay).toBe(true)
  })

  it('refuses once the deadline cannot cover the payee’s own final delta', () => {
    // The budget has to hold `minFinalCltvBlocks` plus room to route. At exactly
    // the payee's delta there is none, so this is refused rather than attempted.
    const refundLocktime = NOW + REFUND_SAFETY_MARGIN + 18 * SECONDS_PER_BLOCK
    expect(evaluateSendPayment(payment({ refundLocktime, minFinalCltvBlocks: 18 }))).toEqual({
      pay: false,
      reason: 'cltv_budget_too_short',
    })
    expect(evaluateSendPayment(payment({ refundLocktime: refundLocktime + SECONDS_PER_BLOCK })).pay).toBe(true)
  })
})

describe('payableCltvBlocks', () => {
  it('gives the whole route budget when the deadline is far off', () => {
    // Nothing to clamp: the client funded promptly, so the deadline still has
    // the room it was quoted with and the route budget is the binding term.
    const refundLocktime = refundLocktimeFor(cltvOf(18), 4096, NOW)
    expect(payableCltvBlocks(cltvOf(18), refundLocktime, NOW)).toBe(worstCaseHtlcBlocks(cltvOf(18)))
  })

  it('clamps to the deadline once time has been spent funding', () => {
    // THE regression this exists for. `refundLocktime` is absolute and fixed at
    // quote time, while the ceiling handed to the backend is a delta from the
    // moment of PAYMENT — so every second spent funding has to come off the
    // ceiling, or the HTLC may outlive the deadline it was sized against.
    const quotedAt = NOW
    const refundLocktime = refundLocktimeFor(cltvOf(18), 4096, quotedAt)
    const paidAt = quotedAt + 4 * 3600

    const blocks = payableCltvBlocks(cltvOf(18), refundLocktime, paidAt)
    expect(blocks).toBeLessThan(worstCaseHtlcBlocks(cltvOf(18)))
    // The property, stated directly: an HTLC living the full ceiling still
    // resolves a safety margin before the client may refund.
    expect(paidAt + blocks * SECONDS_PER_BLOCK + REFUND_SAFETY_MARGIN).toBeLessThanOrEqual(refundLocktime)
  })

  it.each([0.25, 1, 4, 12, 48])('keeps the HTLC inside the deadline after %sh of funding delay', (hours) => {
    // The whole table that was unsafe before, as a property rather than four
    // separate cases: whatever the funding delay, either we refuse or the
    // ceiling we would pay with cannot outlive the refund.
    const quotedAt = NOW
    const refundLocktime = refundLocktimeFor(cltvOf(18), 4096, quotedAt)
    const paidAt = quotedAt + Math.round(hours * 3600)

    const decision = evaluateSendPayment(
      payment({ refundLocktime, minFinalCltvBlocks: 18, now: paidAt, invoiceExpiresAt: paidAt + 3600 }),
    )
    if (!decision.pay) return
    const blocks = payableCltvBlocks(cltvOf(18), refundLocktime, paidAt)
    expect(paidAt + blocks * SECONDS_PER_BLOCK).toBeLessThanOrEqual(refundLocktime)
  })

  it('checks funding before invoice liveness so an unfunded swap never reports expiry', () => {
    // An unfunded swap is not the invoice's fault; reporting 'invoice_expired'
    // would send the client down the wrong recovery path.
    expect(evaluateSendPayment(payment({ lockedSats: 0, invoiceExpiresAt: NOW - 1 }))).toEqual({
      pay: false,
      reason: 'lockup_insufficient',
    })
  })
})

/**
 * The self-payment refresh: a client quotes lightning:BTC->arkade:BTC, then
 * arkade:BTC->lightning:BTC against that same bolt11. No Lightning payment can
 * occur — one node cannot pay its own invoice — so the two swaps are coupled
 * and short-circuited internally, and one client ends up holding both sides.
 */
describe('evaluateCouplingDeadlines', () => {
  it('couples when the send refund opens a full claim window after the receive refund', () => {
    expect(
      evaluateCouplingDeadlines({
        receiveRefundLocktime: NOW,
        sendRefundLocktime: NOW + MIN_CLAIM_WINDOW,
      }),
    ).toEqual({ couple: true })
  })

  it('refuses when the send refund opens before the receive refund', () => {
    // The theft this exists to stop: refund the send lockup the moment Ds
    // opens, and only THEN claim the receive payout, still before Dr.
    expect(
      evaluateCouplingDeadlines({
        receiveRefundLocktime: NOW,
        sendRefundLocktime: NOW - 1,
      }),
    ).toEqual({ couple: false, reason: 'coupled_deadline_unsafe' })
  })

  it('refuses a margin one second short of a full claim window', () => {
    expect(
      evaluateCouplingDeadlines({
        receiveRefundLocktime: NOW,
        sendRefundLocktime: NOW + MIN_CLAIM_WINDOW - 1,
      }),
    ).toEqual({ couple: false, reason: 'coupled_deadline_unsafe' })
  })
})

describe('the route budget a backend can be trusted with', () => {
  const CLAIM_DELAY = 4096

  it('quotes a later deadline on a backend that cannot enforce the ceiling', () => {
    // The whole point of asking the backend rather than assuming. Same invoice,
    // same everything else: only the trust in the rail differs, and the deadline
    // has to absorb that difference because nothing downstream can.
    const enforced = refundLocktimeFor(cltvOf(18, 0, ROUTE_CLTV_BUDGET_BLOCKS), CLAIM_DELAY, NOW)
    const unenforced = refundLocktimeFor(cltvOf(18, 0, UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS), CLAIM_DELAY, NOW)

    expect(unenforced).toBeGreaterThan(enforced)
    expect(unenforced - enforced).toBe(
      (UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS - ROUTE_CLTV_BUDGET_BLOCKS) * SECONDS_PER_BLOCK,
    )
  })

  it('bounds an unenforceable route by what the network itself permits', () => {
    // 2016 is LND's default `--max-cltv-expiry`, the ceiling a sending node
    // applies. On a rail we cannot cap, the deadline has to outlast that rather
    // than outlast a typical route.
    expect(UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS).toBe(2016)
    expect(UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS).toBeGreaterThan(ROUTE_CLTV_BUDGET_BLOCKS)
  })

  it('carries the invoice-dictated CLTV into the deadline on both', () => {
    // A route hint is CLTV the INVOICE WRITER chose, so it has to move the
    // deadline on every backend — capping the route does not cap the payee.
    for (const budget of [ROUTE_CLTV_BUDGET_BLOCKS, UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS]) {
      const without = refundLocktimeFor(cltvOf(18, 0, budget), CLAIM_DELAY, NOW)
      const withHint = refundLocktimeFor(cltvOf(18, 60, budget), CLAIM_DELAY, NOW)
      expect(withHint - without).toBe(60 * SECONDS_PER_BLOCK)
    }
  })
})

/**
 * The route-hint policy, which is one decision made in one place.
 *
 * A Wallet of Satoshi invoice carries hints of [40] and [40000]: the payer
 * picks one, and every real payer picks the 40. `decodeInvoice`'s floor lets it
 * past (final + BEST is ordinary); what happens next depends entirely on
 * whether the rail can decline the bad route.
 */
describe('the route hint a deployment is actually bound by', () => {
  /** The WoS shape, both totals raw and un-selected as the gates require. */
  const badAlternate = { minFinalCltvBlocks: 60, worstRouteHintCltvBlocks: 40_000, bestRouteHintCltvBlocks: 40 }

  it('selects the best hint on a rail that caps the route, the worst where none can', () => {
    const cltv = { ...badAlternate, routeCltvBudgetBlocks: ROUTE_CLTV_BUDGET_BLOCKS, enforcesRouteCltv: true }
    expect(hintCltvBlocks(cltv)).toBe(40)
    expect(hintCltvBlocks({ ...cltv, enforcesRouteCltv: false })).toBe(40_000)
  })

  it('quotes the same invoice on LND and refuses it on a rail that cannot cap', () => {
    // The decision, stated once: same invoice, same everything else, only the
    // rail differs. LND declines a route over `max_timeout_height` rather than
    // taking it, so a bad alternative costs a refused payment; a rail that caps
    // nothing takes whatever the network chose, so it costs an HTLC outliving
    // the refund.
    expect(evaluateSendAcceptance(acceptance({ ...badAlternate, enforcesRouteCltv: true }))).toMatchObject({
      accept: true,
    })
    expect(
      evaluateSendAcceptance(
        acceptance({
          ...badAlternate,
          enforcesRouteCltv: false,
          routeCltvBudgetBlocks: UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS,
        }),
      ),
    ).toEqual({ accept: false, reason: 'cltv_too_large', detail: expect.stringContaining('worst-hint rule') })
  })

  it('refuses before a deadline is computed, rather than quoting a ten-month one', () => {
    // The regression this gate exists for. Deleting the decode-time bound and
    // adding nothing here accepts the WoS shape on an uncapped rail with `htlcBound = now
    // + (60 + 40000 + 2016)` blocks — a ~292-day refund clock. The invariant
    // survives (the deadline still outlasts the HTLC); the quote is useless.
    const decision = evaluateSendAcceptance(
      acceptance({
        ...badAlternate,
        enforcesRouteCltv: false,
        routeCltvBudgetBlocks: UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS,
      }),
    )
    expect(decision).not.toHaveProperty('refundLocktime')
  })

  it('sizes the deadline off the hint it selected, not the other one', () => {
    const deadline = (enforcesRouteCltv: boolean) =>
      refundLocktimeFor({ ...badAlternate, routeCltvBudgetBlocks: ROUTE_CLTV_BUDGET_BLOCKS, enforcesRouteCltv }, 0, NOW)
    // Two terms, not one. The hint is what this test is about; the funding
    // window is reserved on top wherever the rail cannot cap, because there
    // nothing shortens the ceiling as funding drags — see `refundLocktimeFor`.
    expect(deadline(false) - deadline(true)).toBe((40_000 - 40) * SECONDS_PER_BLOCK + DEFAULT_LOCKUP_TIMEOUT)
  })

  it('holds the pay-time budget to the same selection as the deadline', () => {
    // The two consumers `worstCaseHtlcBlocks` exists to keep in agreement. A
    // deadline sized on best while the budget check read worst would refuse
    // every payment the quote path just accepted.
    const cltv = { ...badAlternate, routeCltvBudgetBlocks: ROUTE_CLTV_BUDGET_BLOCKS, enforcesRouteCltv: true }
    expect(evaluateSendPayment(payment({ ...cltv, refundLocktime: refundLocktimeFor(cltv, 0, NOW) }))).toEqual({
      pay: true,
    })
  })

  it('refuses a rail change on the budget gate when the payee alone outruns the deadline', () => {
    // `refundLocktime` is stored; `enforcesRouteCltv` is read live. On THIS
    // shape the budget gate settles it on its own: re-selecting the worst hint
    // puts the payee's own floor (60 + 40000) past what is left of an
    // LND-sized deadline, so the ceiling check refuses before anything asks
    // about the route.
    //
    // Pinned as the narrow property it is. The gate that closes the rail change
    // in general is the deadline-containment one below — this shape reaching
    // `cltv_budget_too_short` is what made the hole there look covered.
    const quoted = refundLocktimeFor(
      { ...badAlternate, routeCltvBudgetBlocks: ROUTE_CLTV_BUDGET_BLOCKS, enforcesRouteCltv: true },
      0,
      NOW,
    )
    expect(
      evaluateSendPayment(
        payment({
          ...badAlternate,
          refundLocktime: quoted,
          routeCltvBudgetBlocks: UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS,
          enforcesRouteCltv: false,
        }),
      ),
    ).toEqual({ pay: false, reason: 'cltv_budget_too_short' })
  })

  it('leaves an invoice whose every hint is bad to the decode floor', () => {
    // Nothing to steer to, so the gate here is not what refuses it — the floor
    // is, on every deployment. Pinned so the two bounds are not confused: this
    // shape never reaches the gate at all.
    expect(60 + 40_000).toBeGreaterThan(MAX_CLIENT_CLTV_BLOCKS)
    expect(
      evaluateSendAcceptance(
        acceptance({ minFinalCltvBlocks: 60, worstRouteHintCltvBlocks: 40_000, bestRouteHintCltvBlocks: 40_000 }),
      ),
    ).toMatchObject({ accept: true })
  })
})

/**
 * The deadline a row already carries, against the rail now paying it.
 *
 * `payableCltvBlocks` answers "what ceiling may this payment carry", which is a
 * question only an enforcing rail acts on. These cover the other one:
 * `deadlineContainsHtlc`, which asks whether the stored deadline can still hold
 * the whole worst case — the only thing that binds where the ceiling is dropped.
 */
describe('a deadline sized for one rail, against the rail actually paying', () => {
  /**
   * An ordinary bad alternate, not the WoS extreme: 60 + 800 is well past
   * MAX_CLIENT_CLTV_BLOCKS (so no uncapped deployment would QUOTE it) yet far
   * inside a mainnet deadline (so the budget gate has no complaint).
   */
  const ordinary = { minFinalCltvBlocks: 60, worstRouteHintCltvBlocks: 800, bestRouteHintCltvBlocks: 40 }
  const onLnd = { ...ordinary, routeCltvBudgetBlocks: ROUTE_CLTV_BUDGET_BLOCKS, enforcesRouteCltv: true }
  const onNoCap = { ...ordinary, routeCltvBudgetBlocks: UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS, enforcesRouteCltv: false }

  /** Mainnet's exit delay, which is what makes the unilateral bound the binding one. */
  const SEVEN_DAYS = 7 * 24 * 3600

  /** Paying `after` seconds past the quote, with an invoice still live then. */
  const payingAt = (after: number, over: Partial<SendPaymentInput>) =>
    payment({ now: NOW + after, invoiceExpiresAt: NOW + after + 3600, ...over })

  it('holds at the worst case PLUS the claim margin, and nowhere short of it', () => {
    // The margin is part of what must fit, not slack above it. A deadline that
    // merely reaches the end of the HTLC leaves zero time to claim the lockup
    // after the preimage arrives, which is the double-collect window itself.
    const need = worstCaseHtlcBlocks(onNoCap) * SECONDS_PER_BLOCK + REFUND_SAFETY_MARGIN
    expect(deadlineContainsHtlc(onNoCap, NOW + need, NOW)).toBe(true)
    expect(deadlineContainsHtlc(onNoCap, NOW + need - 1, NOW)).toBe(false)
  })

  it('refuses an LND-quoted row paid on an uncapped rail, which the budget gate lets through', () => {
    // The regression. The deadline here is set by the seven-day unilateral
    // bound, not by the HTLC bound, so it is nowhere near the ~20 days an
    // uncapped route may reach — yet it comfortably clears the payee's own
    // floor, which is all the budget gate ever asked.
    const quoted = refundLocktimeFor(onLnd, SEVEN_DAYS, NOW)

    // Stated as an assertion rather than a comment: the old gate is satisfied.
    expect(payableCltvBlocks(onNoCap, quoted, NOW)).toBeGreaterThan(
      ordinary.minFinalCltvBlocks + ordinary.worstRouteHintCltvBlocks,
    )
    // And the deadline is nonetheless short of what that rail may build.
    expect(payableCltvBlocks(onNoCap, quoted, NOW)).toBeLessThan(worstCaseHtlcBlocks(onNoCap))

    expect(evaluateSendPayment(payment({ ...onNoCap, refundLocktime: quoted }))).toEqual({
      pay: false,
      reason: 'uncapped_route_deadline_too_short',
    })
  })

  it('agrees with the quote gate that would have refused the same invoice', () => {
    // The contradiction the gate above removes. `evaluateSendAcceptance`
    // refuses this invoice outright on an uncapped rail; before, the pay path would pay
    // the very same invoice on the very same rail.
    expect(
      evaluateSendAcceptance(acceptance({ ...ordinary, ...onNoCap, unilateralClaimDelay: SEVEN_DAYS })),
    ).toMatchObject({ reason: 'cltv_too_large' })
  })

  it('still pays an uncapped-rail-quoted row funded inside its window', () => {
    // The over-strictness guard. A gate demanding an unclamped budget against a
    // deadline that did NOT reserve the funding window would refuse every
    // payment not made in the same instant it was quoted; reserving it at quote
    // time is what makes the strict gate payable.
    const quoted = refundLocktimeFor(onNoCap, SEVEN_DAYS, NOW)
    expect(evaluateSendPayment(payingAt(DEFAULT_LOCKUP_TIMEOUT / 2, { ...onNoCap, refundLocktime: quoted }))).toEqual({
      pay: true,
    })
  })

  it('spends the funding window down to zero, and never the claim margin', () => {
    // Where the funding delay stops being free — the window the deadline
    // reserved, not the margin underneath it. Past that the deadline can no
    // longer hold the worst case AND the margin, which on a rail that caps
    // nothing is the whole guarantee. Reachable on the crash-recovery path,
    // where the gap between quoting and paying is unbounded.
    const quoted = refundLocktimeFor(onNoCap, SEVEN_DAYS, NOW)
    expect(evaluateSendPayment(payingAt(DEFAULT_LOCKUP_TIMEOUT, { ...onNoCap, refundLocktime: quoted }))).toEqual({
      pay: true,
    })
    expect(evaluateSendPayment(payingAt(DEFAULT_LOCKUP_TIMEOUT + 1, { ...onNoCap, refundLocktime: quoted }))).toEqual({
      pay: false,
      reason: 'uncapped_route_deadline_too_short',
    })
  })

  it('leaves a whole claim margin after the worst case whenever it says pay', () => {
    // The property the boundaries above are instances of, stated as the thing
    // that must be true rather than as a number — the same invariant
    // `test/send/orchestrator.test.ts` asserts for the ceiling handed to an
    // ENFORCING rail, held here by refusal because no ceiling is enforced.
    //
    // Zero slack is not a bound. `MIN_CLAIM_WINDOW` (90 min) is what an
    // observe-and-claim needs against a deadline maturing on median-time-past,
    // and REFUND_SAFETY_MARGIN (2h) covers it.
    const quoted = refundLocktimeFor(onNoCap, SEVEN_DAYS, NOW)
    for (const after of [0, 60, DEFAULT_LOCKUP_TIMEOUT / 2, DEFAULT_LOCKUP_TIMEOUT]) {
      expect(evaluateSendPayment(payingAt(after, { ...onNoCap, refundLocktime: quoted }))).toEqual({ pay: true })
      const htlcEnds = NOW + after + worstCaseHtlcBlocks(onNoCap) * SECONDS_PER_BLOCK
      expect(quoted - htlcEnds, `funded ${after}s after the quote`).toBeGreaterThanOrEqual(REFUND_SAFETY_MARGIN)
      expect(quoted - htlcEnds).toBeGreaterThanOrEqual(MIN_CLAIM_WINDOW)
    }
  })

  it('reserves the funding window at quote time only where the rail cannot cap', () => {
    // The other half of the fix, and where the cost is paid. An enforcing rail
    // needs nothing: `payableCltvBlocks` shortens its ceiling second for second
    // as funding drags, so the margin survives on its own.
    const window = 6 * 3600
    const reserved = (cltv: typeof onNoCap, lockupTimeout: number) =>
      refundLocktimeFor(cltv, 0, NOW, lockupTimeout) - refundLocktimeFor(cltv, 0, NOW, 0)
    expect(reserved(onNoCap, window)).toBe(window)
    expect(reserved(onLnd, window)).toBe(0)
  })

  it('leaves the reverse rail change alone', () => {
    // Uncapped-quoted, LND-paid: a ceiling that is now enforced, inside a deadline
    // sized for one that was not. Nothing to refuse.
    const quoted = refundLocktimeFor(onNoCap, SEVEN_DAYS, NOW)
    expect(evaluateSendPayment(payment({ ...onLnd, refundLocktime: quoted }))).toEqual({ pay: true })
  })

  it('does not ask the question of a rail that caps the route', () => {
    // A deadline too short to hold LND's own worst case still pays there,
    // because LND declines a route that no longer fits rather than taking it.
    // The gate is about the rail, not about the arithmetic.
    const short = NOW + 100_000
    expect(deadlineContainsHtlc(onLnd, short, NOW)).toBe(false)
    expect(evaluateSendPayment(payment({ ...onLnd, refundLocktime: short }))).toEqual({ pay: true })
  })
})
