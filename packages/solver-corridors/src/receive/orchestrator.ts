/**
 * The receive-leg orchestrator: the one place quote/arm/fund/claim/settle
 * is driven for `lightning:BTC->arkade:BTC` — the RECEIVE mirror of
 * `src/send/orchestrator.ts`. Same two rules apply:
 *
 * 1. **The row is the truth.** Every step reads the row, decides, and commits
 *    the outcome before the next step.
 * 2. **One step, many callers.** `tick` is safe to call from any number of
 *    concurrent callers — an in-process guard plus the store's
 *    compare-and-swap.
 *
 * Structurally new relative to the send legs: THIS provider funds its OWN Arkade
 * lockup, which inverts the covenant's roles (see `receiveCovenantRowFor`) and makes
 * the provider the party needing its own refund back if the swap fails.
 *
 * The steps from docs/rfq-protocol.md §7.1.2, mapped onto states:
 *
 *   issue hold invoice          -> quoted
 *   wait for arm (poll)         -> armed
 *   evaluateReceiveFunding      -> (gate, at the armed->funded edge)
 *   fund the Arkade lockup      -> funded
 *   watch for the claim, settle -> claimed -> settled
 *
 * plus the failure spine: refused (no exposure), refunding / refunded (the provider's
 * own capital coming back), stuck (needs a human).
 */

import { randomUUID } from 'node:crypto'
import type { AdmissionStrategy } from '@arkade-os/solver-core/core/admissionStrategy.js'
import { ArkAddress } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import {
  evaluateReceiveFunding,
  MAX_FINAL_CLTV_BLOCKS,
  MAX_REFUND_HORIZON,
  minFinalCltvBlocksFor,
  SETTLE_SAFETY_MARGIN,
} from '@arkade-os/solver-core/core/receive.js'
import { MIN_CLAIM_WINDOW, refundWithoutReceiverDelayCovers } from '@arkade-os/solver-core/core/send.js'
import {
  planReceive,
  planRefundFailed,
  planSettleFailed,
  type ReceiveReads,
} from '@arkade-os/solver-core/core/receivePlan.js'
import type { ChainTipProvider } from '@arkade-os/solver-rails/onchain/chainTip.js'
import { absoluteLocktimeFor, refundDeadlineReached, refundDeadlineSeconds } from '../chainClock.js'
import type { Limits } from '@arkade-os/solver-core/core/limits.js'
import { FREE, type Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { fixedFeePricing, type PricingStrategy } from '@arkade-os/solver-core/core/pricing.js'
import { RFQ_PAIR_RECEIVE } from '../wire/lightningReceivePayloads.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { satsOutputs, type FundedOutput } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { unilateralExitRecourse } from '@arkade-os/solver-arkade/arkade/unilateralExit.js'
import { parseUnrolledSpend, type UnrolledSpendRecord } from '@arkade-os/solver-arkade/arkade/unrolledSpend.js'
import { covenantScriptFromRow } from '../send/arkadeOps.js'
import type { CovenantScriptRow } from '../send/orchestrator.js'
import { claimPacketStamp } from './claimPacket.js'
import type { ReceiveArkadeOps } from './arkadeOps.js'
import { LockupPreimageReader } from './lockupPreimage.js'
import { applyUnrolledSpendStep } from '../unrolledSpendStep.js'
import type { OnchainBackend } from '@arkade-os/solver-core/ports/onchain.js'
import { FundNotSubmittedError } from './fundLockup.js'
import type { LightningBackend } from '@arkade-os/solver-core/ports/lightning.js'
import { EXPOSED, type ReceiveSwapRow, type ReceiveSwapStore } from '../db/receiveSwaps.js'
import type { SendSwapRow } from '../db/swaps.js'
import { GiveUp, json, log, messageOf, nowSeconds, poll } from '@arkade-os/solver-core/util/poll.js'
import { sweep } from '@arkade-os/solver-core/util/sweep.js'
import { wasRead } from '@arkade-os/solver-core/util/wasRead.js'
import { QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS, RateLimiter } from '@arkade-os/solver-core/core/rateLimit.js'
import { UniqueConstraintError } from '@arkade-os/solver-core/core/driver.js'
import { adoptFunding, type LockupOutpoint } from '../legs/arkadeLockup.js'

const DEADLINE_SECONDS_PURPOSE = 'order the refund deadline against the HTLC'

/**
 * How long a minted hold invoice stays valid, seconds — DERIVED, never chosen.
 *
 * A payer may pay up to `payDeadline` (`min(invoice.expiresAt, quote.valid_until)`),
 * after which the solver must still claim the Arkade lockup before its own refund
 * opens. The gap is what it has to win that race:
 *
 *     refundLocktime - payDeadline  >=  MIN_CLAIM_WINDOW
 *
 * `refundLocktime` cannot move — the covenant is built from it — so this window is the
 * only degree of freedom. Subtracting rather than picking a number is what makes an
 * unpayable corridor unrepresentable: hardcoded values previously left claim races of
 * 0s and 1500s, both under what clients require, refusing every quote deterministically.
 *
 * A backend cannot break it either way. One that SHORTENS the invoice moves
 * `payDeadline` earlier and WIDENS the race; one that lengthens it cannot help itself,
 * because `validUntil` derives from this same constant and `payDeadline` takes the
 * MINIMUM. `quote()` stamps both from a single `this.now()`, so the margin is exactly
 * `MIN_CLAIM_WINDOW`.
 */
export const DEFAULT_HOLD_INVOICE_WINDOW = MAX_REFUND_HORIZON - MIN_CLAIM_WINDOW

/**
 * How long (polling 100ms apart) to wait for the provider's own just-broadcast
 * Arkade funding to become visible at the indexer before giving up.
 *
 * Arkade funding is server-confirmed synchronously, so this absorbs indexer read-lag
 * only — not a confirmation delay.
 */
const FUND_CONFIRM_BUDGET_MS = 8_000
const FUND_CONFIRM_INTERVAL_MS = 100

export { EMPTY_LOCKUP_GRACE, REFUND_CENSORSHIP_GRACE } from '@arkade-os/solver-core/core/receivePlan.js'

/**
 * Maps this leg's row onto the shape `covenantScriptFromRow`
 * (`src/send/arkadeOps.ts`) needs — the receive-leg counterpart of
 * `src/send/onchainOrchestrator.ts`'s `covenantRowFor`.
 *
 * A ROLE INVERSION, not a rename: on this leg the CLIENT ultimately claims (they
 * generated `P`), so they play the covenant's `receiver`; the PROVIDER funds the
 * lockup and needs the "needs nobody" refund, so it plays `client`. The three delay
 * fields are NOT part of the inversion — they are operator-derived
 * (`deriveUnilateralDelays`) and mean the same thing whoever holds which key.
 *
 * Also consumed by `arkade/vtxoLifecycle.ts`'s `liveLockupRows`, aliased there against
 * the other receive corridor's same-named function.
 */
export const receiveCovenantRowFor = (row: ReceiveSwapRow): CovenantScriptRow => ({
  id: row.id,
  receiverPubkey: row.payoutPubkey,
  serverPubkey: row.serverPubkey,
  paymentHash: row.paymentHash,
  refundLocktime: row.refundLocktime,
  claimDelay: row.claimDelay,
  emulatorPubkey: row.emulatorPubkey,
  refundPkScript: row.solverRefundPkScript,
  pkScript: row.pkScript,
  clientRefundPubkey: row.solverPubkey,
  refundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
  refundDelay: row.refundDelay,
  receiverPkScript: row.payoutPkScript,
  nonInteractiveParameters: row.nonInteractiveParameters,
})

export interface ReceiveServiceDeps {
  quoteLimiter?: RateLimiter
  /**
   * How this corridor prices. Absent means the configured flat+bps `fee`,
   * which is what every deployment used before pricing became injectable.
   */
  pricing?: PricingStrategy
  store: ReceiveSwapStore
  backendName?: string
  ln: Pick<
    LightningBackend,
    | 'createHoldInvoice'
    | 'holdForPayable'
    | 'getHoldState'
    | 'settleHold'
    | 'cancelHold'
    | 'onHoldAccepted'
    | 'walletFingerprint'
    | 'getKnownInvoiceState'
  >
  arkade: ReceiveArkadeOps
  /** Reads `P` off the L1 claim of a lockup the client unrolled. The rail's own wallet in production. */
  onchain?: Pick<OnchainBackend, 'findSpendWitness'>
  limits: Limits
  /**
   * Whether this deployment accepts funding into the unilateral-gap window — see
   * `Config.lnReceiveAcceptUnilateralGap` for what that means and why mainnet
   * needs it. Threaded rather than read from config here so this service keeps
   * taking every policy input through its deps, and so a test can exercise both
   * positions without touching the environment.
   */
  acceptUnilateralGap: boolean
  /** Cap on the SUM of amounts across all currently-exposed swaps — same role as the send legs' identical field. */
  maxExposedSats: number
  /** Sum of committed sats across every corridor, not just this notebook. */
  totalCommitted: () => Promise<number>
  /**
   * Reserves cap headroom for a quote whose row has not landed yet.
   * SHARE one instance across every corridor: a per-corridor control bounds
   * only its own concurrency, which is the narrower half of the problem.
   */
  admission: AdmissionStrategy
  /**
   * What this corridor charges. The client pays the hold invoice in full; the
   * solver funds the Arkade lockup with the amount MINUS the fee, persisted
   * on the row as `payoutSats` at quote time. Omitted means free, which is
   * what it charged before fees existed.
   */
  fee?: Fee
  /**
   * The OTHER corridors' stores, consulted for the duplicate-hash check. A
   * hash live in ANY corridor's store is spoken for: minting a hold invoice
   * on a hash a live SEND swap of ours is paying would loop the payment back
   * to ourselves.
   */
  peerStores?: readonly { findLiveByPaymentHash(paymentHash: string): Promise<unknown> }[]
  /**
   * The Lightning SEND store — the coupled leg of a self-payment refresh.
   *
   * When a client quotes this corridor and then the send corridor against the
   * bolt11 we just minted, no htlc will ever arrive here: the invoice is ours
   * and we cannot pay it. This leg funds against their SEND lockup instead.
   *
   * Typed and separate because `peerStores` answers `unknown` and cannot say which
   * corridor replied. It must NOT also appear there, or it would be consulted twice.
   *
   * Still consulted for the duplicate-hash check in `quote`: a coupling is always
   * receive-then-send, so a live send row on the hash at THIS leg's quote time is a
   * conflict, never the coupling.
   *
   * Wire this ONLY where the send corridor's own `coupling` is also wired. Funding here
   * with no collect path there is the loss case: we pay out, the client claims, and
   * nothing ever claims their lockup back.
   */
  coupledSendStore?: { findLiveByPaymentHash(paymentHash: string): Promise<CoupledSendRow | null> }
  /**
   * Where the chain tip is. Required only when this deployment's timelocks count blocks
   * — see `core/timelocks.ts`. Absent is correct for a seconds-typed deployment, which
   * never asks.
   */
  chainTip?: ChainTipProvider
  now?: () => number
}

/**
 * What this leg needs to read off a coupled SEND row before it will pay out:
 * whether their lockup is funded, where it is, and what it must hold.
 *
 * A `Pick` rather than the whole `SendSwapRow`, so this corridor depends on
 * three fields instead of the other's entire shape.
 */
export type CoupledSendRow = Pick<
  SendSwapRow,
  'state' | 'pkScript' | 'amountSats' | 'refundLocktime' | 'refundWithoutReceiverDelay' | 'createdAt'
>

type HistoryOutpoint = LockupOutpoint & { unrolled: boolean }

/** The planner's reads for one tick, and the two lists it read that a refund then needs in full. */
interface TickReads extends ReceiveReads {
  outputs: FundedOutput[] | null
  history: HistoryOutpoint[] | null
}

export interface ReceiveQuoteRequest {
  requesterKey?: string
  /** `H = sha256(P)`, client-chosen, hex. */
  paymentHash: string
  /**
   * The amount the request carries, read through `amountSide`: the client's
   * give for exact-in, the payout it wants for exact-out.
   */
  amountSats: number
  /** exact-in (default): the fee comes out of the payout. exact-out: the give is solved up from the corridor's fee. */
  amountSide?: 'from' | 'to'
  payoutAddress: string
  /** The client's own x-only key — the covenant's `receiver` role on this leg. */
  payoutPubkey: string
  claimPacket: string | null
  rfqId?: string
}

export type QuoteRefusal =
  | 'rate_limited'
  | 'amount_out_of_range'
  | 'fee_consumes_swap'
  | 'payout_below_dust'
  | 'invalid_payout_address'
  | 'invalid_claim_packet'
  | 'duplicate_swap'
  | 'provider_at_capacity'
  /**
   * `E` cannot be pushed far enough out for the solver's own unilateral
   * recourse to open before it, because the operator's exit delay is too long.
   * A property of the deployment, not of the request — every quote on this
   * corridor gets this answer until the delay comes down.
   */
  | 'recourse_window_unservable'
  /** No hold could be minted whose PUBLISHED invoice asks exactly the exact-in give. */
  | 'payable_amount_unmatchable'

export type QuoteOutcome =
  { accepted: true; swap: ReceiveSwapRow; validUntil: number } | { accepted: false; reason: QuoteRefusal }

export class ReceiveSwapService {
  onQuoteTiming?: (sample: {
    rfqRef?: string
    swapId: string
    prepareMs: number
    holdMs: number
    persistMs: number
  }) => void
  onStepTiming?: (sample: { swapId: string; rfqRef?: string; step: 'quoted' | 'armed'; ms: number }) => void
  private readonly now: () => number
  private readonly quoteLimiter: RateLimiter
  private readonly inFlight = new Set<string>()
  private readonly fee: Fee
  /** How this corridor prices. Defaults to the configured flat+bps fee. */
  private readonly pricing: PricingStrategy

  private readonly admission: AdmissionStrategy
  private readonly preimages: LockupPreimageReader

  constructor(private readonly deps: ReceiveServiceDeps) {
    this.admission = deps.admission
    this.preimages = new LockupPreimageReader(deps.arkade, deps.onchain, (id, error) => this.onTickError?.(id, error))
    this.now = deps.now ?? nowSeconds
    this.quoteLimiter = deps.quoteLimiter ?? new RateLimiter(QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS, this.now)
    this.fee = deps.fee ?? FREE
    this.pricing = deps.pricing ?? fixedFeePricing(this.fee)
  }

  onTickError?: (id: string, error: unknown) => void

  /**
   * Its twin: this swap ticked cleanly, so what it was failing at is over.
   * Fired only from the sweep, and only for a row that actually ran.
   */
  onTickSuccess?: (id: string) => void

  /**
   * Set by the host: is this swap being held off after repeated failures?
   *
   * Safe to skip by this class own contract — a tick is re-entrant and re-reads
   * the row — so a skipped tick costs latency on a swap that was failing anyway,
   * and spares the backend a question whose answer has not changed.
   * @see packages/solver-app/src/ops/tickErrors.ts
   */
  shouldSkipTick?: (id: string) => boolean

  /**
   * Quote a receive swap: mint a hold invoice on the client's `H` and persist
   * the row.
   *
   * Ordering is deliberately mint-then-persist, the opposite of the send
   * legs' "compute everything, touch the outside world last" — because unlike
   * every other quote() in this codebase, this one has an external side
   * effect (minting the invoice) with nothing to commit beforehand. That
   * ordering is safe here specifically: a crash between minting and
   * persisting leaves an ORPHANED hold invoice nobody can pay (the BOLT11
   * never left this process, since the caller who would relay it in a
   * `rfq_quote` never got a return value), and hold invoices are naturally
   * one-per-payment-hash (LND keys them by `id: paymentHash`), so nothing here
   * doubles up on retry.
   */
  async quote(request: ReceiveQuoteRequest): Promise<QuoteOutcome> {
    const quoteStarted = performance.now()
    const { store, arkade, limits, ln } = this.deps

    // exact-in: the client names what it GIVES. exact-out: it names what it
    // RECEIVES, and the give is solved up from the corridor's fee instead —
    // the payout is then the request by construction (`giveSatsFor`), which
    // is why `fee_consumes_swap` cannot fire on this side. The limits and
    // the exposure cap both deal in the GIVE: what the client commits.
    const giveSats =
      request.amountSide === 'to'
        ? this.pricing.giveFor({ pair: RFQ_PAIR_RECEIVE, payoutSats: request.amountSats })
        : request.amountSats
    if (giveSats < limits.minSats || giveSats > limits.maxSats) {
      return { accepted: false, reason: 'amount_out_of_range' }
    }

    // The client pays the hold invoice in full; the solver funds the lockup
    // with the amount MINUS this corridor's fee. `payoutSatsFor` deliberately
    // does not clamp (see corridorPolicy.ts): a payout at or below zero is
    // "the fee ate the swap", refused by its own name rather than folded into
    // `amount_out_of_range` — the amount was inside the range, it just cannot
    // be priced.
    let payoutSats =
      request.amountSide === 'to' ? request.amountSats : this.pricing.payoutFor({ pair: RFQ_PAIR_RECEIVE, giveSats })
    if (request.amountSide !== 'to' && payoutSats <= 0) {
      return { accepted: false, reason: 'fee_consumes_swap' }
    }
    if (payoutSats < (arkade.minOutputSats ?? 0)) return { accepted: false, reason: 'payout_below_dust' }

    let payoutPkScript: Uint8Array
    try {
      const address = ArkAddress.decode(request.payoutAddress)
      payoutPkScript = address.pkScript
      if (!request.payoutAddress.toLowerCase().startsWith(`${arkade.hrp}1`)) {
        return { accepted: false, reason: 'invalid_payout_address' }
      }
    } catch {
      return { accepted: false, reason: 'invalid_payout_address' }
    }

    // Before the mint below: a hash live anywhere is spoken for, and a declined
    // quote must not leave a hold invoice.
    const spokenFor = await Promise.all([
      store.findLiveByPaymentHash(request.paymentHash),
      ...(this.deps.peerStores ?? []).map((peer) => peer.findLiveByPaymentHash(request.paymentHash)),
      ...(this.deps.coupledSendStore ? [this.deps.coupledSendStore.findLiveByPaymentHash(request.paymentHash)] : []),
    ])
    if (spokenFor.some(Boolean)) return { accepted: false, reason: 'duplicate_swap' }
    if (request.requesterKey !== undefined && !this.quoteLimiter.take(request.requesterKey)) {
      return { accepted: false, reason: 'rate_limited' }
    }
    // `totalCommitted()`, not this store's own `committedSats()`: the cap is
    // the HOUSE's, so a corridor must not be able to spend it four times over.
    // Kept across the merge with main's coupled-send check above, which is a
    // different question (is this hash spoken for) about the same request.
    // RESERVED, not merely observed: the row below is what makes this swap
    // visible to `totalCommitted()`, and until it lands a concurrent quote
    // reads the same headroom and takes it too. Handed back in the
    // `finally`, by which point either the row counts instead or nothing
    // was committed at all.
    const reservation = await this.admission.admit({
      pair: RFQ_PAIR_RECEIVE,
      giveSats: giveSats,
      capSats: this.deps.maxExposedSats,
      committedSats: this.deps.totalCommitted,
    })
    if (reservation === null) {
      return { accepted: false, reason: 'provider_at_capacity' }
    }
    try {
      const serverKey = hex.decode(arkade.serverPubkey)
      // ONE clock read for the whole quote. `refundLocktime` and `validUntil`
      // are the two halves of the derived-window invariant above, so a second
      // boundary falling between two reads would leave a margin of
      // `MIN_CLAIM_WINDOW - 1` — an invariant the comment states as an equality,
      // violated by nothing but timing.
      const now = this.now()
      // `refund_locktime` is FINAL from here on. The covenant below is built
      // from it, so it is baked into `pkScript`/`lockupAddress` — the script the
      // provider's own sats end up locked in. It is also the field a client
      // derives that same address from (`src/http/server.ts`). Nothing later may
      // move it: a row carrying a different value derives a different script,
      // and a different script cannot spend the funded one, which is exactly how
      // the provider's own refund gets refused by `assertScriptMatchesRow`.
      //
      // `E` is not known yet (the HTLC has not armed), so this cannot be bounded
      // against it here. `evaluateReceiveFunding` CHECKS this value against `E`
      // at the armed->funded edge and refuses to fund if it lands too late,
      // rather than recomputing it.
      //
      // Converted to the unit the script is written in exactly here, once, and the SAME
      // value goes into both the covenant and the row — see `absoluteLocktimeFor`.
      const refundLocktime = await absoluteLocktimeFor(
        now + MAX_REFUND_HORIZON,
        arkade.delays.unilateralClaimDelay,
        this.now,
        this.deps.chainTip,
      )
      const script = new CovenantSwapScript({
        receiver: hex.decode(request.payoutPubkey),
        server: serverKey,
        preimageHash: scriptHashFromPaymentHash(request.paymentHash),
        refundLocktime,
        claimDelay: arkade.delays.unilateralClaimDelay,
        client: hex.decode(arkade.solverPubkey),
        clientRefundDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
        refundWithoutServerDelay: arkade.delays.unilateralRefundDelay,
        // Every quote from here on carries the current, full covenant suite.
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(arkade.emulatorPubkey),
          receiverPkScript: payoutPkScript,
          senderPkScript: hex.decode(arkade.solverRefundPkScript),
        },
      })
      if (request.claimPacket !== null && !claimPacketStamp(request.claimPacket, script)) {
        return { accepted: false, reason: 'invalid_claim_packet' }
      }

      // `E` is chosen here, not merely inspected at funding time. The final CLTV
      // delta is the one part of the htlc's deadline that is ours to set, and it
      // has to be large enough that the solver's own unilateral recourse opens
      // before `E` — otherwise a trader can let the htlc fail back for free
      // during an arkd outage and then claim the payout anyway — unless
      // the operator has accepted that window, in which case gates (b) and (c)
      // set the delta instead and this stays well inside the ceiling below.
      const minFinalCltvBlocks = minFinalCltvBlocksFor(
        arkade.delays.unilateralRefundWithoutReceiverDelay,
        this.deps.acceptUnilateralGap,
      )
      if (minFinalCltvBlocks > MAX_FINAL_CLTV_BLOCKS) {
        // Refused BEFORE minting: an invoice asking beyond a stock payer's
        // `max_cltv_expiry` is unpayable, and a payment that never arrives is a
        // far worse answer than a named refusal.
        return { accepted: false, reason: 'recourse_window_unservable' }
      }

      const validUntil = now + DEFAULT_HOLD_INVOICE_WINDOW
      let invoiceWalletFingerprint: string | null = null
      if (ln.getKnownInvoiceState && ln.walletFingerprint) {
        try {
          invoiceWalletFingerprint = await ln.walletFingerprint()
        } catch {
          // Still serve the quote; the missing identity blocks its later early refund.
        }
      }
      const invoiceBackendName = ln.getKnownInvoiceState ? (this.deps.backendName ?? null) : null
      const holdStarted = performance.now()
      const mint = (amountSats: number) =>
        ln.createHoldInvoice({
          // What the HTLC we HOLD is worth, which `payoutSats` is always priced
          // against — never the payout an exact-out request named.
          amountSats,
          paymentHash: request.paymentHash,
          expirySeconds: DEFAULT_HOLD_INVOICE_WINDOW,
          minFinalCltvBlocks,
        })
      // EXACT-IN MUST ASK EXACTLY THE GIVE: a client that fixed what it pays
      // cannot take a wrapping backend's reserve on top (LUD-06 requires the
      // bolt11 to equal the amount requested). So hold LESS by that reserve, and
      // price the payout off what we then HOLD rather than a give we never get.
      const rfqRef = request.rfqId?.slice(0, 12)
      let holdSats = giveSats
      if (request.amountSide !== 'to' && ln.holdForPayable) {
        try {
          holdSats = await ln.holdForPayable(giveSats)
        } catch (error) {
          log('receive_payable_unmatchable', json({ rfqRef, giveSats, error: messageOf(error) }))
          return { accepted: false, reason: 'payable_amount_unmatchable' }
        }
        // Over the give is a wrapper asking LESS than the hold it covers, so
        // holding there would fund a payout off sats nobody is asked to send.
        if (holdSats <= 0 || holdSats > giveSats) {
          log('receive_payable_unmatchable', json({ rfqRef, giveSats, holdSats }))
          return { accepted: false, reason: 'payable_amount_unmatchable' }
        }
        payoutSats = this.pricing.payoutFor({ pair: RFQ_PAIR_RECEIVE, giveSats: holdSats })
        if (payoutSats <= 0) return { accepted: false, reason: 'fee_consumes_swap' }
        if (payoutSats < (arkade.minOutputSats ?? 0)) return { accepted: false, reason: 'payout_below_dust' }
      }
      const held = await mint(holdSats)
      if (request.amountSide !== 'to' && held.payableSats !== giveSats) {
        await this.retireInvoice(request.paymentHash)
        log('receive_payable_unmatchable', json({ rfqRef, giveSats, holdSats, payableSats: held.payableSats }))
        return { accepted: false, reason: 'payable_amount_unmatchable' }
      }
      const holdMs = Math.round(performance.now() - holdStarted)

      try {
        const persistStarted = performance.now()
        const swap = await store.insertQuote({
          id: randomUUID(),
          paymentHash: request.paymentHash,
          // What the CLIENT pays, read off the invoice they are handed rather than
          // assumed to be the give: a wrapping backend adds a routing reserve. On
          // exact-in the branch above has already equalised them or refused.
          amountSats: held.payableSats,
          // Persisted, not recomputed later: once the client has paid the hold
          // invoice, the fee that priced their payout is a fact, whatever the
          // config has changed to since.
          payoutSats,
          invoice: held.invoice,
          invoiceWalletFingerprint,
          invoiceBackendName,
          invoiceExpiresAt: validUntil,
          payoutAddress: request.payoutAddress,
          payoutPkScript: hex.encode(payoutPkScript),
          payoutPubkey: request.payoutPubkey,
          claimPacket: request.claimPacket,
          refundLocktime,
          solverPubkey: arkade.solverPubkey,
          serverPubkey: arkade.serverPubkey,
          claimDelay: arkade.delays.unilateralClaimDelay,
          refundDelay: arkade.delays.unilateralRefundDelay,
          refundWithoutReceiverDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
          emulatorPubkey: arkade.emulatorPubkey,
          pkScript: hex.encode(script.pkScript),
          lockupAddress: script.address(arkade.hrp, serverKey).encode(),
          solverRefundPkScript: arkade.solverRefundPkScript,
          nonInteractiveParameters: true,
          rfqId: request.rfqId,
        })
        try {
          this.onQuoteTiming?.({
            rfqRef: request.rfqId?.slice(0, 12),
            swapId: swap.id,
            prepareMs: Math.round(holdStarted - quoteStarted),
            holdMs,
            persistMs: Math.round(performance.now() - persistStarted),
          })
        } catch {}
        this.tickOnHold(swap)
        return { accepted: true, swap, validUntil }
      } catch (error) {
        // The invoice is minted and the row did not land, so nothing downstream will
        // settle or expire it. Every unpaid invoice counts against
        // `maxpendinginvoices` (LND defaults to 1000) until its own expiry.
        //
        // NOT on `duplicate_swap`: a hold invoice is keyed BY PAYMENT HASH, so a
        // duplicate insert means another LIVE row owns this hash and its invoice is the
        // one a cancel here would close — breaking a legitimate open quote. On any
        // other failure the hash is exclusively ours and the mint is pure litter.
        if (error instanceof UniqueConstraintError) {
          return { accepted: false, reason: 'duplicate_swap' }
        }
        // `retireInvoice` swallows its own failures, so this cannot turn a
        // thrown insert into a differently-thrown one.
        await this.retireInvoice(request.paymentHash)
        throw error
      }
    } finally {
      reservation.release()
    }
  }

  /**
   * Fund on the HTLC's arrival rather than the next sweep. Never throws: the row is already persisted.
   * Quote-time only; rows recovered after a restart are not re-subscribed and the sweep drives them.
   */
  private tickOnHold(swap: ReceiveSwapRow): void {
    try {
      this.deps.ln.onHoldAccepted?.(swap.paymentHash, () => {
        void this.tick(swap.id).catch((error) => this.onTickError?.(swap.id, error))
      })
    } catch (error) {
      this.onTickError?.(swap.id, error)
    }
  }

  /** Advance one swap as far as it can go right now, and return its row. Non-blocking, same contract as the send legs' `tick`. */
  async tick(id: string): Promise<ReceiveSwapRow> {
    const { store } = this.deps
    if (this.inFlight.has(id)) return store.get(id)
    this.inFlight.add(id)
    try {
      let row = await store.get(id)
      const from = row.state
      while (true) {
        const step = row.state
        const started = this.onStepTiming && (step === 'quoted' || step === 'armed') ? performance.now() : 0
        const advanced = await this.step(row)
        if (advanced && started && (step === 'quoted' || step === 'armed')) {
          try {
            this.onStepTiming?.({
              swapId: row.id,
              rfqRef: row.rfqId?.slice(0, 12),
              step,
              ms: Math.round(performance.now() - started),
            })
          } catch {
            // Diagnostics cannot interrupt the receive tick.
          }
        }
        if (!advanced) break
        row = await store.get(id)
      }
      row = await store.get(id)
      if (row.state !== from) this.onStateChange?.(row, from)
      return row
    } finally {
      this.inFlight.delete(id)
    }
  }

  /** Fired after a tick moved a row. @see driveCoupledPeers */
  onStateChange?: (row: ReceiveSwapRow, from: ReceiveSwapRow['state']) => void

  /** Drive every non-terminal swap once. The recovery sweep and the interval loop. */
  async tickAll(): Promise<ReceiveSwapRow[]> {
    return sweep(await this.deps.store.findRecoverable(), this, this.deps.store, { inFlight: this.inFlight })
  }

  private async step(row: ReceiveSwapRow): Promise<boolean> {
    switch (row.state) {
      case 'quoted':
        return this.whenQuoted(row)
      case 'armed':
        return this.whenArmed(row)
      case 'funded':
        return this.whenFunded(row)
      case 'claimed':
        return this.whenClaimed(row)
      case 'refunding':
        return this.whenRefunding(row)
      default:
        return false
    }
  }

  private readsFor(row: ReceiveSwapRow): TickReads {
    const { ln, arkade, chainTip, coupledSendStore } = this.deps
    const deadlineOf = (locktime: number) =>
      refundDeadlineSeconds(locktime, this.now, chainTip, DEADLINE_SECONDS_PURPOSE)
    const reads: TickReads = {
      outputs: null,
      history: null,
      now: this.now,
      acceptsUnilateralGap: () => this.deps.acceptUnilateralGap,
      canRefundUnrolled: () => arkade.refundUnrolled !== undefined,
      hold: () => ln.getHoldState(row.paymentHash),
      coupledSend: async () => (await coupledSendStore?.findLiveByPaymentHash(row.paymentHash)) ?? null,
      coupledRefundDeadline: (send) => deadlineOf(send.refundLocktime),
      coupledLockupFunded: async (send) =>
        satsOutputs(await arkade.findLockups(send.pkScript)).some((o) => o.value === send.amountSats),
      earlierFunding: async () => adoptFunding(await arkade.findLockupOutpoints(row.pkScript), row.payoutSats),
      refundDeadline: () => deadlineOf(row.refundLocktime),
      spendable: async () => (reads.outputs = await arkade.findLockups(row.pkScript)),
      refundOpen: () => refundDeadlineReached(row.refundLocktime, this.now, chainTip),
      claim: async () => {
        if (row.arkadeLockupTxid === null || row.arkadeLockupVout === null) {
          throw new Error(`swap ${row.id}: no funded outpoint recorded to look for a claim of`)
        }
        // ALL historical outpoints: a row adopted out of a crashed funding may have more than one, and
        // the preimage only has to appear in one of their spends. An empty read falls back to the
        // recorded outpoint, so indexer lag never narrows the search.
        const history = await arkade.findLockupOutpoints(row.pkScript)
        reads.history = history
        const recorded = { txid: row.arkadeLockupTxid, vout: row.arkadeLockupVout }
        const preimage = await this.preimages.find(row, history.length > 0 ? history : [recorded])
        return { history, preimage: preimage ? hex.encode(preimage) : null }
      },
      // A throw keeps the row refunding, so the sweep retries a finalize arkd refused.
      ownRefund: async () => (await arkade.finalizePendingRefund?.(receiveCovenantRowFor(row))) ?? null,
      holdSettled: () =>
        ln
          .getHoldState(row.paymentHash)
          .then((state) => state.status === 'settled')
          .catch(() => false),
    }
    return reads
  }

  private async whenQuoted(row: ReceiveSwapRow): Promise<boolean> {
    const { store } = this.deps
    const next = await planReceive(row, this.readsFor(row))
    if (next.do === 'arm') {
      const armed = await store.transition(row.id, 'quoted', 'armed', { htlc_expires_at: next.htlcExpiresAt })
      if (armed) await this.noteCltvHeadroom(row, next.htlcExpiresAt)
      return armed
    }
    if (next.do === 'arm_coupled') {
      await this.retireInvoice(row.paymentHash)
      return store.transition(row.id, 'quoted', 'armed', { htlc_expires_at: null })
    }
    if (next.do === 'fail') {
      if (next.retireInvoice) await this.retireInvoice(row.paymentHash)
      await store.fail(row.id, 'quoted', next.reason)
    }
    return false
  }

  /**
   * Retire a hold invoice this corridor will never settle, if the backend can.
   *
   * Swallows every failure by design. `cancelHold` is optional on the port —
   * some backends expose no cancel at all — and this is housekeeping, not a
   * money step: the coupled flow neither reads nor needs the result. Letting a
   * cancel failure propagate would turn "the invoice stayed open" into "the
   * payout did not happen", which is strictly worse for the client and for us.
   */
  private async retireInvoice(paymentHash: string): Promise<void> {
    const { ln } = this.deps
    if (!ln.cancelHold) return
    try {
      await ln.cancelHold(paymentHash)
    } catch {
      // Intentionally ignored — see above.
    }
  }

  /**
   * #161's measurement. `spare` is taken off QUOTE time rather than the stored
   * `refund_locktime`, which may be a height whose resolution needs a chain tip and throws.
   */
  private async noteCltvHeadroom(row: ReceiveSwapRow, htlcExpiresAt: number | null): Promise<void> {
    if (htlcExpiresAt === null) return
    const spare = htlcExpiresAt - row.createdAt - (MAX_REFUND_HORIZON + SETTLE_SAFETY_MARGIN)
    try {
      await this.deps.store.noteCltvHeadroom(row.id, htlcExpiresAt - this.now(), spare)
    } catch {
      // Housekeeping, like `retireInvoice`: the row is armed either way.
    }
  }

  private async whenArmed(row: ReceiveSwapRow): Promise<boolean> {
    const { store, arkade } = this.deps
    const armedStarted = performance.now()
    const next = await planReceive(row, this.readsFor(row))
    if (next.do === 'adopt') {
      // Transition rather than wait in `armed`: `funded` already owns the
      // "learn P, or recover/refund past the deadline" obligation.
      return store.transition(row.id, 'armed', 'funded', {
        arkade_lockup_txid: next.funding.txid,
        arkade_lockup_vout: next.funding.vout,
        arkade_lockup_value: next.funding.value,
      })
    }
    if (next.do === 'stuck') {
      // `stuck`, not `refused`: a lost response may mean a lockup is out there for an operator to refund.
      await store.transition(row.id, 'armed', 'stuck', { failure_reason: next.reason })
      return false
    }
    if (next.do === 'fail') {
      await store.fail(row.id, 'armed', next.reason)
      return false
    }
    if (next.do !== 'fund') return false
    const coupled = next.coupled

    // The adoption read above closes the CRASH case; only the lease closes the
    // CONCURRENT one, where two workers both read an empty script and both spend.
    // Losing means another worker holds this swap, so yield the tick, don't fail.
    if (!(await store.claimFundLease(row.id, 'armed'))) return false

    // Nothing was funded before — create the exposure now. The txid this
    // returns is what the confirmation below keys off.
    let fundTxid: string
    const stampStarted = performance.now()
    const stamp = claimPacketStamp(row.claimPacket, covenantScriptFromRow(receiveCovenantRowFor(row)))
    const stampMs = Math.round(performance.now() - stampStarted)
    const fundStarted = performance.now()
    const preFundMs = Math.round(fundStarted - armedStarted)
    try {
      fundTxid = await arkade.fund(row.lockupAddress, row.payoutSats, stamp)
    } catch (error) {
      log(
        'receive_fund_call_timing',
        json({
          swapId: row.id,
          rfqRef: row.rfqId?.slice(0, 12),
          preFundMs,
          stampMs,
          fundMs: Math.round(performance.now() - fundStarted),
          outcome: 'failed',
        }),
      )
      // Retained on an ambiguous failure: stuck for a human, on purpose.
      if (error instanceof FundNotSubmittedError) {
        if (coupled) {
          await this.retireInvoice(row.paymentHash)
          await store.transition(row.id, 'armed', 'refused', {
            fund_started_at: null,
            failure_reason: `refused to fund coupled payout: ${error.message}`,
          })
          return false
        }
        await store.releaseFundLease(row.id)
      }
      throw error
    }
    const fundMs = Math.round(performance.now() - fundStarted)
    // Keyed to THIS row's own broadcast, and spend-aware for the same reason
    // adoption above is: a claim landing inside the poll window would empty the
    // spendable view and hide a funding that certainly happened. Matching on
    // our own txid also removes the exact-value ambiguity entirely — the only
    // path left that has to infer ownership from the value is the txid-less
    // crash recovery above.
    //
    // If the poll exhausts anyway (indexer lag beyond FUND_CONFIRM_BUDGET_MS),
    // the throw is self-healing: the next tick re-enters `whenArmed` and the
    // adoption above finds the exact-value outpoint one round-trip later.
    const exhausted = `swap ${row.id}: funded output never appeared at the indexer`
    const confirmStarted = performance.now()
    const giveUpAt = Date.now() + FUND_CONFIRM_BUDGET_MS
    const funded = await poll(
      async () => {
        // A clock, not an attempt count: at 100ms apart, a count multiplies every slow read.
        if (Date.now() >= giveUpAt) throw new GiveUp(exhausted)
        return (await arkade.findLockupOutpoints(row.pkScript)).find((o) => o.txid === fundTxid) ?? null
      },
      { attempts: Number.POSITIVE_INFINITY, intervalMs: FUND_CONFIRM_INTERVAL_MS, whenExhausted: exhausted },
    )
    const transitioned = await store.transition(row.id, 'armed', 'funded', {
      arkade_lockup_txid: funded.txid,
      arkade_lockup_vout: funded.vout,
      arkade_lockup_value: funded.value,
    })
    log(
      'receive_fund_call_timing',
      json({
        swapId: row.id,
        rfqRef: row.rfqId?.slice(0, 12),
        preFundMs,
        txRef: fundTxid.slice(0, 12),
        stampMs,
        fundMs,
        confirmMs: Math.round(performance.now() - confirmStarted),
        outcome: transitioned ? 'funded' : 'transition_lost',
      }),
    )
    return transitioned
  }

  private async whenFunded(row: ReceiveSwapRow): Promise<boolean> {
    const { store } = this.deps
    const observeStarted = performance.now()
    const next = await planReceive(row, this.readsFor(row))
    if (next.do === 'fail') {
      await store.fail(row.id, 'funded', next.reason)
      return false
    }
    if (next.do === 'start_refund') return store.transition(row.id, 'funded', 'refunding', {})
    if (next.do !== 'record_claim') return false
    const transitioned = await store.transition(row.id, 'funded', 'claimed', { preimage: next.preimage })
    log(
      'receive_claim_observe_timing',
      json({
        swapId: row.id,
        rfqRef: row.rfqId?.slice(0, 12),
        observeMs: Math.round(performance.now() - observeStarted),
        outcome: transitioned ? 'claimed' : 'transition_lost',
      }),
    )
    return transitioned
  }

  private async whenClaimed(row: ReceiveSwapRow): Promise<boolean> {
    const { store, ln } = this.deps
    const reads = this.readsFor(row)
    const next = await planReceive(row, reads)
    if (next.do === 'fail') {
      await store.fail(row.id, 'claimed', next.reason)
      return false
    }
    if (next.do === 'record_settled') return store.transition(row.id, 'claimed', 'settled', {})
    if (next.do !== 'settle' || !row.preimage) return false
    // Pre-committed BEFORE the call. `settleHold` is
    // not reversible and the CAS below it is a separate write, so a process
    // that dies in between leaves no memory that the sats were collected — and
    // the next tick calls `settleHold` again. On a backend that treats a
    // repeat as an error rather than a no-op, that error is indistinguishable
    // from a settle that never worked, and past `E` the row escalates to a
    // FALSE-NEGATIVE `stuck`: terminal, no outgoing edge, for a swap that was
    // in fact paid.
    //
    // The TLA+ model names this exactly — `LightningReceive_SettleNotIdempotent`,
    // whose expected result is GREEN because no money invariant fires: the
    // money is fine, the ROW lies. Its header asks for this column by name.
    if (row.settleAttemptedAt === null) {
      await store.patch(row.id, { settle_attempted_at: this.now() })
    }
    try {
      await ln.settleHold(row.preimage)
      return store.transition(row.id, 'claimed', 'settled', {})
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error)
      const after = await planSettleFailed(row, reads, detail)
      if (after.do === 'record_settled') return store.transition(row.id, 'claimed', 'settled', {})
      if (after.do === 'fail') {
        await store.fail(row.id, 'claimed', after.reason)
        return false
      }
      throw error
    }
  }

  private async whenRefunding(row: ReceiveSwapRow): Promise<boolean> {
    const { store, arkade } = this.deps
    const reads = this.readsFor(row)
    const next = await planReceive(row, reads)
    if (next.do === 'fail') {
      await store.fail(row.id, 'refunding', next.reason)
      return false
    }
    if (next.do === 'record_claim') {
      return store.transition(row.id, 'refunding', 'claimed', { preimage: next.preimage })
    }
    if (next.do === 'record_refund') {
      return store.transition(row.id, 'refunding', 'refunded', { refund_ark_txid: next.txid })
    }
    if (next.do === 'refund_unrolled') {
      const covenantRow = receiveCovenantRowFor(row)
      const unrolled = wasRead(reads.history, 'claim').find(
        (o) => o.unrolled && o.txid === row.arkadeLockupTxid && o.vout === row.arkadeLockupVout,
      )
      if (!unrolled || !arkade.refundUnrolled) return false
      const save = (record: UnrolledSpendRecord) => store.patch(row.id, { unrolled_refund: JSON.stringify(record) })
      const step = await arkade.refundUnrolled(covenantRow, unrolled, parseUnrolledSpend(row.unrolledRefund), save)
      return applyUnrolledSpendStep(
        store,
        row,
        { from: 'refunding', to: 'refunded' },
        step,
        row.htlcExpiresAt !== null && this.now() < row.htlcExpiresAt,
        () => unilateralExitRecourse(covenantRow, { solverPubkey: arkade.solverPubkey }),
      )
    }
    if (next.do !== 'refund') return false

    const covenantRow = receiveCovenantRowFor(row)
    const outputs = wasRead(reads.outputs, 'spendable')
    try {
      const txid = await arkade.refund(covenantRow, outputs)
      return store.transition(row.id, 'refunding', 'refunded', { refund_ark_txid: txid })
    } catch (error) {
      // The server-independent recourse goes ON THE ROW, not only in a log line: this is the row a
      // human reads days later. `unilateralExitRecourse` never throws.
      const detail = error instanceof Error ? error.message : String(error)
      const recourse = unilateralExitRecourse(covenantRow, { solverPubkey: arkade.solverPubkey })
      const after = planRefundFailed(row, this.now(), `${detail} — ${recourse}`)
      if (after.do === 'fail') {
        await store.fail(row.id, 'refunding', after.reason)
        return false
      }
      throw error
    }
  }

  /**
   * Operator override: push this row's Arkade refund now, whatever state it is in —
   * and the only path out of `stuck` on this leg. `stuck` is terminal and excluded
   * from every sweep, so this has to exist before F5's escalation is safe to add.
   *
   * WHOSE MONEY: the solver's own. This leg funds the lockup out of the float, so
   * refunding takes the solver's sats back — the opposite direction from the send
   * leg's `refundNow`, which returns the CLIENT's lockup and can therefore pay twice.
   *
   * Safer than its send-leg namesake but not unconditionally: refunding while the
   * client can still claim spends the output from under them and their held payment
   * fails back. No one loses money — both spend the SAME output, so only one confirms
   * — but a live swap is killed. Hence armed.
   *
   * Shares `whenRefunding`'s push rather than reimplementing it, so a second money path
   * cannot drift from the automatic one.
   */
  async refundNow(id: string): Promise<string | null> {
    const { store, arkade } = this.deps
    const row = await store.get(id)
    // Only where the lockup can be open and unresolved — EXPOSED or stuck. Elsewhere a refund
    // spends nothing it should, and the patch below would just restart the grace clock.
    if (!EXPOSED.includes(row.state) && row.state !== 'stuck') {
      const hint = row.state === 'armed' ? ' — let the sweep escalate a lost funding to stuck first, then refund' : ''
      throw new Error(
        `swap ${id} is ${row.state}: nothing to refund here — the solver's lockup is open only while funded/claimed/refunding or stuck${hint}`,
      )
    }
    const outputs = await arkade.findLockups(row.pkScript)
    if (outputs.length === 0) return null
    const txid = await arkade.refund(receiveCovenantRowFor(row), outputs)
    // `patch`, not `transition`: this runs from states that have no legal edge
    // to `refunded` — `stuck` above all, which is the reason it exists. The
    // audit fact is what the operator needs; the state is theirs to judge.
    await store.patch(row.id, { refund_ark_txid: txid })
    return txid
  }
}
