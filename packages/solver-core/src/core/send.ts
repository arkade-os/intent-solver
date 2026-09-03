/**
 * Send leg: the user pays a Lightning invoice out of an Arkade balance.
 *
 * Order of events:
 *
 *  1. the client hands us a BOLT11 invoice
 *  2. we derive the swap script and quote a lockup address + refund deadline
 *  3. the client locks up the amount at that address
 *  4. we see the lockup, pay the invoice, and learn the preimage from paying it
 *  5. we claim the locked-up funds by revealing that preimage
 *
 * The provider is exposed at step 4: it pays out over Lightning before it has
 * claimed the Arkade side. Both gates below guard that moment.
 *
 * Note on hashing, because the two sides do not agree: a BOLT11 payment hash is
 * `sha256(P)`, while the swap script commits to `ripemd160(sha256(P))`. The script
 * hash is therefore derived from the invoice's payment hash directly, and this leg
 * never needs to see P until the payment itself yields it.
 */

import { HOUR, MINUTE, rawDelaySeconds } from './timelocks.js'
import { MAX_CLIENT_CLTV_BLOCKS } from '../invoice/decode.js'

/**
 * Time we insist on having left on the invoice before paying it.
 *
 * A payment attempt is not instantaneous — it may probe several routes. Paying an
 * invoice that lapses mid-attempt risks the payment being failed back after we
 * have already committed, so we decline rather than start a race we cannot win.
 */
export const MIN_INVOICE_WINDOW = 2 * MINUTE

/**
 * Minimum time that must remain before the user's refund path opens.
 *
 * Once the refund path is open the user can pull the locked-up funds back. If we
 * paid the invoice inside that window we could pay out over Lightning and then
 * lose the race to claim, so we stop paying well before it opens.
 *
 * 90 minutes, not less, because the deadline matures against MEDIAN-TIME-PAST
 * (BIP-113), which lags wall clock by roughly an hour on mainnet — a wall-clock
 * margin smaller than the MTP lag is no margin at all. The same figure is the
 * client-side funding gate ("deadline headroom >= 90 min").
 */
export const MIN_CLAIM_WINDOW = 90 * MINUTE

export interface CouplingDeadlineInput {
  /** `Ds` — after this the CLIENT may reclaim the send lockup. */
  sendRefundLocktime: number
  /** `Dr` — after this the PROVIDER may reclaim the receive payout. */
  receiveRefundLocktime: number
}

export type CouplingDeadlineDecision = { couple: true } | { couple: false; reason: 'coupled_deadline_unsafe' }

/**
 * `Ds` must land at least a full claim window after `Dr`.
 *
 * The safety rule of the coupled self-payment flow, where one client holds both
 * sides: they lock up on the send leg, and we pay out on the receive leg. We
 * only learn `P` when they claim our payout, and we then have to get our own
 * claim on their lockup confirmed.
 *
 * If `Ds` fell before `Dr`, that ordering could be run in reverse: refund the
 * send lockup the moment `Ds` opens, and only THEN claim the receive payout,
 * still before `Dr`. Both sides, one payment. Requiring the margin means the
 * refund path they would need is still shut while our claim window is open.
 *
 * The margin is `MIN_CLAIM_WINDOW` for the same reason the Lightning corridor
 * uses it — it is the time an observe-and-claim needs against a deadline that
 * matures on median-time-past — so it is that constant, not a second one that
 * could drift away from it.
 */
export const evaluateCouplingDeadlines = (input: CouplingDeadlineInput): CouplingDeadlineDecision =>
  input.sendRefundLocktime - input.receiveRefundLocktime >= MIN_CLAIM_WINDOW
    ? { couple: true }
    : { couple: false, reason: 'coupled_deadline_unsafe' }

/**
 * How long a quoted swap stays fundable before we consider it abandoned.
 * Default for the `LOCKUP_TIMEOUT_SECONDS` env knob (`packages/solver-app/src/config.ts`).
 */
export const DEFAULT_LOCKUP_TIMEOUT = 15 * MINUTE

/**
 * When a quote stops being fundable: the funding window, fitted to the invoice.
 *
 * THE single definition, and it has consumers that must never disagree —
 * `evaluateSendAcceptance` quotes it to the client, the send orchestrator times
 * the quote out against it, and the RFQ re-quote path replays it for a swap
 * already on disk. A client told one deadline and timed out against another is
 * refused for funding exactly when it was invited to.
 *
 * The invariant: a client funding inside the window it was quoted must never
 * then be refused for expiry. `evaluateSendPayment` insists on
 * `MIN_INVOICE_WINDOW` at the moment it pays, so the window may not outlast
 * `invoiceExpiresAt - MIN_INVOICE_WINDOW`, and simply ENDS there when the
 * invoice is too short to hold a whole `lockupTimeout`.
 *
 * Fitting the window to the invoice, rather than demanding an invoice that fits
 * a fixed window, is what lets a short invoice be quoted at all. This used to
 * run the other way — refuse anything under `lockupTimeout +
 * MIN_INVOICE_WINDOW` (17 min at the default), and before that
 * `MIN_INVOICE_WINDOW + MIN_CLAIM_WINDOW` (92 min). Nothing needed either
 * floor. The invoice clock bounds one thing only: whether the PAYEE will still
 * accept the payment. What guards the money is the payee's CLTV delta held
 * against `refundLocktime` (`refundLocktimeFor`, and `worstCaseHtlcBlocks`
 * under it) — and no term of that reads the invoice's expiry, because once the
 * payment is out the invoice has no further say in when the HTLC resolves.
 *
 * The floors' cost was real and ordinary: 15 min is BTCPay Server's default
 * invoice expiry, and 92 min sat above BOLT11's own 3600s default (the decoder's
 * `DEFAULT_EXPIRY_SECONDS`, `src/invoice/decode.ts`), so an invoice minted
 * without an `x` tag was refused outright.
 *
 * Only a quote-time pre-check either way. The gates that guard the money are
 * re-evaluated immediately before the payment in `evaluateSendPayment`.
 */
export const lockupDeadlineFor = (
  quotedAt: number,
  invoiceExpiresAt: number,
  lockupTimeout = DEFAULT_LOCKUP_TIMEOUT,
): number => Math.min(quotedAt + lockupTimeout, invoiceExpiresAt - MIN_INVOICE_WINDOW)

/** Conservative block interval used to turn a CLTV delta into wall-clock time. */
export const SECONDS_PER_BLOCK = 10 * MINUTE

/**
 * Extra CLTV budget our own route may add on top of the payee's final delta,
 * in blocks. Intermediate hops each add their own delta.
 *
 * Whether this is an enforced ceiling or only a budget depends on the backend:
 *
 *   LND    ENFORCES it. `payViaPaymentRequest` takes `max_timeout_height`,
 *          which the vendor turns into LND's own `cltv_limit`, so a route
 *          costing more than this budget is refused rather than taken.
 *   Others may NOT. A pay call that exposes no max-CLTV control at all leaves
 *          this a budget only, and the route is whatever the backend picks.
 *
 * This value is therefore for the ENFORCING case only. It can be a generous
 * estimate of a real route rather than a bound on every conceivable one, because
 * being wrong costs a refused payment, not money: LND declines the route instead
 * of taking it. A backend that cannot enforce gets
 * {@link UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS} instead, and the backend itself
 * says which it is (`SendBackend.routeCltvBudgetBlocks`) rather than this module
 * guessing.
 *
 * Note what it does NOT have to cover any more: CLTV the INVOICE dictates. The
 * payee's final delta and its route hints are read off the invoice and added
 * separately by `worstCaseHtlcBlocks`, so this is only the public-route prefix
 * we cannot see in advance.
 */
export const ROUTE_CLTV_BUDGET_BLOCKS = 432

/** Margin on top of the worst-case HTLC lifetime before the refund path opens. */
export const REFUND_SAFETY_MARGIN = 2 * HOUR

/**
 * Longest our outbound HTLC may stay live, in blocks: what the payee demands
 * plus what our route may add.
 *
 * THE single definition of that worst case, and it has two consumers that must
 * never disagree — `refundLocktimeFor` converts it into the client's refund
 * deadline, and the send leg passes it to the backend as the CLTV ceiling the
 * payment is capped at. A ceiling looser than the deadline reserved for it is
 * precisely the double-collect window documented below, so neither side may
 * recompute this locally.
 *
 * Note this is NOT recoverable from `refundLocktime` alone: that value is the
 * MAXIMUM of this bound and the unilateral one, and on mainnet the unilateral
 * bound wins — inverting it would hand the backend a far looser ceiling than
 * the route budget ever intended.
 */
export interface HtlcCltv {
  /** Final CLTV delta the payee requires, in blocks. */
  minFinalCltvBlocks: number
  /** Worst route hint's total, in blocks — CLTV the INVOICE dictates. */
  worstRouteHintCltvBlocks: number
  /** Best route hint's total, in blocks — the same under the payer's best choice. */
  bestRouteHintCltvBlocks: number
  /** What the route may add on top, in blocks. Per backend — see {@link ROUTE_CLTV_BUDGET_BLOCKS}. */
  routeCltvBudgetBlocks: number
  /** Whether the rail caps the route it picks — `SendBackend.enforcesRouteCltv`. */
  enforcesRouteCltv: boolean
}

/**
 * Which of the invoice's two hint readings THIS rail is actually bound by.
 *
 * Route hints are alternatives: the payer picks one and owes only its hops. A
 * rail that can cap the route's CLTV declines anything costlier than the
 * ceiling it is handed, so it can never be made to take the worst hint — the
 * best is the real bound, and being wrong costs a refused payment. A rail that
 * cannot cap is bound by whatever the network chose, which is the worst.
 *
 * The ONE place that choice is made. Every consumer below reads it through this
 * function rather than picking a field, so the deadline quoted to the client,
 * the pay-time budget check and the ceiling handed to the backend cannot come
 * to different answers — which is the property {@link worstCaseHtlcBlocks}'
 * comment already claims and this is what makes true.
 */
export const hintCltvBlocks = (cltv: HtlcCltv): number =>
  cltv.enforcesRouteCltv ? cltv.bestRouteHintCltvBlocks : cltv.worstRouteHintCltvBlocks

export const worstCaseHtlcBlocks = (cltv: HtlcCltv): number =>
  cltv.minFinalCltvBlocks + hintCltvBlocks(cltv) + cltv.routeCltvBudgetBlocks

/**
 * Route budget for a backend that CANNOT enforce a CLTV ceiling.
 *
 * `ROUTE_CLTV_BUDGET_BLOCKS` is safe on LND because LND refuses a route costing
 * more than it — the budget and the enforcement are the same number, so being
 * wrong costs a failed payment, not money. A backend that exposes no max-CLTV
 * control at all — no CLTV field on the pay call, and none reported back on the
 * payment either, so we can neither cap the route nor read what it chose — turns
 * the same number into an unverifiable ASSUMPTION about a route we never see.
 * Assume wrong there and the HTLC outlives the refund deadline.
 *
 * So on such a backend the budget stops being an estimate of a typical route and
 * becomes a bound on ANY route the network would carry: 2016 blocks, LND's own
 * default `--max-cltv-expiry` and the de-facto ceiling a sending node enforces.
 * ~14 days at 10 min/block, and the deadlines quoted there are correspondingly
 * further out — the price of paying over a rail that cannot be capped.
 *
 * That cost is bearable because the deadline is a FALLBACK, not the refund path:
 * a swap whose payment provably failed is refunded immediately over the
 * covenant's no-timelock leaf, and an expired VTXO stays recoverable. Only a
 * payment genuinely stuck in flight waits out the deadline — which is precisely
 * the case where waiting is the correct behaviour.
 */
export const UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS = 2016

/**
 * The CLTV ceiling this payment may actually be made with, RIGHT NOW.
 *
 * `worstCaseHtlcBlocks` is what the deadline was sized for at QUOTE time; this
 * is that budget clamped by what is genuinely left of the deadline at PAYMENT
 * time. The two are not the same number, and the difference is a fund-loss bug:
 *
 *   `refundLocktime` is ABSOLUTE and fixed when we quote. The ceiling handed to
 *   the backend is a DELTA from the moment we pay (LND turns it into
 *   `max_timeout_height = current_height + maxCltvBlocks`). So every second
 *   spent between quoting and paying shortens the deadline without shortening
 *   the ceiling — and once the funding delay exceeds `REFUND_SAFETY_MARGIN`,
 *   the outbound HTLC may legally outlive the client's refund. That is the
 *   double-collect window `refundLocktimeFor` exists to close: refund the
 *   lockup, then settle the Lightning payment, both sides taken.
 *
 * Subtracting the margin here is what makes the guarantee hold at any funding
 * delay rather than only a prompt one. It also means this can go to zero or
 * below, which is not a ceiling but a refusal — `evaluateSendPayment` turns
 * that into `cltv_budget_too_short` rather than letting a nonsense ceiling
 * reach the backend.
 *
 * This is the shape Boltz's `TimeoutDeltaProvider.getCltvLimit` has: they read
 * the CURRENT block height, take `timeoutBlockHeight - currentBlock`, subtract
 * a `cltvDelta` buffer (20 blocks by default) and pass the result as the
 * payment's CLTV limit, refusing below a floor. Same invariant, same direction:
 * the limit is derived from the time that remains, never from the time we hoped
 * for when we quoted.
 */
export const payableCltvBlocks = (cltv: HtlcCltv, refundLocktime: number, now: number): number =>
  Math.min(worstCaseHtlcBlocks(cltv), Math.floor((refundLocktime - now - REFUND_SAFETY_MARGIN) / SECONDS_PER_BLOCK))

/**
 * Can the stored deadline still contain an HTLC that nothing will cap, with the
 * claim margin left intact?
 *
 * The question {@link payableCltvBlocks} produces an answer to but does not ask.
 * That one yields a CEILING, and a ceiling is worth exactly what the rail does
 * with it: LND turns it into `cltv_limit` and declines a costlier route, so
 * clamping it to the time that remains is not merely safe there, it is the
 * mechanism — the clamp shortens the ceiling second for second as funding drags,
 * so the HTLC still ends a full `REFUND_SAFETY_MARGIN` before the deadline
 * however late the lockup arrived. A rail whose pay call carries no CLTV field
 * drops it, so the same clamp narrows a number nothing reads while the HTLC the
 * network really builds stays as long as it ever could:
 * {@link worstCaseHtlcBlocks}.
 *
 * So on a rail that cannot cap, ask whether the clamp bit at all. An unclamped
 * budget is exactly the statement that what remains still affords the whole
 * worst case AND the margin `payableCltvBlocks` already subtracts — which is the
 * same invariant the enforcing rail gets for free, held here by refusal instead.
 *
 * Spelled as a comparison against `payableCltvBlocks` rather than as its own
 * arithmetic so the two cannot drift: the margin this depends on is the one that
 * function subtracts, and there is no second copy of that term.
 *
 * The margin is NOT optional slack to be spent by a slow funding. It is the time
 * an observe-and-claim needs after the preimage arrives, against a deadline that
 * matures on median-time-past — the same thing `MIN_CLAIM_WINDOW` measures. A
 * deadline that merely reaches the end of the HTLC leaves zero time to claim the
 * lockup, which is the double-collect window rather than a bound on it. What
 * pays for the funding delay on this rail is a deadline quoted longer in the
 * first place; see {@link refundLocktimeFor}.
 */
export const deadlineContainsHtlc = (cltv: HtlcCltv, refundLocktime: number, now: number): boolean =>
  payableCltvBlocks(cltv, refundLocktime, now) >= worstCaseHtlcBlocks(cltv)

/**
 * Longest funding window an operator may configure (`LOCKUP_TIMEOUT_SECONDS`).
 *
 * DERIVED: the window is the gap between quoting — when `refundLocktime` is
 * fixed, absolutely — and paying, and `payableCltvBlocks` spends every second of
 * it out of `REFUND_SAFETY_MARGIN`. A window longer than that margin can only
 * produce quotes which, if funded near their deadline, refuse themselves with
 * `cltv_budget_too_short`. Refusing the configuration once at boot says that
 * plainly instead of once per swap.
 *
 * Defence in depth rather than the guard itself: `payableCltvBlocks` enforces
 * the real invariant at payment time whatever this is set to. It is written down
 * because the bound that USED to sit on this knob (3480s) was justified by an
 * invoice-expiry constraint that no longer exists, and while removing it for
 * that reason was right, 3480 had also been holding the window under this margin
 * by accident — an invariant nothing named and nothing tested.
 *
 * Note the equality is now a coincidence worth keeping rather than a derivation.
 * Neither rail spends the margin on funding: the enforcing one absorbs the delay
 * into its CEILING, which `payableCltvBlocks` shortens second for second, and the
 * other has the window reserved in its deadline up front (`refundLocktimeFor`).
 * What this bound still buys is that the second of those reservations stays
 * small — a client is quoted the window as extra refund clock.
 */
export const MAX_LOCKUP_TIMEOUT = REFUND_SAFETY_MARGIN

/**
 * When the client's refund path may open, given the invoice they supplied.
 *
 * This is the gate that stops the client taking both sides of the swap, and it
 * is the mirror of what the receive leg does with `E`.
 *
 * The attack it closes: a client supplies a **hold** invoice for a node they
 * control, funds the lockup, and lets us pay. Their node arms the HTLC and sits
 * on it. If the Arkade refund path opened before that outbound HTLC could resolve,
 * the client would refund the lockup and only then settle the Lightning payment
 * — collecting the sats twice and leaving us with nothing.
 *
 * So the refund deadline must outlast the longest time our outbound payment can
 * stay live: the payee's final CLTV delta plus the deltas any route we pick will
 * add, converted at a conservative block interval, plus margin — plus, where the
 * rail cannot cap that route, the funding window too, for the reason below. A
 * fixed `now + 2h` is not a bound on anything the client cannot choose.
 */
export const refundLocktimeFor = (
  cltv: HtlcCltv,
  unilateralClaimDelay: number,
  now: number,
  lockupTimeout = DEFAULT_LOCKUP_TIMEOUT,
): number => {
  // Who pays for the gap between quoting and paying, which is the whole funding
  // window. On a rail that caps the route, the CEILING does:
  // `payableCltvBlocks` shortens it second for second, so the HTLC still ends a
  // full `REFUND_SAFETY_MARGIN` before this deadline at any funding delay —
  // nothing to reserve here. On a rail that drops the ceiling, nothing absorbs
  // it, and the only other term available is the margin. Letting it come out of
  // there would leave a swap funded late with an HTLC ending exactly when the
  // client's refund opens, and no time at all to claim the lockup with the
  // preimage — the double-collect window, reached through the very deadline
  // that exists to close it.
  //
  // So the deadline carries the window in advance instead, and
  // `deadlineContainsHtlc` refuses at payment time if it was not enough. Cheap:
  // this rail already quotes ~14 days of route budget, and a funding window is
  // minutes against that.
  const fundingWindow = cltv.enforcesRouteCltv ? 0 : lockupTimeout

  const htlcBound = now + worstCaseHtlcBlocks(cltv) * SECONDS_PER_BLOCK + fundingWindow + REFUND_SAFETY_MARGIN

  // Second bound, and on mainnet the binding one — EXCEPT on a backend quoting
  // `UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS`, where `htlcBound` reaches ~14 days and
  // takes over everywhere. Both bounds still hold, since this is a `max`; what
  // changes is which one SETS the deadline, so on such a deployment the deadline
  // says nothing about the exit delay. An exit delay past that budget would bind
  // here again.
  //
  // Both collaborative paths -- our `claim` and the client's
  // `refundWithoutReceiver` -- require the Arkade server to co-sign. If the server
  // is unavailable or censors this script, our only recourse is
  // `unilateralClaim`, which does not mature until `unilateralClaimDelay` after
  // the funding output confirms (roughly seven days on mainnet).
  //
  // So the client's refund must not open before we could enforce our claim
  // without the server. Otherwise a server outage between paying and claiming
  // lets the client refund while we are still days away from any recourse,
  // having already paid the invoice.
  //
  // CONVERTED, not added raw. `unilateralClaimDelay` may count BLOCKS against a
  // block-typed arkd, and this bound is a unix-seconds deadline: adding a block count to
  // a timestamp does not lose precision, it collapses the bound — 20 blocks read as 20
  // seconds puts the client's refund essentially at `now`, which is the double-collect
  // window this bound exists to close.
  const unilateralBound = now + rawDelaySeconds(unilateralClaimDelay) + REFUND_SAFETY_MARGIN

  return Math.max(htlcBound, unilateralBound)
}

/** Why a send swap was refused at creation time. */
export type SendAcceptanceRefusal =
  | 'invoice_expired'
  | 'invoice_expires_too_soon'
  | 'wrong_network'
  | 'amount_out_of_range'
  | 'zero_amount_invoice'
  /**
   * The invoice's worst route hint is longer than this deployment can contain,
   * and this deployment's rail cannot decline the route that takes it. Shares
   * its name with the `InvoiceRejection` of the same meaning — see the gate.
   */
  | 'cltv_too_large'

/** Why paying the invoice was refused. */
export type SendPaymentRefusal =
  /** The invoice lapsed between quoting and funding. */
  | 'invoice_expired'
  /** Not enough left on the invoice to attempt a payment safely. */
  | 'invoice_expires_too_soon'
  /** The lockup is too close to being refundable to risk paying. */
  | 'claim_window_too_short'
  /**
   * What is left before the refund opens cannot hold an HTLC the payee is
   * entitled to keep alive — see {@link payableCltvBlocks}.
   */
  | 'cltv_budget_too_short'
  /**
   * The rail paying this row cannot cap the route's CLTV, and the deadline
   * stored on the row cannot contain the worst case such a rail may take. Its
   * own gate rather than a shade of `cltv_budget_too_short`: that one means the
   * clock ran down on a deadline correctly sized for this rail, while this means
   * the deadline was never sized for the rail now paying it — see {@link
   * deadlineContainsHtlc}.
   */
  | 'uncapped_route_deadline_too_short'
  /** The client has not locked up the full amount. */
  | 'lockup_insufficient'

export interface SendAcceptanceInput {
  /** Absolute invoice expiry, unix seconds. */
  invoiceExpiresAt: number
  /** Amount the invoice asks for, in sats. Zero-amount invoices are not supported. */
  invoiceAmountSats: number
  /** bech32 prefix carried by the invoice. */
  invoiceNetwork: string
  /** bech32 prefix this provider serves. */
  providerNetwork: string
  limits: { minSats: number; maxSats: number }
  /** Final CLTV delta the payee requires, in blocks, read from the invoice. */
  minFinalCltvBlocks: number
  /**
   * The invoice's two hint totals and the rail's answer about itself, all
   * UN-TRANSFORMED: the gate below needs the raw worst, which no caller may
   * pre-select away. Selecting at the call site would leave the gate reading a
   * value the decode floor has already bounded, so its condition could never
   * fire — see {@link hintCltvBlocks}, which is where selection belongs.
   */
  worstRouteHintCltvBlocks: number
  bestRouteHintCltvBlocks: number
  /** What this backend's routes may add — `SendBackend.routeCltvBudgetBlocks`. */
  routeCltvBudgetBlocks: number
  /** Whether this backend caps the route — `SendBackend.enforcesRouteCltv`. */
  enforcesRouteCltv: boolean
  /** The script's unilateral claim delay, in seconds — our server-independent recourse. */
  unilateralClaimDelay: number
  /** Funding window the quote grants, seconds. Defaults to {@link DEFAULT_LOCKUP_TIMEOUT}. */
  lockupTimeout?: number
  now: number
}

export type SendAcceptanceDecision =
  | { accept: true; refundLocktime: number; lockupDeadline: number }
  | {
      accept: false
      reason: SendAcceptanceRefusal
      /**
       * The numbers behind the reason, for the operator's log — the same split
       * `InvalidInvoice` makes and for the same reason. Never reaches a client,
       * so adding one here cannot change what any client is told; it exists
       * because `cltv_too_large` now names two different gates and the enum
       * alone cannot say which fired.
       */
      detail?: string
    }

/** Decide whether to quote a send swap at all. */
export const evaluateSendAcceptance = (input: SendAcceptanceInput): SendAcceptanceDecision => {
  const {
    invoiceExpiresAt,
    invoiceAmountSats,
    invoiceNetwork,
    providerNetwork,
    limits,
    minFinalCltvBlocks,
    worstRouteHintCltvBlocks,
    bestRouteHintCltvBlocks,
    routeCltvBudgetBlocks,
    enforcesRouteCltv,
    unilateralClaimDelay,
    lockupTimeout = DEFAULT_LOCKUP_TIMEOUT,
    now,
  } = input

  if (invoiceNetwork !== providerNetwork) {
    return { accept: false, reason: 'wrong_network' }
  }
  if (!Number.isFinite(invoiceAmountSats) || invoiceAmountSats <= 0) {
    return { accept: false, reason: 'zero_amount_invoice' }
  }
  if (invoiceAmountSats < limits.minSats || invoiceAmountSats > limits.maxSats) {
    return { accept: false, reason: 'amount_out_of_range' }
  }
  if (now >= invoiceExpiresAt) {
    return { accept: false, reason: 'invoice_expired' }
  }
  // Nothing left to offer: the window fitted to this invoice has already closed,
  // so the client could not fund inside it even instantaneously. Note this is the
  // ONLY invoice-expiry refusal at quote time — a short invoice is quoted with a
  // correspondingly short window, not turned away.
  const lockupDeadline = lockupDeadlineFor(now, invoiceExpiresAt, lockupTimeout)
  if (lockupDeadline <= now) {
    return { accept: false, reason: 'invoice_expires_too_soon' }
  }
  // "Can THIS deployment serve it?" — the half of the CLTV bound `decodeInvoice`
  // cannot ask, because the answer depends on the rail rather than the invoice.
  // The floor there already refused anything unservable everywhere (final delta
  // plus the BEST hint over the same ceiling); what reaches here and still
  // trips this is an invoice whose bad hint is one ALTERNATIVE among several,
  // payable wherever the route can be capped.
  //
  // Both clauses decide something. The sum is the raw worst, which the floor
  // lets past deliberately; the flag is what separates "unservable here" from
  // "contained by the rail".
  //
  // Before `refundLocktimeFor`, not after: on a non-enforcing rail the worst
  // hint is exactly what would size the deadline, so accepting the Wallet of
  // Satoshi shape here means quoting a client a ten-month refund clock. That is
  // worse than the refusal it would replace, and the refusal is what this
  // corridor already gave.
  if (!enforcesRouteCltv && minFinalCltvBlocks + worstRouteHintCltvBlocks > MAX_CLIENT_CLTV_BLOCKS) {
    return {
      accept: false,
      reason: 'cltv_too_large',
      detail:
        `final delta ${minFinalCltvBlocks} + worst route hint ${worstRouteHintCltvBlocks} = ` +
        `${minFinalCltvBlocks + worstRouteHintCltvBlocks} > ${MAX_CLIENT_CLTV_BLOCKS} ` +
        `(worst-hint rule: backend cannot cap route CLTV; best hint ${bestRouteHintCltvBlocks})`,
    }
  }

  return {
    accept: true,
    refundLocktime: refundLocktimeFor(
      {
        minFinalCltvBlocks,
        worstRouteHintCltvBlocks,
        bestRouteHintCltvBlocks,
        routeCltvBudgetBlocks,
        enforcesRouteCltv,
      },
      unilateralClaimDelay,
      now,
      // The window THIS quote grants, not the default: an operator's
      // `LOCKUP_TIMEOUT_SECONDS` is how long the client may take to fund, and on
      // a rail that caps nothing that is time the deadline has to have reserved.
      lockupTimeout,
    ),
    lockupDeadline,
  }
}

export interface SendPaymentInput {
  /** Absolute invoice expiry, unix seconds. */
  invoiceExpiresAt: number
  /** Absolute time the user's refund path opens, unix seconds. */
  refundLocktime: number
  /** Sats actually locked up at the swap address. */
  lockedSats: number
  /** Sats the swap requires. */
  expectedSats: number
  /** Final CLTV delta the payee requires, in blocks, read from the row's own invoice. */
  minFinalCltvBlocks: number
  /** Both hint totals, from the same invoice — see {@link hintCltvBlocks}. */
  worstRouteHintCltvBlocks: number
  bestRouteHintCltvBlocks: number
  /** What this backend's routes may add — `SendBackend.routeCltvBudgetBlocks`. */
  routeCltvBudgetBlocks: number
  /**
   * Whether this backend caps the route — `SendBackend.enforcesRouteCltv`.
   *
   * Read LIVE, from the rail in use right now, while `refundLocktime` was fixed
   * on the row at quote time. Nothing on the row records which rail quoted it
   * (`payment_backend` is written alongside a payment id, so it exists only
   * AFTER a payment), and a `funded` row has no staleness bound, so a deployment
   * that swaps one Lightning rail for another pays out rows quoted under the old
   * one. Same shape `routeCltvBudgetBlocks` has had all along.
   *
   * The asymmetry is deliberate and it fails closed — but via
   * `deadlineContainsHtlc`, NOT via the budget check, which is where this
   * comment used to point and was wrong. Re-selecting the worst hint and
   * clamping the ceiling refuses only when the payee's own floor already
   * exceeds the remaining deadline; on mainnet, where the unilateral bound sets
   * that deadline, an ordinary invoice sails through it and the uncapped route
   * on top is never asked about. The deadline-containment gate is what asks.
   *
   * The reverse switch only tightens a ceiling already inside a longer deadline.
   */
  enforcesRouteCltv: boolean
  now: number
}

export type SendPaymentDecision = { pay: true } | { pay: false; reason: SendPaymentRefusal }

/**
 * Decide whether to pay the invoice right now.
 *
 * MUST be called immediately before the payment call, not when the lockup was
 * first seen. Quoting, funding and paying are separated by network waits, and an
 * invoice that was comfortably live at quote time can be seconds from lapsing by
 * the time the funds actually arrive.
 */
export const evaluateSendPayment = (input: SendPaymentInput): SendPaymentDecision => {
  const {
    invoiceExpiresAt,
    refundLocktime,
    lockedSats,
    expectedSats,
    minFinalCltvBlocks,
    worstRouteHintCltvBlocks,
    bestRouteHintCltvBlocks,
    routeCltvBudgetBlocks,
    enforcesRouteCltv,
    now,
  } = input

  // Finite check first: 0 < NaN is false, so a NaN expected amount would make
  // this gate report "pay" with nothing locked at all.
  if (
    !Number.isFinite(lockedSats) ||
    !Number.isFinite(expectedSats) ||
    expectedSats <= 0 ||
    lockedSats < expectedSats
  ) {
    return { pay: false, reason: 'lockup_insufficient' }
  }
  // Never pay against an expired invoice.
  if (now >= invoiceExpiresAt) {
    return { pay: false, reason: 'invoice_expired' }
  }
  if (invoiceExpiresAt - now < MIN_INVOICE_WINDOW) {
    return { pay: false, reason: 'invoice_expires_too_soon' }
  }
  // Stop paying once the refund path is close enough that we could lose the claim.
  if (refundLocktime - now < MIN_CLAIM_WINDOW) {
    return { pay: false, reason: 'claim_window_too_short' }
  }
  // And the stronger form of the same question, which the flat margin above
  // cannot ask: is what remains enough to hold an HTLC the PAYEE is entitled to
  // keep alive? `minFinalCltvBlocks` is the payee's floor, so a budget at or
  // under it leaves nothing for a route and, worse, means the deadline can no
  // longer contain the HTLC we would be authorising.
  const cltv = {
    minFinalCltvBlocks,
    worstRouteHintCltvBlocks,
    bestRouteHintCltvBlocks,
    routeCltvBudgetBlocks,
    enforcesRouteCltv,
  }
  const budget = payableCltvBlocks(cltv, refundLocktime, now)
  if (budget <= minFinalCltvBlocks + hintCltvBlocks(cltv)) {
    return { pay: false, reason: 'cltv_budget_too_short' }
  }
  // And the same question once more for a rail that cannot cap the route, where
  // the check above does not settle it. That one reads `budget` as a ceiling,
  // which holds only where something enforces the ceiling; where nothing does,
  // it passes as soon as the deadline clears the PAYEE's floor and says nothing
  // about the route stacked on top of it. On mainnet that gap is wide open —
  // `refundLocktimeFor` takes a `max`, the unilateral bound usually wins, and a
  // deadline set by a seven-day exit delay comfortably clears an ordinary
  // payee's floor while falling far short of what an uncapped route may reach.
  //
  // So ask the deadline directly. `worstCaseHtlcBlocks` already carries
  // `UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS` on such a rail, which is the point:
  // the bound on any route the network would carry, not an estimate of a
  // typical one.
  if (!enforcesRouteCltv && !deadlineContainsHtlc(cltv, refundLocktime, now)) {
    return { pay: false, reason: 'uncapped_route_deadline_too_short' }
  }

  return { pay: true }
}
