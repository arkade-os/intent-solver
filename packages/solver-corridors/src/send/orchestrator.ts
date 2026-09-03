/**
 * The send-leg orchestrator: the one place quote/fund/pay/claim is driven.
 *
 * Everything here is written against two rules:
 *
 * 1. **The row is the truth.** Every step reads the row, decides, and commits the
 *    outcome before the next step. A crash at any point leaves a row from which
 *    `tick` resumes without repeating a payment — intent is committed BEFORE the
 *    irreversible side effect (the compare-and-swap into `paying`), the outcome
 *    immediately after.
 *
 * 2. **One step, many callers.** `tick` is safe to call from an interval loop, a
 *    CLI, an HTTP handler and a recovery sweep at the same time: an in-process
 *    guard stops duplicate RPC work, and the store's compare-and-swap ensures at
 *    most one caller ever wins the transition that spends money.
 *
 * The orchestrator does no I/O of its own: Lightning goes through the
 * {@link SendBackend} port, Arkade through {@link ArkadeOps}. Both are injected,
 * which is also what makes the state machine testable without a network.
 */

import { randomUUID } from 'node:crypto'
import type { AdmissionStrategy } from '@arkade-os/solver-core/core/admissionStrategy.js'
import { RFQ_PAIR_SEND } from '../wire/payloads.js'
import { ArkAddress } from '@arkade-os/sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import {
  DEFAULT_LOCKUP_TIMEOUT,
  evaluateCouplingDeadlines,
  evaluateSendAcceptance,
  evaluateSendPayment,
  lockupDeadlineFor,
  payableCltvBlocks,
  deadlineContainsHtlc,
  type SendAcceptanceRefusal,
} from '@arkade-os/solver-core/core/send.js'
import { maxRoutingFeeSats, type Limits } from '@arkade-os/solver-core/core/limits.js'
import { QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS, RateLimiter } from '@arkade-os/solver-core/core/rateLimit.js'
import { FREE, giveSatsFor, type Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import {
  absoluteLocktimeIn,
  absoluteLocktimeReached,
  absoluteLocktimeSeconds,
  absoluteLocktimeUnit,
  relativeDelayFrom,
} from '@arkade-os/solver-core/core/timelocks.js'
import type { ChainTipProvider } from '@arkade-os/solver-rails/onchain/chainTip.js'
import { decodeInvoice, type DroppedHint } from '@arkade-os/solver-core/invoice/decode.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { unilateralExitRecourse } from '@arkade-os/solver-arkade/arkade/unilateralExit.js'
import type { HoldState, ReceiveBackend, SendBackend, SendHtlcState } from '@arkade-os/solver-core/ports/lightning.js'
import { PaymentHashRegistered } from '@arkade-os/solver-core/ports/lightning.js'
import type { ReceiveSwapRow } from '../db/receiveSwaps.js'
import type { SendSwapRow, SendSwapState, SwapStore } from '../db/swaps.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'

import type { CovenantScriptRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'
export type { CovenantScriptRow }

import type { ArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
export type { ArkadeOps }

/**
 * What this corridor needs to read off a coupled RECEIVE row: whether it is
 * still awaiting payment, which bolt11 it minted, when the htlc it took
 * expires, when our recourse on it opens, and where its payout is locked.
 *
 * A `Pick` rather than the whole `ReceiveSwapRow` so the send leg depends on
 * five fields instead of that corridor's entire shape — the real store
 * satisfies it structurally, and a test fake needs no cast.
 */
export type CoupledReceiveRow = Pick<
  ReceiveSwapRow,
  'state' | 'invoice' | 'refundLocktime' | 'pkScript' | 'htlcExpiresAt'
>

export interface SendServiceDeps {
  store: SwapStore
  /**
   * The send half drives payments; `getOwnInvoiceState` is the receive half's
   * self-payment probe, and optional there: a backend without it resolves a
   * self-payment the ordinary way (`stuck`, for a human).
   */
  ln: Pick<
    SendBackend,
    | 'payInvoice'
    | 'getPayment'
    | 'routeCltvBudgetBlocks'
    | 'enforcesRouteCltv'
    | 'getSendHtlcState'
    | 'walletFingerprint'
  > &
    Pick<ReceiveBackend, 'getOwnInvoiceState'>
  arkade: ArkadeOps
  /**
   * Which backend implementation is wired in — `lnd`, for instance.
   *
   * Recorded on a row with its payment id, because the id is only meaningful to
   * the backend that minted it. Optional so a test fake need not name itself.
   */
  backendName?: string
  limits: Limits
  /** bech32 prefix a BOLT11 must carry on this network. */
  invoicePrefix: string
  /**
   * Cap on the SUM of amounts across all currently-exposed swaps. Per-swap limits
   * bound what one bug costs; this bounds what all concurrent ones cost together.
   */
  maxExposedSats: number
  /** Sum of committed sats across every corridor, not just this notebook. */
  totalCommitted: () => Promise<number>
  /**
   * Reserves cap headroom for a quote whose row has not landed yet (#105).
   * SHARE one instance across every corridor: a per-corridor control bounds
   * only its own concurrency, which is the narrower half of the problem.
   */
  admission: AdmissionStrategy
  /**
   * Admission control on NEW quotes, shared by every transport. Injected in
   * tests; defaults to the standard quota. Only requests carrying a requester
   * identity (socket IP, relay author) are metered — the operator's own CLI
   * passes no key and stays unmetered.
   */
  quoteLimiter?: RateLimiter
  /** Overrides {@link SWEEP_CONCURRENCY} when the indexer/LN backend can't sustain the default fan-out. */
  sweepConcurrency?: number
  /**
   * Route-hint channels this deployment declines to price, as lowercase hex
   * scids (`LN_SEND_HINT_SCID_DENYLIST`). Absent means an empty set: every hint
   * priced, which is what this corridor did before the knob existed.
   *
   * Held here rather than read from config inside, for the reason every other
   * knob on this interface is: the orchestrator takes deps, not an environment.
   */
  sendHintScidDenylist?: ReadonlySet<string>
  /**
   * Funding window a quote grants, seconds (`LOCKUP_TIMEOUT_SECONDS`; defaults
   * to {@link DEFAULT_LOCKUP_TIMEOUT}). Quote deadline, sweep abandonment and
   * the RFQ re-serve (spec § 4.5 "same content") must all use this one value.
   */
  lockupTimeout?: number
  /** What this corridor charges. Omitted means free, which is what it charged before fees existed. */
  fee?: Fee
  /**
   * The OTHER corridors' stores, consulted for the duplicate-hash check.
   * Each corridor's own duplicate check sees only its own table, which is
   * exactly the blind spot that lets a send quote accept the hash of a live
   * RECEIVE swap of ours — paying our own hold invoice: a self-payment. A
   * hash live in any corridor's store is spoken for, everywhere.
   */
  peerStores?: readonly { findLiveByPaymentHash(paymentHash: string): Promise<unknown> }[]
  /**
   * Everything the coupled self-payment path needs, wired as ONE unit or not
   * at all. Absent means the corridor behaves exactly as it did before the flow
   * existed: every cross-corridor hash collision is refused.
   *
   * A client quoting lightning:BTC->arkade:BTC and then arkade:BTC->lightning:BTC
   * against that same bolt11 is refreshing Arkade funds through us. That second
   * quote is a self-payment by construction and unservable over Lightning, but
   * it is a legitimate request: we recognise it and couple the two rows. See
   * docs/superpowers/specs/2026-08-12-self-payment-refresh-design.md.
   *
   * Bundled deliberately. Recognising a coupling we cannot later COLLECT is the
   * one way this feature loses money — we would pay out on the receive leg and
   * never claim the send lockup — so a half-wired deployment must not be
   * expressible. One optional object makes "recognise" and "collect" arrive
   * together or not at all.
   */
  coupling?: {
    /**
     * The Lightning receive store: the one corridor whose live row on our hash
     * can be a coupling rather than a conflict.
     *
     * Kept out of `peerStores` and passed here instead. That list answers
     * `unknown` on purpose — it cannot say which corridor replied, nor be read
     * — and the opacity is what stops a future edit teaching it to accept.
     * Leaving this store in both places would let the loop re-refuse every
     * coupling this recognises.
     */
    receiveStore: { findLiveByPaymentHash(paymentHash: string): Promise<CoupledReceiveRow | null> }
    /**
     * Every outpoint a script holds, spent or not. Distinct from
     * `ArkadeOps.findLockups`, whose `spendableOnly` read goes empty at exactly
     * the moment a claim lands — which is exactly when this is needed.
     */
    findLockupOutpoints(pkScriptHex: string): Promise<{ txid: string; vout: number }[]>
    /**
     * The preimage revealed by whatever spent those outpoints, or null if
     * nothing provable has landed.
     *
     * This path's ONLY source of `P`: no Lightning payment happens on a coupled
     * swap, so the backend never produces one. Implementations must verify each
     * candidate against `paymentHashHex` and answer null otherwise — a matching
     * witness shape is not proof, only a matching hash is.
     */
    findClaimPreimage(
      outpoints: readonly { txid: string; vout: number }[],
      paymentHashHex: string,
    ): Promise<Uint8Array | null>
  }
  /**
   * Where the chain tip is. Required only when this deployment's timelocks count blocks
   * — see `core/timelocks.ts`. Absent is correct for a seconds-typed deployment, which
   * never asks.
   */
  chainTip?: ChainTipProvider
  now?: () => number
}

/**
 * How many swaps one sweep drives at once.
 *
 * A serial sweep costs N × RPC, so at a few dozen live swaps it outlasts its own
 * interval and funding detection quietly degrades under exactly the load that
 * matters. Bounded rather than unbounded because the ceiling that matters is the
 * indexer's and the Lightning backend's, not ours.
 */
const SWEEP_CONCURRENCY = 8

/**
 * States whose next step is a Lightning poll, and nothing else.
 *
 * Kept narrow on purpose: these are the states where the provider has already
 * paid (or is paying) and only needs `P` to claim. Widening this to states that
 * wait on client action — `quoted` above all — would turn a cheap hot loop into
 * a second full sweep.
 *
 * Typed against {@link SendSwapState} rather than `string`, because this list is
 * a hand-maintained fact (it tracks `step`'s dispatch, which no table encodes)
 * and its failure mode is silent: a state renamed or mistyped here matches
 * nothing, and the only symptom is latency inside the exposure window — the
 * exact thing the hot loop exists to remove.
 */
const HOT_STATES: readonly SendSwapState[] = ['paying', 'paid']

/**
 * How long the "blocked hash, nothing committed" contradiction must persist
 * before the row is parked rather than retried.
 *
 * The contradiction is that the backend holds NOTHING for this payment hash
 * (`getSendHtlcState` answers null) while REFUSING to pay it because it already
 * holds something ({@link PaymentHashRegistered}). Both cannot be true of a
 * healthy backend; together they mean a registration with no commitment behind
 * it, which no retry can ever clear.
 *
 * An hour, because the cost of the two mistakes is wildly asymmetric. Parking
 * too eagerly costs an operator a look at a row that might have recovered on
 * its own; parking too late costs what it already cost once — a swap that
 * retried for SIX DAYS. An hour excludes any transient (a backend catching up,
 * a cross-process race) by orders of magnitude while still ending the storm the
 * same working day. Measured from `pay_attempted_at`, which is on DISK, so a
 * restart does not restart the clock — the incident survived several.
 */
export const ORPHANED_REGISTRATION_SECONDS = 3600

/** A BOLT11 payment hash is sha256(P); the backend hands us P and we must check it fits. */
const preimageMatchesHash = (preimageHex: string, paymentHashHex: string): boolean => {
  try {
    return hex.encode(sha256(hex.decode(preimageHex))) === paymentHashHex
  } catch {
    return false
  }
}

/** The pure acceptance gate's refusals, plus the ones only the orchestrator can decide. */
export type QuoteRefusal =
  | SendAcceptanceRefusal
  | 'duplicate_swap'
  | 'provider_at_capacity'
  | 'invalid_refund_address'
  | 'rate_limited'
  // A coupled self-payment whose two refund deadlines are too close together
  // to be claimed safely. See `evaluateCouplingDeadlines`.
  | 'coupled_deadline_unsafe'
  // Same hash as a live receive row of ours, but not the bolt11 that row
  // minted. See the coupling gate in `quote`.
  | 'coupled_invoice_mismatch'

export type QuoteOutcome =
  | { accepted: true; swap: SendSwapRow; lockupDeadline: number }
  /** `detail` is log-only and optional — see {@link SendAcceptanceDecision}. */
  | { accepted: false; reason: QuoteRefusal; detail?: string }

/**
 * What the self-payment probe licenses the terminal-failure path to do.
 *
 * Three outcomes rather than a boolean because the probe now sits in front of
 * a rule that ALREADY refunds. "Did the self-payment path handle this?" and
 * "may the ordinary refund proceed?" stopped being the same question the
 * moment a terminal failure became grounds for a refund on its own.
 */
type SelfPaymentVerdict =
  /** Handled here: the row is `refused` and its refund pushed, recorded or deferred to the sweep. */
  | 'resolved'
  /** Withhold the ordinary refund too — see the armed/settled branch for why. */
  | 'withhold'
  /**
   * The probe ANSWERED and the invoice is not ours. The ordinary rule applies,
   * and there is no self-payment risk left to worry about.
   */
  | 'not-ours'
  /**
   * The probe could not be asked, so nothing was learned. The ordinary refund
   * still applies — an unreachable probe is no evidence to withhold on — but
   * the invoice MIGHT be ours with an htlc our node could still collect, and
   * that is the one residual way a refund here pays twice. A row in this state
   * keeps `stuck` for a human even after the refund lands.
   */
  | 'unknown'

export class SendSwapService {
  private readonly now: () => number
  private readonly quoteLimiter: RateLimiter
  /** Swaps a tick is currently driving, so overlapping loops skip rather than race. */
  private readonly inFlight = new Set<string>()
  private get backendName(): string | undefined {
    return this.deps.backendName
  }

  private readonly sweepConcurrency: number

  private readonly fee: Fee

  /** Public: the RFQ re-serve recomputes quote deadlines from this — see {@link SendServiceDeps.lockupTimeout}. */
  readonly lockupTimeout: number

  /**
   * Public for the same reason {@link lockupTimeout} is: `ingress/rfq.ts`
   * decodes the client's invoice itself, for the natural key and the amount
   * cross-check, and that decode must see the hints THIS decode sees. Reading
   * the raw hint set there would refuse — at the ingress, before `quote` is
   * ever called — the very invoice the denylist exists to make payable.
   */
  readonly sendHintScidDenylist: ReadonlySet<string>

  private readonly admission: AdmissionStrategy

  constructor(private readonly deps: SendServiceDeps) {
    this.admission = deps.admission
    this.now = deps.now ?? nowSeconds
    this.quoteLimiter = deps.quoteLimiter ?? new RateLimiter(QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS, this.now)
    this.sweepConcurrency = deps.sweepConcurrency ?? SWEEP_CONCURRENCY
    this.fee = deps.fee ?? FREE
    this.lockupTimeout = deps.lockupTimeout ?? DEFAULT_LOCKUP_TIMEOUT
    this.sendHintScidDenylist = deps.sendHintScidDenylist ?? new Set()
  }

  /**
   * A unix-seconds deadline as the locktime this deployment writes.
   *
   * The unit is taken from the unilateral LADDER rather than from a setting of its own:
   * the ladder was derived from the server's advertised delay, so its unit already IS
   * this deployment's, and reading it here keeps the covenant's relative and absolute
   * timelocks from ever disagreeing about which clock the swap runs on.
   */
  private async absoluteLocktimeFor(deadlineSeconds: number, ladderDelay: number): Promise<number> {
    if (relativeDelayFrom(ladderDelay).unit === 'seconds') return deadlineSeconds
    const chainTip = this.deps.chainTip
    if (!chainTip) {
      throw new Error(
        'this deployment has block-typed timelocks, so a refund deadline must be written as a height — ' +
          'but no chainTip provider is wired',
      )
    }
    return absoluteLocktimeIn(deadlineSeconds, 'blocks', { now: this.now(), tipHeight: await chainTip.height() })
  }

  /**
   * A stored refund locktime as a unix-seconds deadline.
   *
   * For DURATION questions only — "how much claim window is left", "does the HTLC fit
   * inside it" — which the whole deadline model asks in seconds. A height is projected
   * from the current tip at the nominal block interval, so the answer is an estimate
   * that moves as blocks arrive.
   *
   * NEVER to ask whether the deadline has OPENED: that is
   * {@link SendSwapService.refundDeadlineReached}, which compares in the locktime's own
   * unit and cannot drift from what the chain will enforce.
   */
  private async refundDeadlineSeconds(refundLocktime: number): Promise<number> {
    const now = this.now()
    if (absoluteLocktimeUnit(refundLocktime) === 'seconds') return refundLocktime
    const chainTip = this.deps.chainTip
    if (!chainTip) {
      throw new Error(
        `refund locktime ${refundLocktime} is a block height, but no chainTip provider is wired — ` +
          'a block-typed deployment needs one to size the remaining claim window',
      )
    }
    return absoluteLocktimeSeconds(refundLocktime, { now, tipHeight: await chainTip.height() })
  }

  /**
   * Has this swap's refund deadline opened?
   *
   * Asked in the locktime's OWN unit — a height against the chain tip, seconds against
   * the clock. The tip is read only when there is a height to compare, so a
   * seconds-typed deployment never issues the request and needs no `chainTip` at all.
   */
  private async refundDeadlineReached(refundLocktime: number): Promise<boolean> {
    const now = this.now()
    if (absoluteLocktimeUnit(refundLocktime) === 'seconds') return now >= refundLocktime
    const chainTip = this.deps.chainTip
    if (!chainTip) {
      // A block-typed row with nowhere to read a height is a wiring error, and guessing
      // either answer moves money the wrong way: "not reached" strands a refund forever,
      // "reached" pushes one the chain will reject.
      throw new Error(
        `refund locktime ${refundLocktime} is a block height, but no chainTip provider is wired — ` +
          'a block-typed deployment needs one to tell whether a deadline has opened',
      )
    }
    return absoluteLocktimeReached(refundLocktime, { now, tipHeight: await chainTip.height() })
  }

  /**
   * Quote a send swap and persist it BEFORE returning the lockup address.
   *
   * The order matters: once the address leaves this process a client may fund
   * it, and a funded script whose parameters exist only in memory is
   * unclaimable and unrefundable after a crash.
   *
   * `refundAddress` is the client's whole refund story: the script commits to
   * it, and after the deadline anyone can push a refund that provably pays only
   * there. The client keeps no key and no state.
   *
   * Throws {@link InvalidInvoice} for input that does not decode; returns a
   * closed refusal for valid input the provider declines.
   *
   * `options.rfqId` stamps the row with the RFQ correlation id when the request
   * arrived as `rfq_request`; the money path itself is family-agnostic.
   * `options.requesterKey` is the transport's requester identity (socket IP,
   * relay author) for admission control; operator-local callers pass none.
   *
   * `options.clientRefundPubkey` is REQUIRED. The RFQ schema demands it, and
   * the CLI's own `quote`/`send` self-tests generate an ephemeral one — so
   * every lockup this service mints carries the client-unilateral leaf. It used
   * to be optional, and omitting it built a base three-leaf script no handler
   * could re-derive: never a contract, invisible to the wallet's own reads and
   * to the contract stream. See `src/arkade/covenant.ts`'s top-of-file comment.
   */
  async quote(
    rawInvoice: string,
    refundAddress: string,
    options: { rfqId?: string; requesterKey?: string; clientRefundPubkey: string },
  ): Promise<QuoteOutcome> {
    const { store, arkade, limits, invoicePrefix } = this.deps

    // Admission first: a quote is free to request but holds provider capacity
    // for a whole window, so the meter runs before any work happens. Retries
    // and relay redeliveries consume budget like any other request — the quota
    // is sized so that is plenty for a client driving one negotiation.
    if (options?.requesterKey !== undefined && !this.quoteLimiter.take(options.requesterKey)) {
      return { accepted: false, reason: 'rate_limited' }
    }

    // The denylist reaches EVERY decode of this string, not just this one — see
    // `whenFunded` and `submitPayment` below. The totals here are what the
    // refund deadline is priced from; a pay-time re-decode reading the raw
    // hints would refuse, on a rail that caps nothing, the row this quote
    // accepted.
    const decoded = decodeInvoice(rawInvoice, this.sendHintScidDenylist)
    if (decoded.droppedHints) {
      this.onDroppedRouteHints?.({
        paymentHash: decoded.paymentHash,
        dropped: decoded.droppedHints,
        worstRouteHintCltvBlocks: decoded.worstRouteHintCltvBlocks,
      })
    }

    let refundPkScript: Uint8Array
    try {
      const address = ArkAddress.decode(refundAddress)
      refundPkScript = address.pkScript
      if (!refundAddress.toLowerCase().startsWith(`${arkade.hrp}1`)) {
        return { accepted: false, reason: 'invalid_refund_address' }
      }
      // An Arkade address embeds the server its vtxo lives on. A covenant
      // refund pushed to an address of a DIFFERENT deployment lands somewhere
      // the client can only spend with that other server's cooperation — the
      // "anyone can push it back" story silently stops holding. Only refunds to
      // THIS server are recoverable, so anything else is refused at quote time.
      if (hex.encode(address.serverPubKey) !== arkade.serverPubkey) {
        return { accepted: false, reason: 'invalid_refund_address' }
      }
    } catch {
      return { accepted: false, reason: 'invalid_refund_address' }
    }

    const acceptance = evaluateSendAcceptance({
      invoiceExpiresAt: decoded.expiresAt,
      invoiceAmountSats: decoded.amountSats,
      invoiceNetwork: decoded.network,
      providerNetwork: invoicePrefix,
      limits,
      minFinalCltvBlocks: decoded.minFinalCltvBlocks,
      // CLTV the INVOICE dictates, and what THIS backend's routes may add on
      // top — the second pair is the backend's own answer because only it knows
      // whether `maxCltvBlocks` is a ceiling it enforces or merely a hope (see
      // `SendBackend.routeCltvBudgetBlocks`). Both hint totals go over
      // un-selected: `evaluateSendAcceptance` needs the raw worst.
      worstRouteHintCltvBlocks: decoded.worstRouteHintCltvBlocks,
      bestRouteHintCltvBlocks: decoded.bestRouteHintCltvBlocks,
      routeCltvBudgetBlocks: this.deps.ln.routeCltvBudgetBlocks,
      enforcesRouteCltv: this.deps.ln.enforcesRouteCltv,
      unilateralClaimDelay: arkade.delays.unilateralClaimDelay,
      lockupTimeout: this.lockupTimeout,
      now: this.now(),
    })
    if (!acceptance.accept)
      return { accepted: false, reason: acceptance.reason, ...(acceptance.detail ? { detail: acceptance.detail } : {}) }

    if (await store.findLiveByPaymentHash(decoded.paymentHash)) {
      // Two live swaps sharing a payment hash mean two lockups and one payment;
      // whichever client loses the race has its lockup claimed and no refund.
      // A `refused` prior swap does NOT block: it never moved money and never
      // learned a preimage, so its still-valid invoice may be quoted again.
      return { accepted: false, reason: 'duplicate_swap' }
    }
    // The Lightning receive corridor, asked FIRST and by name, because its
    // answer is the one that can be something other than a refusal: a live row
    // there means this client is refreshing Arkade funds through us.
    const coupled = (await this.deps.coupling?.receiveStore.findLiveByPaymentHash(decoded.paymentHash)) ?? null
    if (coupled) {
      // Only from `quoted`. A receive row that reached `armed` took a REAL htlc
      // from somewhere — a genuine conflict, and the case the cross-corridor
      // guard was built for. Coupling never overrides an armed row.
      if (coupled.state !== 'quoted') return { accepted: false, reason: 'duplicate_swap' }
      // Couple only the bolt11 we minted. Same hash, different invoice is not
      // a self-payment. toLowerCase: decodeInvoice already lowercased its side.
      if (decoded.invoice !== coupled.invoice.toLowerCase()) {
        return { accepted: false, reason: 'coupled_invoice_mismatch' }
      }
      const deadlines = evaluateCouplingDeadlines({
        sendRefundLocktime: acceptance.refundLocktime,
        receiveRefundLocktime: coupled.refundLocktime,
      })
      // Refused with its OWN reason, not `duplicate_swap`: the request is
      // legitimate and the deadline is what cannot be served, which is the
      // difference between "quote something else" and "try again later".
      if (!deadlines.couple) return { accepted: false, reason: deadlines.reason }
    }
    // The same check against the other corridors' stores: a hash that is live
    // in ANY of them is spoken for. This loop cannot recognise a coupling — it
    // answers `unknown` by design and cannot say which corridor replied — so
    // the receive store is handled above and deliberately kept OUT of it.
    for (const peer of this.deps.peerStores ?? []) {
      if (await peer.findLiveByPaymentHash(decoded.paymentHash)) {
        return { accepted: false, reason: 'duplicate_swap' }
      }
    }
    // What the client must lock: the invoice plus this corridor's cut. The
    // limits above bound the INVOICE — the size of the payment the client asked
    // us to make, which is the number they think in — while everything from here
    // down deals in the lockup, because that is the amount that actually has to
    // arrive. With a zero fee the two are equal and this is a no-op.
    const lockupSats = giveSatsFor(decoded.amountSats, this.fee)
    // RESERVED, not merely observed: the row below is what makes this swap
    // visible to `totalCommitted()`, and until it lands a concurrent quote
    // reads the same headroom and takes it too (#105). Handed back in the
    // `finally`, by which point either the row counts instead or nothing
    // was committed at all.
    const reservation = await this.admission.admit({
      pair: RFQ_PAIR_SEND,
      giveSats: lockupSats,
      capSats: this.deps.maxExposedSats,
      committedSats: this.deps.totalCommitted,
    })
    if (reservation === null) {
      return { accepted: false, reason: 'provider_at_capacity' }
    }
    try {
      const serverKey = hex.decode(arkade.serverPubkey)
      // `acceptance.refundLocktime` is reasoned about in seconds, like every deadline in
      // this service. It is converted to the unit the script is actually written in
      // exactly HERE, once, and the SAME value goes into both the covenant and the row —
      // they derive each other, so a second conversion anywhere would produce a script
      // the row cannot spend.
      const refundLocktime = await this.absoluteLocktimeFor(
        acceptance.refundLocktime,
        arkade.delays.unilateralClaimDelay,
      )
      const script = new CovenantSwapScript({
        receiver: hex.decode(arkade.providerPubkey),
        server: serverKey,
        preimageHash: scriptHashFromPaymentHash(decoded.paymentHash),
        refundLocktime,
        claimDelay: arkade.delays.unilateralClaimDelay,
        client: hex.decode(options.clientRefundPubkey),
        clientRefundDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
        refundWithoutServerDelay: arkade.delays.unilateralRefundDelay,
        // Every quote from here on carries the current, full covenant suite —
        // no legacy selector. See `NonInteractiveParameters.legacy`'s own doc comment
        // for why that is not simply always omitted.
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(arkade.emulatorPubkey),
          receiverPkScript: hex.decode(arkade.receiverPkScript),
          senderPkScript: refundPkScript,
        },
      })

      try {
        // Awaited inside the try, so the driver's rejection lands in the catch.
        const swap = await store.insertQuote({
          id: randomUUID(),
          invoice: decoded.invoice,
          paymentHash: decoded.paymentHash,
          // The LOCKUP amount, not the invoice amount. Everything downstream that
          // reads `amountSats` is asking "how much must arrive at the script" —
          // the funding gate, the exposure sum, the overfund refusal — and the
          // one place that asks "how much are we paying out" re-decodes the row's
          // own invoice, which is authoritative for that.
          amountSats: lockupSats,
          invoiceExpiresAt: decoded.expiresAt,
          refundLocktime,
          // No sender key exists in the covenant script; the provider key fills
          // the legacy column so old rows and new rows read the same way.
          senderPubkey: arkade.providerPubkey,
          receiverPubkey: arkade.providerPubkey,
          serverPubkey: arkade.serverPubkey,
          claimDelay: arkade.delays.unilateralClaimDelay,
          refundDelay: arkade.delays.unilateralRefundDelay,
          refundWithoutReceiverDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
          pkScript: hex.encode(script.pkScript),
          lockupAddress: script.address(arkade.hrp, serverKey).encode(),
          refundPkScript: hex.encode(refundPkScript),
          emulatorPubkey: arkade.emulatorPubkey,
          clientRefundPubkey: options?.clientRefundPubkey,
          receiverPkScript: options?.clientRefundPubkey !== undefined ? arkade.receiverPkScript : undefined,
          nonInteractiveParameters: true,
          rfqId: options?.rfqId,
        })
        return { accepted: true, swap, lockupDeadline: acceptance.lockupDeadline }
      } catch (error) {
        // The UNIQUE constraint is the racproof backstop behind the pre-check.
        if (error instanceof Error && /UNIQUE/i.test(error.message)) {
          return { accepted: false, reason: 'duplicate_swap' }
        }
        throw error
      }
    } finally {
      reservation.release()
    }
  }

  /**
   * Advance one swap as far as it can go right now, and return its row.
   *
   * Non-blocking by design: a state waiting on the outside world (lockup not
   * seen, preimage not yet known) returns rather than sleeps, and the caller's
   * loop provides the polling. A state whose next step is ready falls straight
   * through, so a fully-ready swap goes quoted → claimed in a single call.
   */
  async tick(id: string): Promise<SendSwapRow> {
    const { store } = this.deps
    if (this.inFlight.has(id)) return store.get(id)
    this.inFlight.add(id)
    try {
      while (await this.step(await store.get(id))) {
        // each successful step re-reads the row and tries the next
      }
      return await store.get(id)
    } finally {
      this.inFlight.delete(id)
    }
  }

  /** Drive every non-terminal swap once. The recovery sweep and the interval loop. */
  async tickAll(): Promise<SendSwapRow[]> {
    return this.driveRows(await this.deps.store.findRecoverable())
  }

  /**
   * Drive only the swaps whose next step is a Lightning poll.
   *
   * `paying` and `paid` are the states where the provider has money in flight
   * and is waiting on a preimage that a healthy backend usually resolves in well
   * under a second. Left to the recovery sweep alone, every such wait is rounded
   * up to that sweep's interval — pure latency in the one window where the
   * provider is already exposed. The caller runs this on a much shorter cadence;
   * the set stays small because a swap leaves it the moment `P` lands.
   */
  async tickHot(): Promise<SendSwapRow[]> {
    return this.driveRows(await this.deps.store.findByStates(HOT_STATES))
  }

  /**
   * Tick each row once, bounded-concurrently, isolating per-row failures.
   *
   * Concurrency is safe by this class's own contract — `tick`'s in-flight guard
   * stops duplicate RPC work per swap and the store's compare-and-swap settles
   * any race — so the bound exists only to cap fan-out against the backends.
   * Returned rows are in completion order, never creation order.
   */
  private async driveRows(rows: readonly SendSwapRow[]): Promise<SendSwapRow[]> {
    const driven: SendSwapRow[] = []
    // One shared iterator: every worker pulls from it, so each row is claimed
    // exactly once without any index bookkeeping to get wrong.
    const cursor = rows[Symbol.iterator]()
    const worker = async (): Promise<void> => {
      for (const row of cursor) {
        // Held off after repeated failures, or already being ticked by someone
        // else. Both are reasons this SWEEP should not ask again, and neither
        // is a reason the swap advanced — so the row comes back in its current
        // state without `onTickSuccess` firing for it.
        //
        // Gated here rather than inside `tick` so a DIRECT caller is never
        // throttled: the admin recheck action, the lockup-watcher callback and
        // a one-shot CLI tick are a human or an event asking once, not a timer
        // re-asking. Only the timer needs slowing down.
        if (this.shouldSkipTick?.(row.id) || this.inFlight.has(row.id)) {
          driven.push(row)
          continue
        }
        try {
          driven.push(await this.tick(row.id))
          // Ticked without throwing AND without being held off — the only
          // combination that means the fault is over. The host clears the
          // backoff on this signal rather than on membership of `driven`,
          // which also holds rows that were skipped and rows that threw.
          this.onTickSuccess?.(row.id)
        } catch (error) {
          // One swap's network failure must not stop the sweep: the row keeps its
          // state and the next sweep retries. Money-safety never depends on this
          // loop completing — only on the per-row transitions.
          this.onTickError?.(row.id, error)
          try {
            driven.push(await this.deps.store.get(row.id))
          } catch {
            // The tick failure was likely a store fault; re-reading here would
            // rethrow and abort the whole sweep — the exact thing this catch
            // exists to prevent. Skip the row; the next sweep retries it.
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.sweepConcurrency, rows.length) }, worker))
    return driven
  }

  /** Hook for the host (CLI, server) to log per-swap tick failures. */
  onTickError?: (id: string, error: unknown) => void

  /**
   * Hook for the host to log route hints {@link SendServiceDeps.sendHintScidDenylist}
   * dropped from a quote.
   *
   * A denylist that changes what we price without saying so cannot be audited
   * after the fact: the entry is in an env var, the effect is a number inside a
   * refund deadline, and nothing in between records that the two met.
   *
   * Fired from `quote` only. The funding and payment re-decodes drop the same
   * hints off the same string by construction, so logging them there too would
   * be three lines about one fact.
   */
  onDroppedRouteHints?: (event: {
    paymentHash: string
    dropped: readonly DroppedHint[]
    /** What is priced instead, over the surviving hints. */
    worstRouteHintCltvBlocks: number
  }) => void

  /**
   * Its twin: this swap ticked cleanly, so whatever it was failing at is over.
   *
   * Fired only from the sweep, and only for a row that actually ran — never
   * for one held off by {@link shouldSkipTick}, and never for one whose tick
   * threw. That distinction is the whole point of the hook: all three outcomes
   * are indistinguishable in the array the sweep returns.
   */
  onTickSuccess?: (id: string) => void

  /**
   * Set by the host: is this swap being held off after repeated failures?
   *
   * Safe to skip by this class own contract — a tick is re-entrant and re-reads
   * the row — so a skipped tick costs latency on a swap that was failing anyway,
   * and spares the backend a question whose answer has not changed.
   *
   * Consulted by the SWEEP ONLY. {@link tick} itself is never gated, so an
   * operator who has just fixed the backend and pressed recheck gets a real
   * tick rather than a stale row and a minute's wait.
   * @see packages/solver-app/src/ops/tickErrors.ts
   */
  shouldSkipTick?: (id: string) => boolean

  /**
   * Push covenant refunds for every failed swap whose deadline has passed.
   *
   * This is a courtesy the covenant makes safe: the refund can only pay the
   * client's committed address, so pushing it costs the provider nothing and
   * spares the client from ever having to act. A push that fails (most often
   * FORFEIT_CLOSURE_LOCKED — a seconds locktime matures against the chain tip's
   * timestamp, not wall clock) is simply retried on the next sweep.
   */
  async refundSweep(): Promise<string[]> {
    const { store, arkade } = this.deps
    const pushed: string[] = []
    for (const row of await store.findRefundable(this.now())) {
      if ((row.lockupValue ?? 0) <= 0) continue
      try {
        const outputs = await arkade.findLockups(row.pkScript)
        if (outputs.length === 0) {
          // Nothing SPENDABLE at the script, which is two different facts: the
          // client (or another watcher) already moved it, or the `spendableOnly`
          // view this reads is a moment behind. Recording the first on the
          // strength of one empty read is a ONE-WAY DOOR — `findRefundable`
          // filters `refund_outcome IS NULL`, so the row is never selected
          // again, and `rfqStateFromRow` then reports the swap `refunded` to a
          // client whose every sat is still sitting at the covenant script.
          // That status is exactly what would talk a client out of pushing the
          // refund itself, which is the only recourse left once we stop.
          //
          // So require the spend ITSELF, not the absence of a spendable output.
          // Without it the row is left exactly as it was and the next sweep
          // looks again — costing only a delayed refund, against a permanent
          // one. This is the same lag PR #21 fixed on the receive leg, but not
          // the same remedy: there a grace period worked because the row had
          // just entered `refunding`, whereas a row here becomes refundable
          // when its deadline matures, long after `updatedAt` last moved.
          if (!(await arkade.lockupProvablySpent(row.pkScript))) continue
          // The outcome discriminator records that somebody else moved it; the
          // txid column only ever holds txids.
          await store.patch(row.id, { refund_outcome: 'external' })
          continue
        }
        const txid = await arkade.refund(row, outputs)
        await store.patch(row.id, { refund_outcome: 'pushed', refund_ark_txid: txid })
        pushed.push(row.id)
      } catch (error) {
        this.onTickError?.(row.id, error)
      }
    }
    return pushed
  }

  /** @returns true when the swap moved to a new state and the next step should run. */
  private async step(row: SendSwapRow): Promise<boolean> {
    switch (row.state) {
      case 'quoted':
        return this.whenQuoted(row)
      case 'funded':
        return this.whenFunded(row)
      case 'paying':
        return this.whenPaying(row)
      case 'paid':
        return this.whenPaid(row)
      case 'claiming':
        return this.whenClaiming(row)
      default:
        return false
    }
  }

  private async whenQuoted(row: SendSwapRow): Promise<boolean> {
    const { store, arkade } = this.deps
    const outputs = await arkade.findLockups(row.pkScript)
    const locked = outputs.reduce((sum, o) => sum + o.value, 0)

    const timedOut = this.now() >= lockupDeadlineFor(row.createdAt, row.invoiceExpiresAt, this.lockupTimeout)
    const expired = this.now() >= row.invoiceExpiresAt

    // Overfunding is refused, never paid. The claim leaf sweeps WHOLE vtxos to
    // the provider (an Arkade spend cannot take part of a vtxo), so paying an
    // overfunded lockup would hand us the excess with no path for the client to
    // recover it. Refusing instead routes the entire lockup to the refund path,
    // so the client gets all of it back. Arkade vtxos are exact-value, so a correct
    // single funding is exactly `amountSats`.
    if (locked > row.amountSats) {
      await store.patch(row.id, { lockup_value: locked })
      await store.fail(row.id, 'quoted', `overfunded lockup: ${locked} > ${row.amountSats} sats`)
      return false
    }

    if (locked === row.amountSats && !timedOut && !expired) {
      const [first] = outputs
      // Every funding output gets its own history entry, including this first
      // one. The transition marks the STATE change and cannot name an outpoint;
      // an operator chasing a deposit wants the transaction, and a later
      // deposit at the same script is recorded the same way (see
      // `noteFundings`). Before the transition, so a crash between them leaves
      // a recorded funding rather than an unrecorded one.
      await store.noteFundings(row.id, outputs)
      return store.transition(row.id, 'quoted', 'funded', {
        lockup_txid: first?.txid ?? null,
        lockup_vout: first?.vout ?? null,
        lockup_value: locked,
      })
    }

    // Either nothing (or only part) has arrived, or a full lockup arrived too
    // late to pay. Late funding is refused, not paid: `refundLocktime` is
    // anchored at quote time, so a lockup that lands well after the deadline
    // shrinks the claim window we quoted against — and past the safety margin it
    // would open the client's refund before our recourse. The deadline is thus a
    // hard precondition enforced whenever we first OBSERVE funding, so the
    // drive-later and crash-recovery paths cannot smuggle in a stale lockup that
    // an always-on watcher would have timed out.
    if (timedOut || expired) {
      // Record whatever is there so the refund sweep can return it.
      if (locked > 0) await store.patch(row.id, { lockup_value: locked })
      const reason = expired
        ? 'invoice expired before funding completed'
        : locked >= row.amountSats
          ? 'lockup arrived after the funding deadline'
          : locked > 0
            ? `lockup timeout with partial ${locked} sats`
            : 'lockup timeout'
      await store.fail(row.id, 'quoted', reason)
    }
    return false
  }

  private async whenFunded(row: SendSwapRow): Promise<boolean> {
    const { store } = this.deps
    // The claim leaf of the funded script needs the provider key that was live
    // at QUOTE time. If the configured key has rotated since, paying would buy
    // a lockup this key can never claim — refuse instead and let the lockup
    // take the covenant refund back to the client.
    if (row.receiverPubkey !== this.deps.arkade.providerPubkey) {
      await store.fail(row.id, 'funded', 'provider key rotated since quote; refusing to pay an unclaimable lockup')
      return false
    }
    // A COUPLED row can never be paid: the invoice is one we minted, and a node
    // cannot pay its own invoice. Its preimage arrives on-chain instead, when
    // the client claims the payout we already made on the receive leg — so this
    // corridor's job here is to collect, not to pay.
    //
    // Answered before `evaluateSendPayment` because every gate in there decides
    // whether to PAY, and the answer on this path is "never". The state
    // machine agrees: `funded -> claiming` skips `paying`/`paid` entirely.
    const coupling = this.deps.coupling
    const coupled = await coupling?.receiveStore.findLiveByPaymentHash(row.paymentHash)
    if (coupling && coupled) {
      if (coupled.htlcExpiresAt !== null) {
        await store.fail(row.id, 'funded', 'refused to collect: receive took a real htlc')
        return false
      }
      const outpoints = await coupling.findLockupOutpoints(coupled.pkScript)
      const preimage = outpoints.length > 0 ? await coupling.findClaimPreimage(outpoints, row.paymentHash) : null
      // Nothing provable yet. Routine on every tick before the client acts, so
      // the row simply waits in `funded` rather than failing.
      if (!preimage) return false
      return this.claimWithPreimage(row.id, row.paymentHash, hex.encode(preimage), 'funded')
    }

    // Re-evaluated HERE, immediately before the money moves — not at quote time,
    // not when the lockup was first seen. They can be minutes apart.
    //
    // Decoded ONCE and reused below. The point of re-deriving these from
    // `row.invoice` is that there is no second copy to go stale against
    // `refundLocktime`; that holds just as well parsing the verbatim string
    // once per pass as parsing it per field, and `decodeInvoice` is pure.
    const invoice = decodeInvoice(row.invoice, this.sendHintScidDenylist)
    // Resolved to seconds first: `evaluateSendPayment` measures the remaining claim
    // window against MIN_CLAIM_WINDOW, and a raw height there reads as a deadline in 1970.
    const refundDeadline = await this.refundDeadlineSeconds(row.refundLocktime)
    const decision = evaluateSendPayment({
      invoiceExpiresAt: row.invoiceExpiresAt,
      refundLocktime: refundDeadline,
      lockedSats: row.lockupValue ?? 0,
      expectedSats: row.amountSats,
      // Re-decoded from the row's own invoice, for the reason `submitPayment`
      // gives: it is the verbatim string the deadline was priced from, so this
      // cannot go stale against `refundLocktime`.
      minFinalCltvBlocks: invoice.minFinalCltvBlocks,
      worstRouteHintCltvBlocks: invoice.worstRouteHintCltvBlocks,
      bestRouteHintCltvBlocks: invoice.bestRouteHintCltvBlocks,
      routeCltvBudgetBlocks: this.deps.ln.routeCltvBudgetBlocks,
      enforcesRouteCltv: this.deps.ln.enforcesRouteCltv,
      now: this.now(),
    })
    if (!decision.pay) {
      // Nothing has been paid, so this is a refusal, not an incident.
      await store.fail(row.id, 'funded', `refused to pay: ${decision.reason}`)
      return false
    }

    // Commit intent before the irreversible call. The idempotency key is
    // derived from the payment hash, so even a retry from a different process
    // after a crash cannot pay the same invoice twice.
    const won = await store.transition(row.id, 'funded', 'paying', {
      pay_attempted_at: this.now(),
      idempotency_key: `swap-${row.paymentHash}`,
    })
    if (!won) return false
    // Nothing committed, by construction: this process won the transition a
    // line ago and has not reached `payInvoice`, so no crash can have slipped a
    // payment in between.
    return this.submitPayment(await store.get(row.id), true)
  }

  /** Recovery path: the process died (or the call threw) somewhere around payInvoice. */
  private async whenPaying(row: SendSwapRow): Promise<boolean> {
    if (row.paymentId) return this.settleFromBackend(row, 'paying')
    // No payment id on disk: the payInvoice call may or may not have gone out.
    //
    // Re-submitting is NOT safe by construction, which is what this once
    // assumed. The idempotency key binds the backend's OWN request record, but
    // a backend that commits against the payment hash one call earlier has
    // already taken the sats, and that step replays as a hard error rather than
    // as the original answer. Re-submitting
    // then spins against a commitment nobody is reading — while the preimage
    // that would claim the client's lockup sits on the other side of exactly
    // the lookup below.
    //
    // So ask by hash first, and only submit when nothing is committed.
    // Called on `ln` rather than through a destructured reference: adapters are
    // classes and the method reads its own instance state.
    const { ln } = this.deps
    const committed = await ln.getSendHtlcState?.(row.paymentHash)
    if (committed) return this.recoverCommitted(row, committed)

    try {
      // The probe above answering falsy is only PROOF on a backend that has a
      // probe; without one its silence says nothing. Same qualifier the
      // `PaymentHashRegistered` branch below applies to the same fact.
      return await this.submitPayment(row, ln.getSendHtlcState !== undefined)
    } catch (error) {
      // The contradiction: the probe just said this backend holds nothing for
      // the hash, and the pay call refuses it because the backend holds
      // something. Only meaningful when the probe actually RAN — a backend that
      // cannot be asked has contradicted nothing.
      if (ln.getSendHtlcState === undefined || !(error instanceof PaymentHashRegistered)) throw error
      return this.whenHashBlocked(row, error)
    }
  }

  /**
   * A payment hash the backend blocks but holds nothing for.
   *
   * Parks the row; deliberately moves no money. The probe's null is NOT proof
   * that nothing was committed — on the incident this exists for, the backend's
   * own lookup answered null from every role while a registration demonstrably
   * existed, and what actually proved the sats had not left was the wallet's
   * transfer history. Refunding on this evidence would be the "empty read
   * recorded as a refund" mistake the refund sweep documents at length.
   *
   * So it stops the machine and hands an operator a row that says exactly what
   * was observed. `read-payment` and `scripts/lookup-htlc.mjs` are what settle
   * refund-versus-claim from there.
   */
  private async whenHashBlocked(row: SendSwapRow, error: PaymentHashRegistered): Promise<boolean> {
    const since = row.payAttemptedAt
    // No attempt timestamp means nothing to measure against; keep retrying
    // rather than park on a single observation.
    if (since === null || this.now() - since < ORPHANED_REGISTRATION_SECONDS) throw error

    await this.deps.store.fail(
      row.id,
      'paying',
      `orphaned registration: ${error.message}, yet it reports no commitment for this hash — ` +
        'unpayable and unclearable by retrying. Read the wallet transfers before refunding or claiming.',
    )
    return false
  }

  /**
   * Resolve a row whose sats are committed but whose payment id was never
   * learned, on the backend's own record of that commitment.
   *
   * Never re-submits: the commitment already exists, so the only useful moves
   * are to claim on it, to give the lockup back, or to wait.
   */
  private async recoverCommitted(row: SendSwapRow, htlc: SendHtlcState): Promise<boolean> {
    const { store } = this.deps

    if (htlc.status === 'settled') {
      // The payee revealed, so the sats HAVE left. `paid` first because that is
      // the fact the row is missing; the claim then runs from it exactly as it
      // does for a payment that was tracked all along.
      if (!htlc.preimage) {
        // Money gone with nothing to claim against. Not a refund under any
        // circumstances — that would pay the client twice — and not something
        // to retry either, so it goes to a human with the reason on the row.
        await store.fail(row.id, 'paying', 'backend settled the payment but reported no preimage')
        return false
      }
      if (!(await store.transition(row.id, 'paying', 'paid'))) return false
      return this.claimWithPreimage(row.id, row.paymentHash, htlc.preimage)
    }

    if (htlc.status === 'returned') {
      // The commitment was unwound, so the sats provably did not leave — the
      // same fact `submitPayment` acts on for a terminal `failed`, reached by a
      // different road, so it takes the same route out: probe, refund, park.
      const verdict = await this.refundProvenSelfPayment(row, 'paying')
      if (verdict === 'resolved') return false
      if (verdict !== 'withhold') await this.refundAfterTerminalFailure(row)
      await store.fail(row.id, 'paying', 'lightning payment returned by the backend')
      return false
    }

    // `committed`: undecided, and the sats are at stake. Nothing may be pushed
    // on that — the payee can still reveal — so the row waits where it is.
    return false
  }

  /**
   * Push the covenant refund for a swap whose payment provably died.
   *
   * BEST EFFORT, and never throws: the caller is on its way to `stuck` either
   * way, and a refund that cannot be pushed now must not stop the row being
   * recorded as failed. Worst case is exactly the old behaviour — a funded
   * lockup waiting out `refundLocktime` — so this can only improve on it.
   *
   * Runs BEFORE the state change on purpose. A crash in between leaves the row
   * in `paying`, and the next tick re-polls, sees the same terminal failure and
   * arrives here again — where an already-refunded script has no spendable
   * output and is skipped. Failing first would leave a `stuck` row that no
   * sweep ever revisits, since `findRefundable` selects only `refused`.
   *
   * An empty read is NOT recorded as refunded, for the reason `refundSweep`
   * spells out at length: `refund_outcome` is a one-way door, and writing it on
   * the strength of one empty read would report `refunded` to a client whose
   * sats are still at the script.
   */
  private async refundAfterTerminalFailure(row: SendSwapRow): Promise<boolean> {
    const { store, arkade } = this.deps
    // Only the two ARKADE calls belong in the try. A store fault is not a
    // refund failure, and recording it as one describes the opposite of what
    // happened — an empty script written up as a broken refund, or worse, a
    // refund that broadcast written up as failed.
    let txid: string
    try {
      const outputs = await arkade.findLockups(row.pkScript)
      if (outputs.length === 0) {
        // Still not recorded as refunded — `refund_outcome` is the one-way door
        // above. But the ATTEMPT is recorded, because the row is about to park
        // in `stuck` where nothing revisits it, and an operator reading it then
        // needs to know this was tried and found nothing rather than never run.
        await store.patch(row.id, { refund_attempt: 'nothing-at-script' }).catch((error: unknown) => {
          this.onTickError?.(row.id, error)
        })
        return false
      }
      txid = await arkade.refund(row, outputs)
    } catch (error) {
      // The gap this closes: a THROW here was swallowed to a log and the row
      // continued to `stuck` with `refund_outcome` null — indistinguishable
      // from a refund never attempted. `stuck` is excluded from
      // `findRefundable` deliberately (a false "failed" verdict plus an
      // automatic refund is a double payout), so nothing retries it and the
      // operator is the retry. They cannot be, if the row does not say what
      // happened.
      //
      // Observed in production: a 50,151-sat row parked for four days with a
      // funded lockup, `refund_outcome` null, and the only evidence in a log
      // line that had long since scrolled away.
      const reason = error instanceof Error ? error.message : String(error)
      await store.patch(row.id, { refund_attempt: `failed: ${reason}`.slice(0, 500) }).catch(() => undefined) // recording is best-effort too; never mask the original
      this.onTickError?.(row.id, error)
      return false
    }
    // THE REFUND IS ON THE WIRE. Everything below is bookkeeping about an action
    // that already happened, and a failure to write it down must never be
    // recorded as a failure to do it: `failed:` against a refund that broadcast
    // is the most dangerous line this column can carry, because `stuck` means a
    // human reads it and acts. The txid goes into the log instead, which is the
    // only other durable place it can go.
    await store
      .patch(row.id, { refund_outcome: 'pushed', refund_ark_txid: txid, refund_attempt: 'pushed' })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        this.onTickError?.(row.id, new Error(`refund ${txid} broadcast but could not be recorded: ${reason}`))
      })
    return true
  }

  /**
   * Close a terminally-failed row in the state it has actually earned.
   *
   * `stuck` must mean "a human must look", or it means nothing. Lightning is
   * volatile and payments fail often; parking every failed-then-refunded swap
   * there buries the rows that genuinely need attention under ones that need
   * none, and an operator who learns to skim `stuck` is worse off than one who
   * never had it.
   *
   * The only risk that would justify the flag is an in-flight payment settling
   * AFTER the refund went out — paying twice. That is foreclosed upstream, not
   * here: `toPaymentStatus` reports `failed` ONLY for an allowlist of three
   * statuses and leaves everything unrecognised `pending`, precisely because
   * "calling a live payment dead" is the unrecoverable mistake. A `failed`
   * verdict therefore means terminal, and a terminal payment cannot later
   * settle. The refund is safe and the row is finished.
   *
   * The two cases that DO still need a human keep `stuck`:
   *   - the refund did not land (`refunded` false) — the client is not whole;
   *   - the self-payment probe withheld it — our own node may still collect,
   *     which is the one live double-collect risk and is decided before here.
   *
   * The reason is recorded either way, so nothing goes silent, and
   * `rfqStateFromRow` reports `refunded` to the client from either state.
   *
   * Safe against the refund sweep: `findRefundable` takes `refused` rows with
   * `refund_outcome IS NULL`, so a row arriving here already refunded is never
   * picked up and refunded twice.
   */
  private async settleTerminalFailure(row: SendSwapRow, from: 'paying' | 'paid', finished: boolean): Promise<void> {
    const { store } = this.deps
    if (!finished) {
      await store.fail(row.id, from, 'lightning payment failed terminally')
      return
    }
    await store.transition(row.id, from, 'refused', {
      failure_reason: 'lightning payment failed terminally; client refunded',
    })
  }

  /**
   * @param nothingCommitted proof, held by the caller, that no payment is
   * committed against this row's hash — see the route-deadline gate below,
   * which is the only thing that reads it.
   */
  private async submitPayment(row: SendSwapRow, nothingCommitted: boolean): Promise<boolean> {
    const { store, ln } = this.deps
    if (!row.idempotencyKey) {
      // Unreachable by construction; refusing to pay without one is the point.
      await store.fail(row.id, row.state, 'paying state with no idempotency key')
      return false
    }
    // Decoded once for every field below — same reasoning as `whenFunded`'s.
    const invoice = decodeInvoice(row.invoice, this.sendHintScidDenylist)
    const cltv = {
      minFinalCltvBlocks: invoice.minFinalCltvBlocks,
      worstRouteHintCltvBlocks: invoice.worstRouteHintCltvBlocks,
      bestRouteHintCltvBlocks: invoice.bestRouteHintCltvBlocks,
      routeCltvBudgetBlocks: ln.routeCltvBudgetBlocks,
      enforcesRouteCltv: ln.enforcesRouteCltv,
    }
    // The rail-change gate's second door, and the one `evaluateSendPayment`
    // cannot cover. `whenFunded` asks before transitioning; `whenPaying`
    // reaches here WITHOUT re-asking any pay-time gate, because a row that
    // committed intent and then died before `payInvoice` is re-submitted on
    // whatever backend is running now. That is the same capped -> uncapped
    // rail change, arriving one state later — and a crash is precisely when a
    // deployment gets restarted under new configuration.
    //
    // Only the uncapped case, deliberately. Everything else `evaluateSendPayment`
    // checks is a reason not to START a payment; this one is the invariant that
    // the ceiling below cannot carry on a rail that drops it, so re-submitting
    // is what would breach it.
    //
    // Reachable ONLY from that recovery path in practice: `whenFunded` runs
    // `evaluateSendPayment` against this same live `ln` immediately before
    // transitioning, so a row that would trip this never reaches `paying` by
    // the ordinary route. It still supplies its own proof below rather than
    // leaning on that, because "unreachable" here is a property of two gates
    // agreeing — not something this branch should assume about its callers.
    //
    // Refunds or parks on `nothingCommitted`, which is the CALLER's fact rather
    // than one readable from the row: only the caller knows how this row
    // reached here. `whenFunded` has just won the transition and not yet called
    // `payInvoice`; `whenPaying` has just had `getSendHtlcState` answer
    // "nothing committed" for this hash. Either way nothing was paid out, the
    // row was never really exposed, and `store.fail`'s state-based rule — which
    // sees only `paying` — parks it for an operator who has nothing to decide.
    //
    // `stuck` remains right for the case that fact does NOT cover: a backend
    // with no probe has contradicted nothing, its silence is not "holds
    // nothing", and auto-refunding there would be the empty read recorded as a
    // refund that the refund sweep documents at length. Same distinction
    // `whenPaying` already draws for `PaymentHashRegistered`.
    // Resolved to seconds for the same reason `whenFunded` resolves it: both readings
    // below order this deadline against a CLTV budget, which is Lightning's and is
    // wall-clock whatever unit our covenant counts.
    const refundDeadlineForCltv = await this.refundDeadlineSeconds(row.refundLocktime)
    if (!ln.enforcesRouteCltv && !deadlineContainsHtlc(cltv, refundDeadlineForCltv, this.now())) {
      const reason = 'refused to pay: uncapped_route_deadline_too_short'
      if (nothingCommitted) await store.transition(row.id, row.state, 'refused', { failure_reason: reason })
      else await store.fail(row.id, row.state, reason)
      return false
    }
    const result = await ln.payInvoice({
      invoice: row.invoice,
      // Sized against what is actually being ROUTED, not against the lockup:
      // the lockup carries our fee too, and a routing cap inflated by our own
      // spread would quietly authorise paying more away than the swap earns.
      // Re-decoded from the row's own invoice for the same reason
      // `maxCltvBlocks` below is.
      maxFeeSats: maxRoutingFeeSats(invoice.amountSats),
      idempotencyKey: row.idempotencyKey,
      // Built above from the row's own invoice rather than stored alongside
      // `refundLocktime`: `decodeInvoice` is pure and `row.invoice` is the
      // verbatim string the quote was built from, so this is the same
      // `minFinalCltvBlocks` that priced the deadline -- by construction, with
      // no second copy that could go stale against it.
      //
      // Clamped to what is LEFT of that deadline, not the whole budget it was
      // quoted with: this runs on the crash-recovery path too, where the gap
      // between quoting and paying is unbounded. See `payableCltvBlocks`.
      maxCltvBlocks: payableCltvBlocks(cltv, refundDeadlineForCltv, this.now()),
    })
    // WITH the id, not after it: an id recorded without the wallet that minted
    // it is exactly the row that later reads as "provider lost the record" when
    // the truth is "you switched providers". Best-effort — a backend that
    // cannot name its wallet records null, which means unknown.
    const wallet = await ln.walletFingerprint?.().catch(() => undefined)
    await store.patch(row.id, {
      payment_id: result.id,
      ...(this.backendName ? { payment_backend: this.backendName } : {}),
      ...(wallet ? { payment_wallet: wallet } : {}),
    })
    if (result.status === 'failed') {
      // Terminal per the adapter's allowlist, and that is a stronger fact than
      // it reads. Every reason in `FAILED_PAYMENT_REASONS` comes from LND's own
      // terminal `failed` state — the vendor's `checkFailure` produces none of
      // those names until the payment has already settled as failed — so the
      // sats provably did not leave and cannot later. A transport error or a
      // still-in-flight payment never reaches here; those stay `pending`.
      //
      // The self-payment probe goes first: it is the only reader that can see
      // the PAYEE side of this invoice, so it either resolves the row outright
      // (refunded and `refused` — nothing of the payee's moved, so no operator
      // is needed) or vetoes the refund below.
      const verdict = await this.refundProvenSelfPayment(row, 'paying')
      if (verdict === 'resolved') return false
      // Every other terminal failure: give the client their money back NOW
      // rather than leaving them to wait out `refundLocktime` for a swap we
      // already know is dead. Before this the lockup simply sat there, and the
      // client learned nothing until their own deadline matured — days, for a
      // failure that took a second.
      //
      // Unless the probe vetoed it. `failed` proves the sats did not leave by
      // the route we tried; it says nothing about an htlc our own node is
      // holding against this same invoice, and refunding into that would pay
      // the client twice.
      const refunded = verdict !== 'withhold' && (await this.refundAfterTerminalFailure(row))
      await this.settleTerminalFailure(row, 'paying', refunded && verdict === 'not-ours')
      return false
    }
    if (!(await store.transition(row.id, 'paying', 'paid', { payment_id: result.id }))) return false
    // `payInvoice` frequently resolves `P` itself, and the backend already told
    // us so in this very response. Spending it here saves a whole `getPayment`
    // round trip on the one path where latency is the provider's own exposure
    // window; when it is absent, `whenPaid` polls exactly as it always did.
    if (result.preimage) await this.claimWithPreimage(row.id, row.paymentHash, result.preimage)
    return true
  }

  /**
   * The ONE exception to "a terminal payment failure parks in `stuck`": a
   * self-payment the payee side can disprove.
   *
   * When the invoice is one OUR OWN node minted, the payee's record is ours
   * to read, and that record answers the question the conservative rule
   * otherwise refuses to trust a payer-side "failed" verdict with: did the
   * sats ever leave? Terminal failure from `paying` plus our own node saying
   * the invoice was never paid means provably not — the only place they could
   * have gone is back to us. So the client's lockup goes straight back to
   * them through the covenant's non-interactive refund leaf (server +
   * receiver + emulator, no timelock) instead of sitting in `stuck` until
   * `refundLocktime` — days out, for a swap that failed in under a second.
   *
   * Every other terminal failure still fails to `stuck` — but no longer with
   * the lockup untouched, because the ordinary path now refunds on the payer
   * side's own evidence (see {@link refundAfterTerminalFailure}). What this
   * probe adds on top is a better STATE for the case it can prove (`refused`,
   * not `stuck` — nothing of the payee's ever moved, so nobody needs to look)
   * and, in one direction only, a veto.
   *
   * @returns `resolved` when the row was handled here. `withhold` when our own
   *   node holds an armed or settled htlc for this invoice: money may still be
   *   in play, so the ordinary refund is vetoed too and a human reads the row.
   *   `ordinary` when the probe learned nothing that bears on it — the invoice
   *   is not ours, or the node could not be asked — and the terminal-failure
   *   rule stands on its own.
   */
  private async refundProvenSelfPayment(row: SendSwapRow, from: 'paying' | 'paid'): Promise<SelfPaymentVerdict> {
    const { store, ln, arkade } = this.deps
    let own: HoldState | null
    try {
      if (ln.getOwnInvoiceState === undefined) return 'unknown'
      own = (await ln.getOwnInvoiceState(row.paymentHash)) ?? null
    } catch {
      // The probe itself failed: nothing was learned about the payee side, so
      // the ordinary terminal-failure rule applies on its own evidence — but
      // the row stays flagged, because "not asked" is not "not ours".
      return 'unknown'
    }
    if (own === null) return 'not-ours' // the probe answered: not our invoice
    // Armed or settled. An htlc against OUR OWN invoice may yet pay out, and
    // that is the one thing the payer-side "failed" verdict cannot see: handing
    // the lockup back while the payee side may still collect would pay twice.
    // So this verdict withholds the ordinary refund as well — the only case
    // that is stricter than the rule it sits in front of.
    if (own.status !== 'pending' && own.status !== 'cancelled') return 'withhold'

    // Provably unpaid. Refused, not stuck: nothing of the payee's ever moved,
    // which is exactly the fact `refused` already records everywhere else.
    // The state moves BEFORE the push — intent before the irreversible side
    // effect: a crash between them leaves a refused row the deadline sweep
    // still refunds, never a `paying` row that could be re-driven into a
    // second attempt.
    const won = await store.transition(row.id, from, 'refused', {
      failure_reason: 'self-payment failed terminally; our own node says it was never paid',
    })
    // Lost the race: a concurrent tick already moved this row out of `from`
    // and owns whatever happens to it. Withhold rather than fall through — a
    // refund pushed against a row somebody else is driving is the one outcome
    // worse than doing nothing.
    if (!won) return 'withhold'

    // A legacy three-leaf row has no non-interactive refund leaf — its refund
    // is timelocked, and an early push would only be rejected. Refused is
    // still the right state for it: the ordinary sweep pushes the moment the
    // deadline matures, which needs no human and no new machinery.
    if (row.clientRefundPubkey === null) return 'resolved'
    try {
      const outputs = await arkade.findLockups(row.pkScript)
      if (outputs.length === 0) {
        // Empty reads two ways, exactly as refundSweep documents: genuinely
        // moved (our own earlier push, crashing before the patch landed — the
        // only mover possible before the deadline, since the client alone
        // cannot spend this leaf) or a `spendableOnly` view a moment behind.
        // Only the first is recorded; the second leaves the sweep to retry.
        if (await arkade.lockupProvablySpent(row.pkScript)) {
          await store.patch(row.id, { refund_outcome: 'external' })
        }
        return 'resolved'
      }
      const txid = await arkade.refund(row, outputs)
      await store.patch(row.id, { refund_outcome: 'pushed', refund_ark_txid: txid })
    } catch (error) {
      // The row is already refused, so the deadline sweep owns the retry —
      // the client gets the same refund, only later. Log and resolve.
      this.onTickError?.(row.id, error)
    }
    return 'resolved'
  }

  /**
   * Move a row to `claiming` with a preimage we have just learned.
   *
   * Shared by all three sources — the fresh `payInvoice` response, every later
   * `getPayment` poll, and the coupled path's read of an Arkade claim witness —
   * so the hash check, the gate that keeps a preimage which cannot open the
   * script out of the claim path, cannot drift between them.
   *
   * `from` is the state the caller observed: `paid` for the two Lightning
   * sources, `funded` for the coupled one, which never passes through `paid`
   * because it never pays. Passing it (rather than reading the row again) keeps
   * the compare-and-set honest — the transition still fails if another worker
   * moved the row first.
   *
   * Note the failure routing differs by caller, because `fail` picks its target
   * from whether `from` is an exposed state: a Lightning mismatch lands in
   * `stuck` (money may be in play), a coupled one in `refused`. That asymmetry
   * is only reachable through a lying `coupling.findClaimPreimage` — the real
   * one verifies and answers null — so it is left as-is rather than widening
   * the lifecycle a second time for a case the contract already excludes.
   *
   * @returns true when the row advanced to `claiming`.
   */
  private async claimWithPreimage(
    id: string,
    paymentHash: string,
    preimage: string,
    from: 'paid' | 'funded' = 'paid',
  ): Promise<boolean> {
    const { store } = this.deps
    // Verify BEFORE committing to claim with it. A wrong value (backend bug,
    // proto change, a compromised backend) would fail every claim attempt and,
    // past the deadline, strand the swap — so catch it here and route to a human
    // instead of poisoning the claim path with a preimage that cannot open the
    // script.
    if (!preimageMatchesHash(preimage, paymentHash)) {
      await store.fail(id, from, 'preimage does not match the payment hash')
      return false
    }
    // The preimage hits disk in the same transition that changes state: from
    // `claiming` onward the claim needs nothing external any more.
    return store.transition(id, from, 'claiming', { preimage })
  }

  private async whenPaid(row: SendSwapRow): Promise<boolean> {
    return this.settleFromBackend(row, 'paid')
  }

  /** Poll the backend once for the payment's outcome and advance accordingly. */
  private async settleFromBackend(row: SendSwapRow, from: 'paying' | 'paid'): Promise<boolean> {
    const { store, ln } = this.deps
    if (!row.paymentId) return false
    const polled = await ln.getPayment(row.paymentId)
    // Record what the backend knew before acting on it, so a fill that has
    // stalled is legible to an operator and to the client instead of reading
    // exactly like a healthy one. Only on a CHANGE: this poll runs every tick,
    // and rewriting the same verdict would be a write per tick for a value that
    // moves a handful of times in a swap's whole life.
    if (polled.evidence !== undefined && polled.evidence !== row.paymentEvidence) {
      await store.patch(row.id, { payment_evidence: polled.evidence })
    }
    // The backend's own verdict on WHY, kept separate from the sentence `fail()`
    // writes: that one says what we concluded about the swap, this says what the
    // rail reported about the payment, and reading them together is what
    // distinguishes "nobody could route to them" from "someone else had already
    // settled this invoice".
    if (polled.failureReason !== undefined && polled.failureReason !== row.paymentFailureReason) {
      await store.patch(row.id, { payment_failure_reason: polled.failureReason })
    }
    if (polled.status === 'failed') {
      // The self-payment exception applies to the polled failure exactly as to
      // the immediate one: from either non-terminal payment state, "failed"
      // plus our own node saying it was never paid is the same provable fact.
      const verdict = await this.refundProvenSelfPayment(row, from)
      if (verdict === 'resolved') return false
      // And so does the ORDINARY refund. `failed` here comes from the same
      // adapter allowlist `submitPayment` trusts, so it carries the same proof
      // that the sats did not leave — the only difference is that a payment
      // which went in flight before it died is discovered a tick later, by the
      // poll rather than by `payInvoice`. Refunding on one and not the other
      // left exactly those clients waiting out `refundLocktime` for a swap the
      // solver already knew was dead.
      //
      // Safe from `paid` as well as `paying`: `paid` means the payment id is
      // known and the preimage may not be, NOT that anything of ours has been
      // claimed — the claim is `claiming`/`claimed`. The client's lockup is
      // still sitting there, and `refundAfterTerminalFailure` reads it before
      // pushing, so an already-swept one is a no-op rather than a double spend.
      //
      // Unless the probe vetoed it, for the same reason as on the immediate
      // path: `failed` says nothing about an htlc our own node is holding
      // against this same invoice, and refunding into that would pay twice.
      const refunded = verdict !== 'withhold' && (await this.refundAfterTerminalFailure(row))
      await this.settleTerminalFailure(row, from, refunded && verdict === 'not-ours')
      return false
    }
    if (from === 'paying' && !(await store.transition(row.id, 'paying', 'paid', {}))) return false
    if (!polled.preimage) {
      // Not known yet — keep waiting. A missing preimage is routine on the
      // first polls of a payment that ultimately succeeds.
      return from === 'paying'
    }
    return this.claimWithPreimage(row.id, row.paymentHash, polled.preimage)
  }

  private async whenClaiming(row: SendSwapRow): Promise<boolean> {
    const { store, arkade } = this.deps
    if (!row.preimage) {
      await store.fail(row.id, 'claiming', 'claiming state with no preimage')
      return false
    }
    const outputs = await arkade.findLockups(row.pkScript)
    if (outputs.length === 0) {
      // The script is empty, but we hold no claim txid — so we have NO positive
      // proof our claim landed. `findLockups` returns [] for a swept, renewed or
      // lagging vtxo exactly as it does after our own spend (`spendableOnly`
      // excludes a swept-but-unspent vtxo, and an empty indexer page maps to []),
      // so "empty" is NOT "claimed". Recording success here would bury a
      // full-amount loss — a swept lockup, or a client refund after we paid — as
      // `claimed`. Route to `stuck` for a human: a false `stuck` (we really did
      // claim and a crash ate the record) costs a glance; a false `claimed` costs
      // the funds. The only path that ever records `claimed` is the one below,
      // which has our own claim txid in hand.
      await store.fail(row.id, 'claiming', 'lockup empty while claiming with no claim txid recorded; needs review')
      return false
    }

    // Funds still present. Try the collaborative claim.
    try {
      const txid = await arkade.claim(row, outputs, row.preimage)
      await store.transition(row.id, 'claiming', 'claimed', { claim_ark_txid: txid })
      return false
    } catch (error) {
      // Past the deadline, a persistently failing claim means the Arkade Service
      // is censoring or down while the client's refund is open and racing us.
      // Nothing COLLABORATIVE is left to retry that could win, so escalate to a
      // human rather than loop silently. Before the deadline the failure is
      // transient: rethrow so tickAll records it and the next sweep retries.
      //
      // What IS left is the server-independent exit, and the parked row names
      // it. On this leg the client funds and the solver is the covenant
      // receiver, so the solo path is `unilateralClaim` — the leaf that reveals
      // the preimage this row already holds. `unilateralExitRecourse` reads that
      // off the row's own roles rather than assuming the leg, and never throws,
      // so it cannot turn an escalation into an error about the escalation.
      if (await this.refundDeadlineReached(row.refundLocktime)) {
        const detail = error instanceof Error ? error.message : String(error)
        const recourse = unilateralExitRecourse(row, { solverPubkey: arkade.providerPubkey })
        await store.fail(row.id, 'claiming', `claim failing past the refund deadline: ${detail} — ${recourse}`)
        return false
      }
      throw error
    }
  }
}
