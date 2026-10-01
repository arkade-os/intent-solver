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
  createInvoice as lndCreateInvoice,
  getChannelBalance as lndGetChannelBalance,
  getInvoice as lndGetInvoice,
  getPayment as lndGetPayment,
  getRoutingFeeEstimate as lndGetRoutingFeeEstimate,
  getWalletInfo as lndGetWalletInfo,
  payViaPaymentRequest,
  settleHodlInvoice,
  subscribeToInvoice,
  type AuthenticatedLnd,
} from 'lightning'
import { deadlined, LND_READ_TIMEOUT_MS } from '../../deadline.js'
import { htlcDeadlineFromHeight } from '@arkade-os/solver-core/core/receive.js'
import { ROUTE_CLTV_BUDGET_BLOCKS } from '@arkade-os/solver-core/core/send.js'
import { expiresAtOf, paymentHashOf } from '@arkade-os/solver-core/invoice/decode.js'
import { messageOf, nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import type {
  PaymentEvidence,
  PaymentFailureReason,
  Balance,
  CreateHoldInvoiceParams,
  EstimateSendFeeParams,
  HoldInvoice,
  HoldState,
  HoldStatus,
  LightningBackend,
  PayInvoiceParams,
  PaymentResult,
  PaymentStatus,
  SendFeeEstimate,
} from '@arkade-os/solver-core/ports/lightning.js'

// The reads, bounded. Every call site below is left as it was; `getPayment` is
// not here because it is `payInvoice`'s reconcile path. @see ../../deadline.ts.
const getChannelBalance = deadlined('getChannelBalance', lndGetChannelBalance)
const getInvoice = deadlined('getInvoice', lndGetInvoice)
const getRoutingFeeEstimate = deadlined('getRoutingFeeEstimate', lndGetRoutingFeeEstimate)
const getWalletInfo = deadlined('getWalletInfo', lndGetWalletInfo)

/**
 * `payViaPaymentRequest` rejections meaning the payment provably did not leave, each mapped to the reason the
 * vendor's `checkFailure` gives the matching `failed{}` flag (`finished_payment.js`), so `getPayment` agrees.
 * Anything else stays `pending`: the costly error is calling a live payment dead. The last is the vendor's
 * pre-flight CLTV guard, raised before `sendPaymentV2`: nothing was sent, and no route fits the ceiling.
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

export const FAILED_PAYMENT_REASONS: Set<string> = new Set(Object.keys(REJECTION_FAILURE_REASONS))

/**
 * `lightning`'s promise rejections are `[code, reason, details?]` tuples, not
 * `Error`s. Pull the reason out where present so it can be checked against
 * {@link FAILED_PAYMENT_REASONS}.
 */
export const rejectionReason = (error: unknown): string | undefined =>
  Array.isArray(error) && typeof error[1] === 'string' ? error[1] : undefined

/**
 * The boot round-trip, so a bad cert/macaroon/socket fails at startup. Rethrown as an `Error`: the vendor's
 * tuple prints as `503,GetWalletInfoErr,[object Object]`, hiding the gRPC status that names the cause.
 */
export const probeLnd = async (lnd: AuthenticatedLnd, socket: string): Promise<void> => {
  try {
    await getWalletInfo({ lnd })
  } catch (error) {
    const inner = Array.isArray(error) ? (error[2] as { err?: unknown } | undefined)?.err : undefined
    const reason = rejectionReason(error) ?? messageOf(error)
    const detail = inner instanceof Error ? `${reason}: ${inner.message}` : reason
    throw new Error(`LND at ${socket} did not answer getWalletInfo: ${detail}`, { cause: error })
  }
}

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
  /**
   * `fee_mtokens` is the routing fee actually paid. Not `safe_fee`, the vendor's whole-sat rounding:
   * `feeSatsFromMtokens` rounds UP from millisats. Optional because older vendor versions omit it, and an
   * absent fee must read as unmeasured, never free.
   */
  payment?: { secret: string; fee_mtokens?: string }
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

/**
 * The realized fee as a spreadable fragment, `{}` when absent. Swallows an unreadable figure, unlike the ESTIMATE
 * path: the payment settled and the preimage is in hand, so throwing would strand a successful swap over a report.
 * KNOWN IMPRECISION (#155): rounding UP overstates realized cost by up to a sat each. The fix is carrying millisats
 * through analytics, NOT round-to-nearest, which would report a real sub-sat fee as free.
 */
const realizedFeeSats = (mtokens: string | undefined): { feePaidSats?: number } => {
  if (mtokens === undefined) return {}
  try {
    return { feePaidSats: feeSatsFromMtokens(mtokens) }
  } catch {
    return {}
  }
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
    return {
      id,
      status,
      preimage: result.payment.secret,
      evidence: 'terminal',
      // Omitted, never zeroed, when the vendor did not report one — a payment
      // whose cost is unknown must not read as a payment that was free. The
      // read is guarded because this is the SUCCESS path: an unparseable fee is
      // not worth failing a settled payment over, and the rest of this result
      // (the preimage above all) is what the swap actually needs to proceed.
      ...realizedFeeSats(result.payment.fee_mtokens),
    }
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
 *
 * LND has TWO ways of saying it and only one is NOT_FOUND: against an EMPTY
 * invoice bucket it answers ErrNoInvoicesCreated, "there are no existing
 * invoices", which does not arrive as NOT_FOUND. A node that only ever pays
 * gives that answer to every probe, so the probe threw instead of answering
 * "not ours" (#102). Matched on the message and NOT on a status: the one it
 * carries instead was never measured, so constraining on a guess re-breaks it.
 */
export const isInvoiceNotFound = (error: unknown): boolean => {
  if (!Array.isArray(error) || error[1] !== 'UnexpectedLookupInvoiceErr') return false
  const inner = (error[2] as { err?: { code?: number; details?: string } } | undefined)?.err
  return (
    inner?.code === 5 ||
    (typeof inner?.details === 'string' &&
      /unable to locate invoice|there are no existing invoices/i.test(inner.details))
  )
}

/**
 * Shortest probe budget this adapter will ask for, in milliseconds.
 *
 * The vendor converts our millisecond ceiling to whole seconds with `Math.round` and
 * then treats a zero as "unset", falling back to its OWN sixty-second default
 * (`get_routing_fee_estimate.js`: `timeout: msAsSecs(timeout) || defaultTimeoutSeconds`).
 * So a caller asking for 200ms would buy the longest probe on offer rather than the
 * shortest, and the ceiling `EstimateSendFeeParams.timeoutMs` exists to impose would
 * invert into its opposite at exactly the value a caller in a hurry would pick. Flooring
 * at one whole second is the only budget that survives the conversion.
 */
export const MIN_ROUTE_FEE_PROBE_MS = 1000

export const probeTimeoutMs = (timeoutMs: number): number => Math.max(MIN_ROUTE_FEE_PROBE_MS, timeoutMs)

/**
 * LND answers in millisats, as a decimal string; the port speaks whole sats.
 *
 * Rounds UP, per {@link SendFeeEstimate.feeSats}: a fee reported a sat low is a quote
 * priced a sat low, which the solver pays out of its own spread on every swap.
 *
 * Throws rather than coercing an unparseable figure, because every fallback is worse. A
 * NaN would compare false against every cap and floor downstream; a silent 0 would quote
 * a free execution. The throw lands in `estimateSendFee`'s unrecognised branch, which is
 * where a response this adapter cannot read belongs.
 */
export const feeSatsFromMtokens = (mtokens: string): number => {
  // DIGITS ONLY, because `Number('')`, `Number(' ')` and `Number('\t')` are all
  // 0 — so a blank figure read as a route that cost NOTHING rather than one that
  // could not be read. Zero is a fact here and blank is the absence of one, and
  // both callers need them apart: an estimate that cannot be read must stop a
  // quote priced on it, and a realized cost that cannot be read is unmeasured,
  // never free. The same test rejects `1e3` and `0x10`, which `Number` accepts
  // and a wire integer should never be.
  if (!/^\d+$/.test(mtokens)) throw new Error(`LND reported an unreadable routing fee: ${mtokens}`)
  const msat = Number(mtokens)
  if (!Number.isFinite(msat)) throw new Error(`LND reported an unreadable routing fee: ${mtokens}`)
  return Math.ceil(msat / 1000)
}

/**
 * Whether a `getRoutingFeeEstimate` rejection is one of the ordinary misses the port
 * answers null for, rather than a fault to re-throw.
 *
 * These shapes mean "no number for this payment" rather than "the node is
 * broken":
 *
 *  - `RouteToDestinationNotFound` — the vendor's own mapping of any
 *    `failure_reason` other than none, so it covers the probe finding no route AND the
 *    probe running out of the time it was given. Neither is a verdict on whether the
 *    invoice is payable: a probe fails where a payment succeeds, which is why the port
 *    forbids reading a null as a reason to decline the swap.
 *  - a nested gRPC UNIMPLEMENTED — `estimateRouteFee` does not exist before LND 0.18.4,
 *    so an older node rejects every call. A permanent, knowable absence of the
 *    capability, which is precisely what null is for.
 *  - LND rejecting a probe to its own node. The existing self-payment path decides
 *    that swap from the payee-side invoice state; the probe has no fee to add.
 *
 * UNAVAILABLE is deliberately NOT here. A node that cannot be reached is the same fault
 * every other call on this adapter would hit, and reporting it as "no estimate" would
 * leave a dead backend looking exactly like a working one whose routes happen to be
 * unpriceable — quotes would silently fall back to the configured flat and nothing would
 * ever say why.
 */
export const isNoFeeEstimate = (error: unknown): boolean => {
  if (!Array.isArray(error)) return false
  if (error[1] === 'RouteToDestinationNotFound') return true
  if (error[1] !== 'UnexpectedGetRoutingFeeEstimateError') return false
  const cause = (error[2] as { err?: { code?: number; details?: string } } | undefined)?.err
  return cause?.code === 12 || (cause?.code === 2 && cause.details === 'self-payments not allowed')
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

  private constructor(private readonly lnd: AuthenticatedLnd) {}

  static async create(config: AdapterConfig): Promise<LndLightningBackendAdapter> {
    const { lnd } = authenticatedLndGrpc({
      socket: config.socket,
      cert: config.cert,
      macaroon: config.macaroon,
    })
    await probeLnd(lnd, config.socket)
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
      // A payment that settles inside this call never reaches `getPayment`, so
      // capturing the fee only on the polled path would lose it for every fast
      // route — which is most of them.
      return {
        id: result.id,
        status: 'succeeded',
        preimage: result.secret,
        // `result.fee_mtokens`, NOT a cast. `PayViaPaymentRequestResult` declares
        // it top-level and required (`lightning@12.2.3`), so reading it through
        // the vendor's own type means a rename in a future version fails the
        // build — where a cast keeps compiling and quietly reports every
        // payment as having cost nothing.
        ...realizedFeeSats(result.fee_mtokens),
      }
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

  /**
   * PROBES the invoice via `estimateRouteFee`, not `queryroutes`: that would need the route hints and payment
   * address rebuilt from the BOLT11, and a dropped one prices a different payment. A probe sends real HTLCs that
   * fail at the destination; LND documents that it can outlast its `timeout` and that `routing_fee_msat` is a
   * LOWER bound. Still better than the flat an operator guessed at boot.
   */
  async estimateSendFee(params: EstimateSendFeeParams): Promise<SendFeeEstimate | null> {
    try {
      const probeMs = probeTimeoutMs(params.timeoutMs)
      const estimate = await getRoutingFeeEstimate(
        { lnd: this.lnd, request: params.invoice, timeout: probeMs },
        // ABOVE the caller's own budget: LND documents that probing can outlast
        // the timeout it was given, so a deadline at it would cut a live probe.
        probeMs + LND_READ_TIMEOUT_MS,
      )
      return { feeSats: feeSatsFromMtokens(estimate.fee_mtokens) }
    } catch (error) {
      if (isNoFeeEstimate(error)) return null
      throw error
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
      expires_at: toExpiresAt(nowSeconds(), params.expirySeconds),
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

  /** Per-invoice stream: only LND's single-invoice subscription reports ACCEPTED for a hold. */
  onHoldAccepted(paymentHash: string, onHeld: () => void): () => void {
    const sub = subscribeToInvoice({ lnd: this.lnd, id: paymentHash })
    const stop = (): void => {
      sub.removeAllListeners()
    }
    sub.on('invoice_updated', (invoice: { is_held?: boolean; is_confirmed?: boolean; is_canceled?: boolean }) => {
      if (invoice.is_held) onHeld()
      if (invoice.is_held || invoice.is_confirmed || invoice.is_canceled) stop()
    })
    // A dropped stream only loses the fast path; the sweep still finds the hold.
    sub.on('error', stop)
    return stop
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
    return htlcDeadlineFromHeight(timeoutHeight, current_block_height, nowSeconds())
  }

  async settleHold(preimage: string): Promise<void> {
    // Rejects with SecretDoesNotMatchAnyExistingHodlInvoice / NOT_FOUND-shaped
    // errors until the HTLC is actually armed. Retrying is the caller's job,
    // same as on any other rail.
    await settleHodlInvoice({ lnd: this.lnd, secret: preimage })
  }

  /**
   * Retire an unpaid invoice. Does not re-check `armed`: that is the caller's gate, and a re-check races anyway.
   * Idempotency matches LND's error TEXT, deliberately wide: only the unknown-hash shape was observed live, and a
   * narrow match would turn a second cancel into a throw. Tighten only against strings captured from a real node.
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

  /**
   * A plain invoice for an operator funding this node, never a swap — so not a hold, which would wait forever on
   * a preimage nothing here stores. `expiresAt` is decoded OFF THE BOLT11: that is what a payer enforces, and
   * `createInvoice`'s result carries no expiry at all (reading it gives `NaN`).
   */
  async createInvoice(params: { amountSats?: number; memo?: string }): Promise<{
    invoice: string
    expiresAt: number
  }> {
    const created = await lndCreateInvoice({
      lnd: this.lnd,
      // Omitted rather than zero: `tokens: 0` is a zero-amount invoice on some
      // nodes and an amountless one on others, and the two differ in whether a
      // payer may choose. Leaving it out is unambiguously amountless.
      ...(params.amountSats === undefined ? {} : { tokens: params.amountSats }),
      ...(params.memo === undefined ? {} : { description: params.memo }),
    })
    // `expiresAtOf`, NOT `decodeInvoice`: the latter requires an amount and this
    // invoice deliberately has none, so it threw `missing_amount` on every
    // deposit invoice this ever minted. See its doc comment in `invoice/decode.ts`.
    return { invoice: created.request, expiresAt: expiresAtOf(created.request) }
  }

  /** `this.lnd` is one raw gRPC client per LND subservice — close every one. */
  async close(): Promise<void> {
    for (const client of Object.values(this.lnd)) {
      ;(client as { close?: () => void })?.close?.()
    }
  }
}
