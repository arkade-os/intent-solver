/**
 * The one and only place the LND backend SDK is imported.
 *
 * Same rule as every other rail adapter: everything above this file speaks
 * {@link LightningBackend} — plain hex strings and unix seconds. LND's ISO
 * dates, millitoken strings and gRPC error tuples stop here.
 */

import {
  authenticatedLndGrpc,
  cancelHodlInvoice,
  createHodlInvoice,
  getChannelBalance,
  getInvoice,
  getPayment as lndGetPayment,
  getWalletInfo,
  payViaPaymentRequest,
  settleHodlInvoice,
  type AuthenticatedLnd,
} from 'lightning'
import { htlcDeadlineFromHeight } from '@arkade-os/solver-core/core/receive.js'
import { ROUTE_CLTV_BUDGET_BLOCKS } from '@arkade-os/solver-core/core/send.js'
import { paymentHashOf } from '@arkade-os/solver-core/invoice/decode.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import type {
  PaymentEvidence,
  PaymentFailureReason,
  Balance,
  CreateHoldInvoiceParams,
  HoldInvoice,
  HoldState,
  HoldStatus,
  LightningBackend,
  PayInvoiceParams,
  PaymentResult,
  PaymentStatus,
} from '@arkade-os/solver-core/ports/lightning.js'

/**
 * Payment-outcome reasons `payViaPaymentRequest` (from the `lightning`
 * package) rejects with that mean the payment provably did not leave — not a
 * transport error, not a timeout. Anything else stays `pending`: the costly
 * error here is calling a live payment dead.
 *
 * All but the last come from that package's `finished_payment.js`
 * terminal-failure branch, i.e. LND's own state machine settled the payment as
 * failed. A route refused for exceeding `max_timeout_height` arrives as
 * `PaymentPathfindingFailedToFindPossibleRoute`, so the CLTV ceiling's normal
 * failure needs nothing special here.
 *
 * `MaxTimeoutTooNearCurrentHeightToMakePayment` is the exception, and comes
 * from the vendor's own pre-flight guard in `subscribe_to_pay.js` — raised
 * when the ceiling leaves less than the invoice's final delta plus 3, BEFORE
 * `sendPaymentV2` is called at all. It is only reachable because we now pass a
 * ceiling. Terminal rather than `pending` because nothing was ever sent:
 * `getPayment` answers `SentPaymentNotFound` for it, so leaving it pending
 * would only poll a rejection that cannot change.
 */
export const FAILED_PAYMENT_REASONS: Set<string> = new Set([
  'PaymentExecutionCanceled',
  'InsufficientBalanceToAttemptPayment',
  'PaymentRejectedByDestination',
  'PaymentAttemptsTimedOut',
  'PaymentPathfindingFailedToFindPossibleRoute',
  'FailedToFindPayableRouteToDestination',
  'MaxTimeoutTooNearCurrentHeightToMakePayment',
])

/**
 * `lightning`'s promise rejections are `[code, reason, details?]` tuples, not
 * `Error`s. Pull the reason out where present so it can be checked against
 * {@link FAILED_PAYMENT_REASONS}.
 */
export const rejectionReason = (error: unknown): string | undefined =>
  Array.isArray(error) && typeof error[1] === 'string' ? error[1] : undefined

export const isoToUnixSeconds = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000)

export const toExpiresAt = (fromSeconds: number, expirySeconds: number): string =>
  new Date((fromSeconds + expirySeconds) * 1000).toISOString()

/** The subset of LND's invoice-lookup fields the hold-status mapping needs. */
type HoldInvoiceFlags = { is_canceled?: boolean; is_confirmed: boolean; is_held?: boolean }

/**
 * LND's invoice states are mutually exclusive and terminal-before-intermediate
 * (OPEN -> ACCEPTED(held) -> SETTLED or CANCELED), so check the terminal
 * flags before the intermediate `is_held` one.
 */
export const toHoldStatus = (invoice: HoldInvoiceFlags): HoldStatus => {
  if (invoice.is_canceled) return 'cancelled'
  if (invoice.is_confirmed) return 'settled'
  if (invoice.is_held) return 'armed'
  return 'pending'
}

/** The subset of a `getInvoice` payment (one incoming HTLC) the deadline read needs. */
type HeldHtlc = { is_held: boolean; timeout: number }

/**
 * The CLTV timeout HEIGHT of the held HTLCs, or null if none is held.
 *
 * `payments[]` is every HTLC LND has ever accepted against this invoice, not
 * just the live ones (the vendor builds it from `htlcs[]` filtered on
 * `accept_height`, so cancelled and settled attempts stay in the list). Only an
 * HTLC that is STILL held has a deadline we have to beat, hence the `is_held`
 * filter.
 *
 * The MINIMUM across them, because a multipath payment arms several HTLCs with
 * independently routed CLTVs and the invoice can only be settled as a whole:
 * the earliest one to expire is the one that bounds us.
 */
export const heldTimeoutHeight = (payments: readonly HeldHtlc[]): number | null => {
  const heights = payments.filter((payment) => payment.is_held).map((payment) => payment.timeout)
  return heights.length === 0 ? null : Math.min(...heights)
}

/** The subset of LND's per-attempt failure flags, as `trackPaymentV2` reports them. */
type PaymentFailureFlags = {
  is_canceled?: boolean
  is_insufficient_balance?: boolean
  is_invalid_payment?: boolean
  is_pathfinding_timeout?: boolean
  is_route_not_found?: boolean
}

/** The subset of LND's payment-lookup fields the payment-result mapping needs. */
type PaymentOutcome = {
  is_confirmed?: boolean
  is_failed?: boolean
  is_pending?: boolean
  failed?: PaymentFailureFlags
  payment?: { secret: string }
}

/**
 * The rejection-string half of the flag mapping below.
 *
 * `payInvoice` learns a failure as one of {@link FAILED_PAYMENT_REASONS} while
 * `getPayment` learns it as the `failed{}` flags, but they are two views of one
 * fact: the vendor's `checkFailure` turns each flag into exactly the string
 * below (`finished_payment.js:114-134`). Mapping both keeps a client's
 * `failure_reason` the same whichever call happened to notice.
 *
 * `MaxTimeoutTooNearCurrentHeightToMakePayment` has no flag of its own — it is
 * the vendor's pre-flight CLTV guard — and lands on `route_not_found` because
 * that is what it means: no route we would accept exists inside the ceiling.
 */
const REJECTION_FAILURE_REASONS: Record<string, PaymentFailureReason> = {
  PaymentExecutionCanceled: 'canceled',
  InsufficientBalanceToAttemptPayment: 'insufficient_balance',
  PaymentRejectedByDestination: 'rejected_by_destination',
  PaymentAttemptsTimedOut: 'pathfinding_timeout',
  PaymentPathfindingFailedToFindPossibleRoute: 'route_not_found',
  FailedToFindPayableRouteToDestination: 'route_not_found',
  MaxTimeoutTooNearCurrentHeightToMakePayment: 'route_not_found',
}

export const rejectionFailureReason = (reason: string): PaymentFailureReason =>
  REJECTION_FAILURE_REASONS[reason] ?? 'unknown'

/**
 * The `failed{}`-flag half, as `getPayment` reports a failure.
 *
 * The vendor's own `checkFailure` reads these flags in this order and turns
 * each into one of {@link FAILED_PAYMENT_REASONS}; this is the same order, so
 * a multi-flag failure names the same cause the rejection path would have.
 * Its no-flag fallthrough is `FailedToFindPayableRouteToDestination`, but that
 * is a guess about a route rather than a fact, so an absent `failed` object
 * stays `unknown` here rather than inventing a cause.
 */
export const toFailureReason = (failed: PaymentFailureFlags | undefined): PaymentFailureReason => {
  if (!failed) return 'unknown'
  if (failed.is_canceled) return 'canceled'
  if (failed.is_insufficient_balance) return 'insufficient_balance'
  if (failed.is_invalid_payment) return 'rejected_by_destination'
  if (failed.is_pathfinding_timeout) return 'pathfinding_timeout'
  if (failed.is_route_not_found) return 'route_not_found'
  return 'unknown'
}

export const toPaymentResult = (id: string, result: PaymentOutcome): PaymentResult => {
  if (result.is_confirmed) {
    // `is_confirmed` comes from the vendor as `!!payment`, so a confirmed
    // result with no payment record should be unreachable -- but silently
    // downgrading it to `pending` would strand the swap forever rather than
    // surface the bug. Calling a live payment dead is the costly direction;
    // this is the other one, and "throw, don't guess" is what an untrackable
    // payment gets anywhere in this tree.
    if (!result.payment) throw new Error(`LND reported payment ${id} confirmed with no preimage`)
    const status: PaymentStatus = 'succeeded'
    return { id, status, preimage: result.payment.secret, evidence: 'terminal' }
  }
  if (result.is_failed) {
    return { id, status: 'failed', evidence: 'terminal', failureReason: toFailureReason(result.failed) }
  }
  // Unresolved. `in_flight` unconditionally, and NOT derived from `is_pending`,
  // because that flag carries no information beyond the two branches above:
  // `lightning@12.2.3` computes it as `is_pending: !res.payment && !res.failed`
  // (`lnd_methods/offchain/get_payment.js:124`), so reaching this line already
  // implies it. Reading it would also invert badly if a future version dropped
  // the field — absent would look like "not in flight", crying stall on every
  // healthy payment.
  return { id, status: 'pending', evidence: 'in_flight' }
}

/**
 * `getPayment` rejects with this reason when LND has no record at all of
 * ever attempting the payment hash -- the original payInvoice call never
 * reached it (a network failure before the send, not a payment still in
 * flight). Nothing above this adapter ever retries payInvoice once a
 * paymentId is on the row, so treating this as `pending` would poll the same
 * rejection forever; `failed` is both accurate (the sats provably never
 * left) and lets the swap resolve. Any other rejection reason is genuinely
 * unexpected and re-thrown, the same way every other not-found case here is.
 */
export const toGetPaymentRejection = (id: string, error: unknown): PaymentResult => {
  if (rejectionReason(error) === 'SentPaymentNotFound') return { id, status: 'failed', evidence: 'no_record' }
  throw error
}

/**
 * Whether a `getInvoice` rejection is LND's "no such invoice" — the only one
 * `getOwnInvoiceState` may read as "not ours". The vendor wraps every lookup
 * failure as `[503, 'UnexpectedLookupInvoiceErr', {err}]`, so the raw gRPC
 * status (code 5 / "unable to locate invoice") has to be read out of the
 * third tuple element.
 */
export const isInvoiceNotFound = (error: unknown): boolean => {
  if (!Array.isArray(error) || error[1] !== 'UnexpectedLookupInvoiceErr') return false
  const inner = (error[2] as { err?: { code?: number; details?: string } } | undefined)?.err
  return inner?.code === 5 || (typeof inner?.details === 'string' && /unable to locate invoice/i.test(inner.details))
}

export interface AdapterConfig {
  /** `host:port` of the LND node's gRPC listener. */
  socket: string
  /** Base64-serialized `tls.cert`. */
  cert: string
  /** Base64-serialized macaroon. */
  macaroon: string
}

export class LndLightningBackendAdapter implements LightningBackend {
  /**
   * The ordinary budget, because this backend ENFORCES it: `payInvoice` below
   * turns `maxCltvBlocks` into `max_timeout_height`, which the vendor maps onto
   * LND's own `cltv_limit`, so a route costing more is refused rather than
   * taken. Being wrong here costs a failed payment, not money — which is what
   * lets it be an estimate of a real route instead of a bound on every possible
   * one (contrast a backend that cannot enforce, which must quote
   * `UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS`).
   */
  // A getter, not a field: this is a constant property of the RAIL rather than
  // per-instance state, so it belongs on the prototype where it can be read
  // without standing up a wallet.
  get routeCltvBudgetBlocks(): number {
    return ROUTE_CLTV_BUDGET_BLOCKS
  }

  /** Same mechanism, stated as the fact the route-hint policy needs. */
  get enforcesRouteCltv(): boolean {
    return true
  }

  private constructor(
    private readonly lnd: AuthenticatedLnd,
    private readonly now: () => number = nowSeconds,
  ) {}

  static async create(config: AdapterConfig): Promise<LndLightningBackendAdapter> {
    const { lnd } = authenticatedLndGrpc({
      socket: config.socket,
      cert: config.cert,
      macaroon: config.macaroon,
    })
    // Round-trip once so a bad cert/macaroon/socket fails here, at boot,
    // rather than on the first swap.
    await getWalletInfo({ lnd })
    return new LndLightningBackendAdapter(lnd)
  }

  async getBalance(): Promise<Balance> {
    const balance = await getChannelBalance({ lnd: this.lnd })
    return { availableSats: balance.channel_balance, incomingSats: balance.inbound ?? 0 }
  }

  async payInvoice(params: PayInvoiceParams): Promise<PaymentResult> {
    // Computed up front so an id is always available, whatever payViaPaymentRequest does.
    const paymentHash = paymentHashOf(params.invoice)
    // Read OUTSIDE the try, deliberately. `maxCltvBlocks` is a delta but
    // `max_timeout_height` is an absolute height, so this read is what makes
    // the ceiling expressible — and if it fails, throwing (the caller retries
    // with the same idempotency key, having sent nothing) is far better than
    // falling into the catch below and reporting `pending` for a payment that
    // never happened. It must NEVER become a path that pays uncapped.
    //
    // Our own node's height, for the same reason `heldHtlcDeadline` reads it
    // here: the vendor re-reads the height from this same node and subtracts
    // it back off to get LND's `cltv_limit`. A block landing between the two
    // reads only tightens the limit by one, which is the safe direction.
    const { current_block_height } = await getWalletInfo({ lnd: this.lnd })
    try {
      const result = await payViaPaymentRequest({
        lnd: this.lnd,
        request: params.invoice,
        max_fee: params.maxFeeSats,
        // The enforced half of the send leg's double-collect bound: LND refuses
        // any route whose CLTV would outlive this height rather than paying
        // over it. Refusing costs us nothing (the covenant refunds the client);
        // paying over an over-long route is what loses the money.
        max_timeout_height: current_block_height + params.maxCltvBlocks,
      })
      return { id: result.id, status: 'succeeded', preimage: result.secret }
    } catch (error) {
      const reason = rejectionReason(error)
      if (reason !== undefined && FAILED_PAYMENT_REASONS.has(reason)) {
        // `MaxTimeoutTooNearCurrentHeightToMakePayment` is the odd one out: the
        // vendor raises it from its own pre-flight guard BEFORE `sendPaymentV2`
        // is called, so LND has no record of the payment at all — `getPayment`
        // would answer `SentPaymentNotFound` for it, which is exactly the
        // `no_record` the polled path reports. Every other reason here comes
        // from LND's settled terminal-failure state.
        const evidence: PaymentEvidence =
          reason === 'MaxTimeoutTooNearCurrentHeightToMakePayment' ? 'no_record' : 'terminal'
        return { id: paymentHash, status: 'failed', evidence, failureReason: rejectionFailureReason(reason) }
      }
      // Unrecognised error, timeout, or dropped connection mid-call: the HTLC
      // may still be in flight inside LND. getPayment resolves it later.
      // idempotencyKey goes unused here because LND already dedups by
      // payment hash: a retried call for the same invoice cannot double-pay.
      return { id: paymentHash, status: 'pending' }
    }
  }

  async walletFingerprint(): Promise<string> {
    // The node's own identity pubkey. Public by definition — it is what every
    // channel peer addresses — and stable for the life of the node.
    const { public_key } = await getWalletInfo({ lnd: this.lnd })
    return public_key
  }

  async getPayment(id: string): Promise<PaymentResult> {
    try {
      const result = await lndGetPayment({ lnd: this.lnd, id })
      return toPaymentResult(id, result)
    } catch (error) {
      return toGetPaymentRejection(id, error)
    }
  }

  async createHoldInvoice(params: CreateHoldInvoiceParams): Promise<HoldInvoice> {
    const result = await createHodlInvoice({
      lnd: this.lnd,
      id: params.paymentHash,
      tokens: params.amountSats,
      expires_at: toExpiresAt(this.now(), params.expirySeconds),
      // The invoice's own final delta, which a payer must honour. Omitted
      // rather than defaulted when the caller does not ask, so LND keeps
      // whatever its own default is.
      ...(params.minFinalCltvBlocks === undefined ? {} : { cltv_delta: params.minFinalCltvBlocks }),
    })
    // LND hands out exactly the invoice it minted — there is no wrapping here,
    // so the payer's amount and the held amount are the same number.
    return { id: result.id, invoice: result.request, paymentHash: params.paymentHash, payableSats: params.amountSats }
  }

  async getHoldState(paymentHash: string): Promise<HoldState> {
    const invoice = await getInvoice({ lnd: this.lnd, id: paymentHash })
    const status = toHoldStatus(invoice)
    return {
      status,
      // NOT `invoice.expires_at`. That is the BOLT11 validity window — how long
      // the invoice stays PAYABLE — and it stops meaning anything the moment an
      // HTLC is accepted against it. The deadline the port asks for is the held
      // HTLC's own CLTV timeout, which LND reports as a block HEIGHT on
      // `payments[]` (`timeout`; the vendor's rename of LND's
      // `htlcs[].expiry_height`). Reading the wrong one of the two made every
      // receive swap fail `MIN_SETTLE_WINDOW` and refuse to fund.
      expiresAt: status === 'armed' ? await this.heldHtlcDeadline(invoice.payments) : null,
      amountSats: invoice.tokens,
    }
  }

  /**
   * The self-payment probe (see the port's contract). `getInvoice` answers
   * for ANY invoice this node minted — hold or plain — so this covers both
   * the receive corridor's hold invoices and an out-of-band `lncli
   * addinvoice` on the same node.
   */
  async getOwnInvoiceState(paymentHash: string): Promise<HoldState | null> {
    try {
      const invoice = await getInvoice({ lnd: this.lnd, id: paymentHash })
      // The probe only ever reads the status (ours? unpaid?); the deadline is
      // the receive loop's business, and computing it here would only cost a
      // second RPC on the one call this makes.
      return { status: toHoldStatus(invoice), expiresAt: null, amountSats: invoice.tokens }
    } catch (error) {
      // "Not found" is the one rejection that means something here: the hash
      // is not one of ours. Everything else — transport, permission, a wedged
      // node — rethrows, because mistaking an unreachable node for "not ours"
      // would quietly skip the instant refund a self-payment is owed.
      if (isInvoiceNotFound(error)) return null
      throw error
    }
  }

  /**
   * `E` for the currently held HTLCs, unix seconds, or null if none is held.
   *
   * The chain height is read here rather than passed in because it must be the
   * height the SAME node sees: `timeout` is a height on LND's own chain view,
   * and differencing it against anyone else's would be comparing two clocks.
   * The read only happens once an HTLC is actually armed, so the polling that
   * precedes payment costs nothing extra.
   */
  private async heldHtlcDeadline(payments: readonly HeldHtlc[]): Promise<number | null> {
    const timeoutHeight = heldTimeoutHeight(payments)
    // `is_held` on the invoice should guarantee a held HTLC underneath it, so
    // this is unreachable in practice. Null (rather than a guess) is still the
    // right answer if it ever happens: the funding gate reads it as "nothing
    // armed" and declines, which is the safe direction.
    if (timeoutHeight === null) return null
    const { current_block_height } = await getWalletInfo({ lnd: this.lnd })
    return htlcDeadlineFromHeight(timeoutHeight, current_block_height, this.now())
  }

  async settleHold(preimage: string): Promise<void> {
    // Rejects with SecretDoesNotMatchAnyExistingHodlInvoice / NOT_FOUND-shaped
    // errors until the HTLC is actually armed. Retrying is the caller's job,
    // same as on any other rail.
    await settleHodlInvoice({ lnd: this.lnd, secret: preimage })
  }

  /**
   * Retire an unpaid invoice so nothing can pay it later.
   *
   * LND's own `cancelHodlInvoice` would also fail an ARMED htlc back, but the
   * port promises nothing about armed invoices — a backend exposing no cancel
   * at all cannot do it — so this stays inside the narrower contract the
   * caller is written against.
   * Nothing here re-checks `armed`: that is the caller's gate, and duplicating
   * it would add a round trip that races anyway.
   *
   * Idempotency is matched on the error TEXT, which is the weak part of this
   * and is deliberately written wide. LND has several ways of saying "there is
   * nothing here to cancel" — an unknown hash, an invoice already cancelled, a
   * settled one, an htlc already in a terminal state — and only the unknown-hash
   * shape has been observed against a live node. Matching narrowly would turn a
   * second cancel into a throw, which is exactly what the port promises it is
   * not; matching wide costs only that a genuinely novel failure is swallowed,
   * and the sole caller (`retireCoupledInvoice`) swallows everything anyway
   * because a failed cancel must never cost a payout.
   *
   * If this ever needs to be tightened, tighten it against strings captured
   * from a real node rather than guessed.
   */
  async cancelHold(paymentHash: string): Promise<void> {
    try {
      await cancelHodlInvoice({ lnd: this.lnd, id: paymentHash })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/not.?found|already.*(cancel|settl)|terminal state|invoice.*(cancel|settl)ed/i.test(message)) return
      throw error
    }
  }

  /** `this.lnd` is one raw gRPC client per LND subservice — close every one. */
  async close(): Promise<void> {
    for (const client of Object.values(this.lnd)) {
      ;(client as { close?: () => void })?.close?.()
    }
  }
}
