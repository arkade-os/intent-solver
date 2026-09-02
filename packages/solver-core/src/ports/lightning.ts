/**
 * The Lightning backend port.
 *
 * This interface is the seam between the swap logic and whichever Lightning
 * implementation actually moves the sats. Nothing ABOVE this port may import a
 * backend SDK: the core state machines, the API layer and the Arkade side all
 * speak only in terms of this port. Swapping implementations must not require a
 * change anywhere else in the tree. Below it, the adapter layer is the
 * subdirectories of `src/ln/` — plus, where a backend serves the onchain side
 * off the same connection, whatever module owns that shared connection.
 *
 * Types here are deliberately plain — hex strings and unix seconds — so no vendor
 * type escapes the adapter boundary.
 */

/** Where a Lightning payment we initiated has got to. */
export type PaymentStatus = 'pending' | 'succeeded' | 'failed'

/**
 * What the backend KNOWS about the payment, as distinct from where it has got
 * to.
 *
 * `no_record` is the strongest of the three — the backend never heard of the hash, so
 * the sats provably never left. `status` alone cannot say that: it reports `failed`,
 * exactly like a payment that was attempted and died.
 *
 * Deliberately no `wedged`. A stalled payment and a healthy in-flight one are
 * indistinguishable from what a backend reports, since `is_pending` is derived as
 * `!payment && !failed` and "pending but not being worked on" is not expressible. The
 * `paying` event's `paths[]` is the nearest signal, but LND empties it between retries,
 * so an empty read would flag healthy payments as stalled far more often than stalled
 * ones.
 *
 * Diagnostic only. Nothing decides whether money moves on this.
 */
export type PaymentEvidence = 'no_record' | 'in_flight' | 'terminal'

/**
 * Why a payment failed, in the port's own vocabulary rather than a vendor's.
 *
 * `rejected_by_destination` is the one that matters most in practice: it is how
 * an invoice a third party has already settled comes back.
 */
export type PaymentFailureReason =
  | 'rejected_by_destination'
  | 'insufficient_balance'
  | 'pathfinding_timeout'
  | 'route_not_found'
  | 'canceled'
  | 'unknown'

export interface PaymentResult {
  /** Backend-assigned id, used to poll for the preimage. */
  id: string
  status: PaymentStatus
  /**
   * What the backend knows, where it can say so.
   *
   * Optional because a backend that cannot answer honestly must not guess —
   * the same reason `getOwnInvoiceState` below is optional.
   */
  evidence?: PaymentEvidence
  /** Present only alongside a `failed` status. */
  failureReason?: PaymentFailureReason
  /**
   * `P`, hex, once known.
   *
   * Frequently absent on the first response even for a payment that ultimately
   * succeeds, so callers must poll `getPayment` rather than treat a missing
   * preimage as failure.
   */
  preimage?: string
}

/**
 * The backend refuses to attempt this payment because it already holds a
 * registration against the payment hash.
 *
 * Says NOTHING about whether funds moved, and callers must not infer it. Paired with
 * {@link SendBackend.getSendHtlcState} answering null it is a contradiction — the
 * backend both holds nothing for this hash and refuses to pay it because it holds
 * something — which is how an ORPHANED registration shows: permanently unpayable and
 * unclearable by retrying.
 *
 * That contradiction is grounds to STOP, never to move money. On the incident that
 * produced this type the backend's own lookup answered null from every role while a
 * registration demonstrably existed, so its null is not evidence that nothing was
 * committed; only the wallet's transfer history was.
 */
export class PaymentHashRegistered extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'PaymentHashRegistered'
  }
}

/** Where a hold invoice we issued has got to. */
export type HoldStatus =
  /** Issued; nothing has arrived. */
  | 'pending'
  /** An incoming HTLC is being held. It can now be settled. */
  | 'armed'
  /** Settled with the preimage; we have been paid. */
  | 'settled'
  /** Gone — lapsed or failed back. Nothing further is possible. */
  | 'cancelled'
  /**
   * The backend reported a status this build does not know.
   *
   * A vendor enum can grow a value at any version bump, and each of the four above is
   * a CLAIM a status we never compiled against cannot support. Every way of guessing
   * costs money in one direction or the other:
   *
   * - guessing `armed` funds an Arkade payout against an HTLC that may be dead, so the
   *   solver pays out and cannot collect;
   * - guessing `cancelled` or `pending` hands back a lockup while the payee may still
   *   collect, so the solver pays twice.
   *
   * Which is costly depends on the caller, so the port refuses to choose and each
   * caller fails safe without a branch for this value: the receive path acts only on an
   * exact `armed`, and the self-payment refund withholds unless the status is exactly
   * `pending` or `cancelled`.
   *
   * A backend whose statuses are TOTAL never returns this — `lnd`'s reads four
   * booleans, so it has no unknown to report.
   */
  | 'unknown'

export interface HoldState {
  status: HoldStatus
  /**
   * `E`: the deadline by which an armed HTLC must be settled, unix seconds, or
   * null when nothing is armed yet.
   *
   * Always read this from the backend. It is the backend's choice and can be
   * shorter than any documented default; assuming a value is exactly how a
   * provider pays out on the Arkade side and then fails to collect.
   */
  expiresAt: number | null
  amountSats?: number
}

export interface CreateHoldInvoiceParams {
  amountSats: number
  /** `sha256(P)`, hex. The provider never sees P until the swap reveals it. */
  paymentHash: string
  expirySeconds: number
  /**
   * Minimum final CLTV delta to encode in the invoice, in blocks.
   *
   * The ONE lever the receive corridor has over `E`: everything else about the htlc's
   * deadline is the payer's route to choose, while the final delta is ours and a payer
   * must honour it. Without it the only safe answer to a short `E` is to decline after
   * the money is already committed (`evaluateReceiveFunding` gate (d)).
   *
   * A BACKEND THAT CANNOT SET IT MUST THROW, never silently ignore it — ignoring
   * produces exactly the too-short `E` this prevents, with no way for the caller to
   * tell.
   */
  minFinalCltvBlocks?: number
}

export interface HoldInvoice {
  /** Backend-assigned id. */
  id: string
  /** The BOLT11 string to hand to the payer. */
  invoice: string
  paymentHash: string
  /**
   * What {@link HoldInvoice.invoice} actually asks for, in sats.
   *
   * Usually {@link CreateHoldInvoiceParams.amountSats} back again. Reported separately
   * because a backend may hand out an invoice that WRAPS the one it minted — same
   * payment hash, so both settle atomically on one preimage, but asking slightly more
   * to cover the wrapper's routing reserve. The client pays THIS number, so this is
   * what the corridor must quote.
   *
   * NOT what the provider receives: the held HTLC is still worth `amountSats` and the
   * payout was priced off that, so nothing downstream may substitute this for it.
   */
  payableSats: number
}

export interface PayInvoiceParams {
  invoice: string
  maxFeeSats: number
  /** Stable per-swap key so a retried call cannot pay twice. */
  idempotencyKey: string
  /**
   * Longest the payment may keep an HTLC alive, in blocks FROM NOW.
   *
   * From `payableCltvBlocks`: the worst case the refund deadline was quoted against,
   * clamped by how much of that deadline is left right now. A backend that can enforce
   * it must, because an outbound HTLC outliving the deadline is what lets a client
   * refund the lockup and only then settle, taking both sides.
   *
   * "From now" is the reason for the clamp: this is a delta measured at PAYMENT time
   * while `refundLocktime` is absolute and fixed at QUOTE time, so the unclamped worst
   * case would widen the HTLC's reach by however long funding took.
   *
   * Required, not optional, so a send path that forgets to bound its payment fails to
   * compile. Backends that cannot express a ceiling ignore it.
   */
  maxCltvBlocks: number
}

export interface Balance {
  availableSats: number
  incomingSats: number
}

/**
 * What the backend has COMMITTED against a payment hash on the send side, as
 * distinct from what it will tell us about a payment id.
 *
 * A payment id names a request the backend already acknowledged; this names an
 * obligation that can exist BEFORE any id does. A backend may commit our funds against
 * the hash one call before the one that mints the id, and key that commitment on the
 * hash rather than on our idempotency key — so a failure in between leaves sats
 * committed with nothing on disk naming them, and the commitment does not replay. Only
 * a lookup by HASH finds it.
 */
export type SendHtlcStatus =
  /** Our sats are committed; the payee has not revealed. Undecided. */
  | 'committed'
  /** The preimage was revealed against our commitment: we PAID. */
  | 'settled'
  /** The commitment was unwound and the funds came back. We paid nothing. */
  | 'returned'

export interface SendHtlcState {
  status: SendHtlcStatus
  /**
   * `P`, hex, present only alongside `settled`.
   *
   * A `settled` state without one is money gone that we cannot claim against,
   * which is an operator's problem rather than something to resolve
   * automatically — callers must not treat its absence as a failure.
   */
  preimage?: string
}

/**
 * The send leg's view of the backend: pay an invoice, learn its preimage.
 *
 * Segregated from the receive surface so a send-only consumer (the orchestrator)
 * and a send-only implementation (the regtest fake) neither narrow nor stub what
 * they do not touch.
 */
export interface SendBackend {
  /**
   * CLTV this backend's routes may add, in blocks — and by declaring it, whether
   * {@link PayInvoiceParams.maxCltvBlocks} is a CEILING or merely a hope.
   *
   * The backend answers because only it knows. One that can enforce the ceiling (LND,
   * via `max_timeout_height`) may quote `ROUTE_CLTV_BUDGET_BLOCKS`, since being wrong
   * costs a refused payment. One whose pay call exposes no max-CLTV control must quote
   * `UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS`, a bound on any route the network would
   * carry, because being wrong THERE costs an HTLC outliving the refund deadline.
   *
   * Feeds `refundLocktimeFor` at quote time, so the deadline a client is given already
   * accounts for how much this rail can be trusted.
   */
  readonly routeCltvBudgetBlocks: number

  /**
   * Whether this backend CAPS the route's CLTV, as opposed to merely being
   * handed a number — LND's `cltv_limit`, reached through
   * {@link PayInvoiceParams.maxCltvBlocks}.
   *
   * Declared separately from {@link routeCltvBudgetBlocks} rather than inferred
   * from it. The two answer the same underlying question today and the budgets
   * happen to differ per answer, but reading `routeCltvBudgetBlocks !==
   * UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS` as "enforces" is a magic-number
   * coincidence: an adapter that enforced while quoting the conservative budget
   * (or the reverse) would be read backwards by the comparison and correctly by
   * this flag.
   *
   * What reads it is the send leg's route-hint policy. Route hints are
   * ALTERNATIVES, so an invoice with one bad hint among several is payable
   * wherever the rail can decline the bad route — and unservable where it
   * cannot, because there the bad hint is an HTLC that may outlive the client's
   * refund deadline. See `hintCltvBlocks` in `core/send.ts`.
   */
  readonly enforcesRouteCltv: boolean

  /** Spendable and still-unclaimed balance. */
  getBalance(): Promise<Balance>

  payInvoice(params: PayInvoiceParams): Promise<PaymentResult>

  /**
   * A stable, PUBLIC identifier for the wallet this backend is pointed at.
   *
   * Recorded with every payment so a later reader can tell "the provider lost the
   * record" from "this row was paid by a wallet you no longer run". Both otherwise
   * surface as a lookup finding nothing, and the second is a configuration change
   * rather than a fault.
   *
   * MUST be public and stable — a node or identity pubkey, never a secret and never
   * anything that rotates on reconnect. It exists to be COMPARED, not kept.
   *
   * Optional: a backend that cannot name its wallet records null, and null means
   * "unknown", never "matches".
   */
  walletFingerprint?(): Promise<string>

  /** Poll a payment for its terminal status and, on success, its preimage. */
  getPayment(id: string): Promise<PaymentResult>

  /**
   * What this backend has committed against a payment hash, or null when it has
   * committed nothing — see {@link SendHtlcState}.
   *
   * The send leg asks BEFORE re-submitting a payment it has no id for. Without
   * it the only available assumption is that re-submitting is harmless, and on
   * a backend that commits against the hash that assumption is false: the retry
   * cannot succeed, so the row spins while the sats sit committed and the
   * preimage that would claim the client's lockup is never read.
   *
   * Optional, for the same reason {@link ReceiveBackend.getOwnInvoiceState} is:
   * a backend that cannot answer honestly must not guess. Omitting it degrades
   * to the old behaviour — re-submit and hope — which is correct wherever the
   * pay call really is idempotent. Implementations must distinguish "nothing
   * committed" (null) from "cannot say" (throw); reporting the second as the
   * first would re-submit against a live commitment.
   */
  getSendHtlcState?(paymentHash: string): Promise<SendHtlcState | null>

  /**
   * Release any long-lived connection (a gRPC channel, a websocket, a local
   * database). Optional because the fake backend holds nothing; the real ones
   * need it. Missing it on LND specifically crashes the process on exit on
   * Windows — a forced `process.exit()` racing an open gRPC channel's own async
   * handles hits a libuv assertion there that Linux/Mac tolerate silently.
   *
   * On a backend that embeds its own store it also releases that database and
   * stops any background sync — and where such a backend serves BOTH legs, its
   * Lightning and onchain adapters close the same shared connection, because one
   * process holds exactly one. That makes close idempotent by construction rather
   * than by luck, but it also means the two adapters share a lifetime that no
   * type here expresses: closing either ends both. Shut them down together.
   */
  close?(): Promise<void>
}

/** The receive leg's view: issue a hold invoice and settle it with the preimage. */
export interface ReceiveBackend {
  createHoldInvoice(params: CreateHoldInvoiceParams): Promise<HoldInvoice>

  /** Read the hold's status and, once armed, its settle deadline `E`. */
  getHoldState(paymentHash: string): Promise<HoldState>

  /** Settle a held HTLC by revealing the preimage. `preimage` is hex. */
  settleHold(preimage: string): Promise<void>

  /**
   * Our own node's record of an invoice THIS node issued, looked up by
   * payment hash — or null when the hash is not one of ours. The
   * self-payment probe: the send leg's terminal-failure path uses it to tell
   * "we tried to pay ourselves" apart from an ordinary failed payment, which
   * is the ONE case where the payee's record being ours to read makes
   * auto-refund safe without trusting the payer-side "failed" verdict.
   *
   * Optional because a backend that cannot answer honestly must not guess: an
   * HTLC query that returns `pending` for a hash it has never seen cannot back
   * this probe, since an implementation over it would answer "ours, unpaid" for
   * EVERY hash — which would turn the narrow self-payment exception into an
   * auto-refund of every terminal failure. Omitting the probe degrades
   * self-payments to the
   * ordinary `stuck` path instead. Implementations must also distinguish
   * "unknown hash" (null) from "node unreachable" (throw) — mistaking the
   * second for the first would skip a refund the row was owed; throwing keeps
   * the conservative outcome.
   */
  getOwnInvoiceState?(paymentHash: string): Promise<HoldState | null>

  /**
   * Retire an invoice that has NOT been paid, so nothing can pay it later.
   *
   * Narrow on purpose. This is NOT "abort a hold and free the payer": once an
   * HTLC is armed the only two outcomes remain settle, or wait for `E`. The
   * receive leg still refuses to fund rather than funding and backing out, and
   * any flow that assumes it can release a held HTLC early is still
   * unimplementable here — the port promises nothing about armed invoices, and
   * callers must check `getHoldState` before calling this.
   *
   * That narrowness is not pedantry, it is the honest ceiling of the backends.
   * LND's `cancelHodlInvoice` will fail a held HTLC back; a backend that exposes
   * no cancel at all cannot. Promising the stronger behaviour would be promising
   * something only some adapters can keep.
   *
   * Optional for that reason, like {@link getOwnInvoiceState}: a backend that
   * cannot do it omits it, and the one caller degrades to leaving the invoice
   * to lapse — safe, just untidier.
   *
   * Must be idempotent: cancelling an already-cancelled or expired invoice is
   * a no-op, not an error. Callers use this to close off a payment that must
   * never happen, so a second attempt is routine rather than a fault.
   */
  cancelHold?(paymentHash: string): Promise<void>
}

/** A full backend serves both legs; the vendor adapter implements this. */
export type LightningBackend = SendBackend & ReceiveBackend
