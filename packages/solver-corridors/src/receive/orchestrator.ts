/**
 * The receive-leg orchestrator: the one place quote/arm/fund/reveal/claim/settle
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
 * The six steps from docs/rfq-protocol.md §7.1.2, mapped onto states:
 *
 *   issue hold invoice          -> quoted
 *   wait for arm (poll)         -> armed
 *   evaluateReceiveFunding      -> (gate, at the armed->funded edge)
 *   fund the Arkade lockup      -> funded
 *   covclaimd.reveal()          -> (recorded on `funded`; idempotent, so it needs no
 *                                   state of its own to retry from)
 *   watch for the claim, settle -> claimed -> settled
 *
 * plus the failure spine: refused (no exposure), refunding / refunded (the provider's
 * own capital coming back), stuck (needs a human).
 */

import { randomUUID } from 'node:crypto'
import type { AdmissionStrategy } from '@arkade-os/solver-core/core/admissionStrategy.js'
import { ArkAddress } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import {
  evaluateReceiveFunding,
  MAX_FINAL_CLTV_BLOCKS,
  MAX_REFUND_HORIZON,
  minFinalCltvBlocksFor,
} from '@arkade-os/solver-core/core/receive.js'
import { MIN_CLAIM_WINDOW } from '@arkade-os/solver-core/core/send.js'
import type { Limits } from '@arkade-os/solver-core/core/limits.js'
import { FREE, type Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { fixedFeePricing, type PricingStrategy } from '@arkade-os/solver-core/core/pricing.js'
import { RFQ_PAIR_RECEIVE } from '../wire/lightningReceivePayloads.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { covenantScriptFromRow } from '../send/arkadeOps.js'
import type { CovenantScriptRow } from '../send/orchestrator.js'
import type { ReceiveArkadeOps } from './arkadeOps.js'
import type { CovclaimdClient } from './covclaimd.js'
import type { LightningBackend } from '@arkade-os/solver-core/ports/lightning.js'
import type { ReceiveSwapRow, ReceiveSwapStore } from '../db/receiveSwaps.js'
import type { SendSwapRow } from '../db/swaps.js'
import { nowSeconds, poll } from '@arkade-os/solver-core/util/poll.js'

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
 * How many times (1s apart) to poll the indexer for the provider's own
 * just-broadcast Arkade funding to become visible before giving up.
 *
 * Arkade funding is server-confirmed synchronously, so this absorbs indexer read-lag
 * only — not a confirmation delay.
 */
const FUND_CONFIRM_ATTEMPTS = 8
const FUND_CONFIRM_INTERVAL_MS = 1000

/**
 * How long `refunding` tolerates "the lockup is empty and no claim is readable"
 * before calling that state inexplicable and escalating to `stuck`, seconds.
 *
 * The two reads do not go true at the same instant: `findLockups` reports the lockup
 * gone the moment a claim marks the vtxo spent, while `findClaimPreimage` must also
 * fetch the spending transaction back. In the gap a COMPLETED swap reads exactly like
 * the inexplicable case.
 *
 * Read lag resolves in seconds; a genuine anomaly never does. Hence a clock rather than
 * a single observation, and minutes rather than seconds: escalating early throws a
 * completed swap into `stuck`, which is terminal, with the hold invoice unsettled.
 */
export const EMPTY_LOCKUP_GRACE = 120

/**
 * How long a refund may keep failing before the row is handed to a human —
 * TLA+ finding F5 (#38), whose `LightningReceive_Censored.cfg` reports a
 * Liveness violation for a row that retries for ever.
 *
 * Six hours has to ride out everything that resolves itself — an arkd restart, a
 * deploy, a partition, an operator asleep — because escalating into `stuck` STOPS the
 * automatic retry, and a row parked on a blip is worse than one still trying.
 *
 * Measured from entry into the refunding state, never from `refund_locktime`: a row
 * only ENTERS that state at or past its deadline, so a guard written against the
 * deadline is always true and escalates on the first failed push.
 */
export const REFUND_CENSORSHIP_GRACE = 6 * 60 * 60

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
  /**
   * How this corridor prices. Absent means the configured flat+bps `fee`,
   * which is what every deployment used before pricing became injectable.
   */
  pricing?: PricingStrategy
  store: ReceiveSwapStore
  ln: Pick<LightningBackend, 'createHoldInvoice' | 'getHoldState' | 'settleHold' | 'cancelHold'>
  arkade: ReceiveArkadeOps
  /**
   * OPTIONAL. When set, the solver hands covclaimd the sealed packet so the
   * claim can be pushed with the client offline. When absent (or null), the
   * solver simply waits for the CLIENT to claim the lockup itself — which it
   * can, holding the covenant's `receiver` key (`receiveCovenantRowFor` maps
   * `receiverPubkey: row.payoutPubkey`).
   *
   * It CAN claim this covenant as of `covclaimd:v0.0.1-rc.4`, proven on regtest by
   * `test/e2e/covclaimdClaim.e2e.test.ts`.
   *
   * Still optional for deployment reasons rather than capability: `whenFunded` does not
   * care who spent the lockup — it recovers `P` from whatever witness it finds — so
   * running without covclaimd costs only the client's need to be online.
   */
  covclaimd?: CovclaimdClient | null
  limits: Limits
  /**
   * Whether this deployment accepts funding into the #69 window — see
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
   * Reserves cap headroom for a quote whose row has not landed yet (#105).
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
  now?: () => number
}

/**
 * What this leg needs to read off a coupled SEND row before it will pay out:
 * whether their lockup is funded, where it is, and what it must hold.
 *
 * A `Pick` rather than the whole `SendSwapRow`, so this corridor depends on
 * three fields instead of the other's entire shape.
 */
export type CoupledSendRow = Pick<SendSwapRow, 'state' | 'pkScript' | 'amountSats'>

export interface ReceiveQuoteRequest {
  /** `H = sha256(P)`, client-chosen, hex. */
  paymentHash: string
  /**
   * The amount the request carries, read through `amountSide`: the client's
   * give for exact-in, the payout it wants for exact-out.
   */
  amountSats: number
  /** exact-in (default): the fee comes out of the payout. exact-out: the give is solved up from the corridor's fee. */
  amountSide?: 'from' | 'to'
  /** The client's Arkade address — where the funds land once covclaimd claims. */
  payoutAddress: string
  /** The client's own x-only key — the covenant's `receiver` role on this leg. */
  payoutPubkey: string
  /** The client's preimage, ECIES-sealed to covclaimd. Opaque here. */
  claimPacket: string
  rfqId?: string
}

export type QuoteRefusal =
  | 'amount_out_of_range'
  | 'fee_consumes_swap'
  | 'invalid_payout_address'
  | 'duplicate_swap'
  | 'provider_at_capacity'
  /**
   * `E` cannot be pushed far enough out for the solver's own unilateral
   * recourse to open before it, because the operator's exit delay is too long.
   * A property of the deployment, not of the request — every quote on this
   * corridor gets this answer until the delay comes down.
   */
  | 'recourse_window_unservable'

export type QuoteOutcome =
  { accepted: true; swap: ReceiveSwapRow; validUntil: number } | { accepted: false; reason: QuoteRefusal }

export class ReceiveSwapService {
  private readonly now: () => number
  private readonly inFlight = new Set<string>()
  private readonly fee: Fee
  /** How this corridor prices. Defaults to the configured flat+bps fee. */
  private readonly pricing: PricingStrategy

  private readonly admission: AdmissionStrategy

  constructor(private readonly deps: ReceiveServiceDeps) {
    this.admission = deps.admission
    this.now = deps.now ?? nowSeconds
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
    const payoutSats =
      request.amountSide === 'to' ? request.amountSats : this.pricing.payoutFor({ pair: RFQ_PAIR_RECEIVE, giveSats })
    if (request.amountSide !== 'to' && payoutSats <= 0) {
      return { accepted: false, reason: 'fee_consumes_swap' }
    }

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

    if (await store.findLiveByPaymentHash(request.paymentHash)) {
      return { accepted: false, reason: 'duplicate_swap' }
    }
    // The same check against the OTHER corridors' stores, BEFORE the mint
    // side effect below: a hash live anywhere else is spoken for.
    for (const peer of this.deps.peerStores ?? []) {
      if (await peer.findLiveByPaymentHash(request.paymentHash)) {
        return { accepted: false, reason: 'duplicate_swap' }
      }
    }
    // A coupling is receive-then-send, so a live send on this hash is a conflict.
    // Refuse before createHoldInvoice so a declined quote leaves no hold invoice.
    if (await this.deps.coupledSendStore?.findLiveByPaymentHash(request.paymentHash)) {
      return { accepted: false, reason: 'duplicate_swap' }
    }
    // `totalCommitted()`, not this store's own `committedSats()`: the cap is
    // the HOUSE's, so a corridor must not be able to spend it four times over.
    // Kept across the merge with main's coupled-send check above, which is a
    // different question (is this hash spoken for) about the same request.
    // RESERVED, not merely observed: the row below is what makes this swap
    // visible to `totalCommitted()`, and until it lands a concurrent quote
    // reads the same headroom and takes it too (#105). Handed back in the
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
      const refundLocktime = now + MAX_REFUND_HORIZON
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

      // `E` is chosen here, not merely inspected at funding time. The final CLTV
      // delta is the one part of the htlc's deadline that is ours to set, and it
      // has to be large enough that the solver's own unilateral recourse opens
      // before `E` — otherwise a trader can let the htlc fail back for free
      // during an arkd outage and then claim the payout anyway (#69) — unless
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
      const held = await ln.createHoldInvoice({
        // The HTLC we HOLD is worth the give — on an exact-out request that is
        // the solved-up amount, not the payout they named. It is what `payoutSats`
        // above was priced against, so it is what the backend must be asked for.
        amountSats: giveSats,
        paymentHash: request.paymentHash,
        expirySeconds: DEFAULT_HOLD_INVOICE_WINDOW,
        minFinalCltvBlocks,
      })

      try {
        const swap = await store.insertQuote({
          id: randomUUID(),
          paymentHash: request.paymentHash,
          // What the CLIENT pays, read off the invoice they are actually handed
          // rather than assumed to be the give. A backend that wraps its hold
          // invoice hands out one asking slightly more — a routing reserve for the
          // wrapper, which the payer covers — and quoting the give there would
          // hand the client a `from_amount` their own invoice contradicts.
          //
          // The two are the same number on every backend that does not wrap, and
          // `payoutSats` is unaffected either way: the reserve is the wrapper's,
          // never ours to fund against.
          amountSats: held.payableSats,
          // Persisted, not recomputed later: once the client has paid the hold
          // invoice, the fee that priced their payout is a fact, whatever the
          // config has changed to since.
          payoutSats,
          invoice: held.invoice,
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
        return { accepted: true, swap, validUntil }
      } catch (error) {
        // The invoice is minted and the row did not land, so nothing downstream will
        // settle or expire it (#99). Every unpaid invoice counts against
        // `maxpendinginvoices` (LND defaults to 1000) until its own expiry.
        //
        // NOT on `duplicate_swap`: a hold invoice is keyed BY PAYMENT HASH, so a
        // duplicate insert means another LIVE row owns this hash and its invoice is the
        // one a cancel here would close — breaking a legitimate open quote. On any
        // other failure the hash is exclusively ours and the mint is pure litter.
        if (error instanceof Error && /UNIQUE/i.test(error.message)) {
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

  /** Advance one swap as far as it can go right now, and return its row. Non-blocking, same contract as the send legs' `tick`. */
  async tick(id: string): Promise<ReceiveSwapRow> {
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
  async tickAll(): Promise<ReceiveSwapRow[]> {
    const rows: ReceiveSwapRow[] = []
    for (const row of await this.deps.store.findRecoverable()) {
      // Held off after repeated failures, or already being ticked elsewhere.
      // Neither means the swap advanced, so the row comes back unchanged and
      // `onTickSuccess` does not fire. Gated here rather than in `tick` so a
      // direct caller — an operator's recheck, a one-shot CLI tick — is never
      // throttled: only this timer is.
      if (this.shouldSkipTick?.(row.id) || this.inFlight.has(row.id)) {
        rows.push(row)
        continue
      }
      try {
        rows.push(await this.tick(row.id))
        // Ran, and did not throw: the fault is over. The host clears the
        // backoff on this rather than on membership of the returned array,
        // which also holds skipped rows and rows that threw.
        this.onTickSuccess?.(row.id)
      } catch (error) {
        this.onTickError?.(row.id, error)
        try {
          rows.push(await this.deps.store.get(row.id))
        } catch {
          // Store fault, not a swap fault — skip, the next sweep retries.
        }
      }
    }
    return rows
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

  private async whenQuoted(row: ReceiveSwapRow): Promise<boolean> {
    const { store, ln, arkade } = this.deps
    const state = await ln.getHoldState(row.paymentHash)
    // A REAL htlc always wins, and is checked first. Coupling must never
    // override one: a row funded against a send lockup while an htlc it is
    // obliged to settle is also live owes two payouts on one preimage.
    if (state.status === 'armed') {
      return store.transition(row.id, 'quoted', 'armed', { htlc_expires_at: state.expiresAt })
    }

    // Coupled: no htlc will ever arrive, because the invoice is one we minted
    // and cannot pay. We arm against the client's SEND lockup instead — but
    // only once it is funded and holds what it promised, so we never go first.
    const coupled = await this.deps.coupledSendStore?.findLiveByPaymentHash(row.paymentHash)
    if (coupled) {
      // Send lockup vs our payout. The send corridor already couples only on
      // our bolt11, so both legs price off one A and lockup ≥ A ≥ payout —
      // this is false. That gate lives in another file; this is the leg that
      // pays. Also the quote-time race: two stores, so both looks can miss and
      // a 1k send plus a 50k receive can both commit. Fail, don't stall — these
      // numbers cannot improve on a later tick.
      if (coupled.amountSats < row.payoutSats) {
        await store.fail(
          row.id,
          'quoted',
          `refused to fund: coupled send lockup of ${coupled.amountSats} sats cannot cover a ${row.payoutSats} sat payout`,
        )
        return false
      }
      if (coupled.state !== 'funded') return false
      const outputs = await arkade.findLockups(coupled.pkScript)
      // Exact value, not a minimum, for the same reason the funding guard
      // below filters exactly: a lockup a sat short is not a smaller swap, it
      // is a swap whose collect leg would not cover this payout.
      if (!outputs.some((o) => o.value === coupled.amountSats)) return false
      // The quotes are concluded and we are about to pay out, so retire the
      // invoice: from here it must never be payable.
      //
      // It is OUR bolt11, and anyone can pay a bolt11 — so a client could hand
      // it to a third party and have us settle an htlc AND claim their lockup,
      // collecting twice off one preimage. Cancelling closes that off, and it
      // is safe to do exactly here: `getHoldState` above said nothing is armed,
      // which is the only case the port makes any promise about.
      //
      // Deliberately not fatal, and deliberately not earlier. Not fatal because
      // the degradation is mild: past `quoted` this path never settles an htlc,
      // so a late one simply fails back at `E` instead of immediately — untidy,
      // not unsafe. Not earlier because until their lockup is funded the client
      // has committed to nothing, and paying this invoice the ordinary way is
      // still a legitimate thing for them to do.
      await this.retireInvoice(row.paymentHash)
      // `htlc_expires_at` stays NULL, and that null is what marks the row
      // coupled for `whenArmed` — there is no `E` on this path to record.
      return store.transition(row.id, 'quoted', 'armed', { htlc_expires_at: null })
    }

    if (this.now() >= row.invoiceExpiresAt) {
      // Retire the invoice as well as the row (#99). The row is ours and the
      // invoice is the BACKEND's: failing one does not touch the other, so
      // without this the mint outlives the quote and sits on the node until
      // ITS own expiry. LND holds every unpaid invoice against
      // `maxpendinginvoices` (default 1000) until settled, cancelled or
      // expired, so a stream of quotes nobody pays is a slow way to fill that
      // table — and none of those quotes has to be malicious to do it.
      //
      // Safe here for the reason the coupled path above gives: the row is
      // being failed, so nothing downstream will ever settle this htlc.
      await this.retireInvoice(row.paymentHash)
      await store.fail(row.id, 'quoted', 'invoice expired before it was ever armed')
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

  private async whenArmed(row: ReceiveSwapRow): Promise<boolean> {
    const { store, ln, arkade } = this.deps

    // ADOPTION RUNS FIRST, BEFORE ANY GATE. A crashed attempt may already have
    // broadcast this payment (fund() succeeded, the transition never persisted), and
    // funding again pays the same lockup twice out of the provider's pocket with only
    // ONE claim possible.
    //
    // Spend-AWARE (#97): `findLockups` is `spendableOnly`, so a first funding already
    // CLAIMED vanishes from it and the old guard read that as "not funded yet".
    // `findLockupOutpoints` reports spent outpoints too.
    //
    // The exact-value filter is load-bearing in BOTH directions: `lockupAddress` is
    // public from the moment the client holds a quote, so a stray dust payment must
    // neither be mistaken for our funding nor block this swap from funding. The value
    // is the persisted PAYOUT, never the full invoice amount.
    //
    // Ordering is deliberate: the gates below decide whether to CREATE exposure, and
    // existing exposure must be adopted regardless. Otherwise a row whose funding
    // crashed and whose invoice has since expired is failed at `armed` with capital
    // already moved and no outpoint for `whenRefunding` to act on.
    const historical = await arkade.findLockupOutpoints(row.pkScript)
    const ours = historical.filter((o) => o.value === row.payoutSats)
    // Prefer an unspent one when both exist: that is the refundable outpoint,
    // and it is the one `whenRefunding` must target. Either way `whenFunded`
    // searches ALL historical outpoints for the preimage, so recording one
    // does not lose the other.
    const alreadyFunded = ours.find((o) => !o.spent) ?? ours[0]
    if (alreadyFunded) {
      // Transition rather than wait in `armed`: `funded` already owns the
      // "learn P, or recover/refund past the deadline" obligation, whereas
      // looping in `armed` risks a later tick's gate failing a row whose
      // capital has already moved.
      return store.transition(row.id, 'armed', 'funded', {
        arkade_lockup_txid: alreadyFunded.txid,
        arkade_lockup_vout: alreadyFunded.vout,
        arkade_lockup_value: alreadyFunded.value,
      })
    }

    // Re-polled HERE, immediately before funding — not trusted from whenQuoted's
    // observation, which can be minutes stale. Only 'armed' status's E is
    // trusted; any other status (cancelled, or a backend quirk) is treated as
    // "nothing real to fund against" for this gate.
    const fresh = await ln.getHoldState(row.paymentHash)
    const htlcExpiresAt = fresh.status === 'armed' ? fresh.expiresAt : null
    // A coupled row has no `E` to bound anything against: nothing armed this
    // invoice and nothing will. `evaluateReceiveFunding`'s gates (b) and (c)
    // both measure the Arkade deadline against that `E`, so neither can be
    // asked here — their job is done at QUOTE time instead, by the send
    // corridor's `Ds >= Dr + MIN_CLAIM_WINDOW` invariant.
    //
    // Deliberately a branch here rather than a loosening of
    // `evaluateReceiveFunding`: that function is the Lightning path's money
    // gate, and it must keep failing closed on a null `E`. Note the coupling
    // is re-read rather than inferred from the null alone — a null with no
    // coupled row left (their swap was refused) must still fail closed.
    const coupled =
      htlcExpiresAt === null ? await this.deps.coupledSendStore?.findLiveByPaymentHash(row.paymentHash) : null
    if (coupled) {
      // Re-checked here as well as in `whenQuoted`, so the two sides of the
      // coupled gate stay symmetric. Today this cannot fire — the send
      // lifecycle is forward-only, so a row that reached `funded` never
      // regresses — but `whenQuoted`'s guard is what makes "their lockup is
      // really there" true, and a later state this does not expect (a `claiming`
      // row surfaced by a widened `findLiveByPaymentHash`, say) should not
      // silently inherit that guarantee.
      if (coupled.state !== 'funded') {
        await store.fail(row.id, 'armed', `refused to fund: coupled send swap is ${coupled.state}, not funded`)
        return false
      }
      // Not load-bearing: both amounts are frozen at their quotes, so
      // `whenQuoted` already settled this. Kept as a cheap last look on the
      // line before `fund` hands the payout over.
      if (coupled.amountSats < row.payoutSats) {
        await store.fail(
          row.id,
          'armed',
          `refused to fund: coupled send lockup of ${coupled.amountSats} sats cannot cover a ${row.payoutSats} sat payout`,
        )
        return false
      }
      // Gate (a) survives the bypass, because it never depended on `E`:
      // funding against an invoice that has already expired is never right.
      if (this.now() >= row.invoiceExpiresAt) {
        await store.fail(row.id, 'armed', 'refused to fund: invoice_expired')
        return false
      }
    } else {
      const decision = evaluateReceiveFunding({
        invoiceExpiresAt: row.invoiceExpiresAt,
        htlcExpiresAt,
        // The deadline the lockup script already commits to — checked here, not
        // recomputed. See the note on `refundLocktime` in `quote` above.
        refundLocktime: row.refundLocktime,
        // Read from the ROW, not from live config: the covenant was built from
        // the snapshot, so a rotated operator delay must not change what this
        // gate reasons about.
        unilateralRefundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
        // From LIVE config, deliberately unlike the delay above it. That one is
        // a covenant parameter and must match the script the money sits in; this
        // is a policy the operator holds now, and an operator who has withdrawn
        // consent should stop funding into the window on the next tick rather
        // than on the next quote.
        acceptUnilateralGap: this.deps.acceptUnilateralGap,
        now: this.now(),
      })
      if (!decision.fund) {
        await store.fail(row.id, 'armed', `refused to fund: ${decision.reason}`)
        return false
      }
    }

    // Nothing was funded before — create the exposure now. The txid this
    // returns is what the confirmation below keys off.
    const fundTxid = await arkade.fund(row.lockupAddress, row.payoutSats)
    // Keyed to THIS row's own broadcast, and spend-aware for the same reason
    // adoption above is: a claim landing inside the poll window would empty the
    // spendable view and hide a funding that certainly happened. Matching on
    // our own txid also removes the exact-value ambiguity entirely — the only
    // path left that has to infer ownership from the value is the txid-less
    // crash recovery above.
    //
    // If the poll exhausts anyway (indexer lag beyond FUND_CONFIRM_ATTEMPTS),
    // the throw is self-healing: the next tick re-enters `whenArmed` and the
    // adoption above finds the exact-value outpoint one round-trip later.
    const funded = await poll(
      async () => (await arkade.findLockupOutpoints(row.pkScript)).find((o) => o.txid === fundTxid) ?? null,
      {
        attempts: FUND_CONFIRM_ATTEMPTS,
        intervalMs: FUND_CONFIRM_INTERVAL_MS,
        whenExhausted: `swap ${row.id}: funded output never appeared at the indexer`,
      },
    )
    return store.transition(row.id, 'armed', 'funded', {
      arkade_lockup_txid: funded.txid,
      arkade_lockup_vout: funded.vout,
      arkade_lockup_value: funded.value,
    })
  }

  private async whenFunded(row: ReceiveSwapRow): Promise<boolean> {
    const { store, arkade } = this.deps
    const outputs = await arkade.findLockups(row.pkScript)

    if (outputs.length > 0) {
      // The refund-deadline check comes BEFORE the reveal attempt, not after:
      // revealToCovclaimd can throw (covclaimd unreachable), and if that check
      // ran second it would never be reached while covclaimd stays down —
      // silently defeating the whole reason SETTLE_SAFETY_MARGIN exists, which
      // is that the provider's own refund path must open regardless of
      // whether settlement is still going well. Past the deadline there is
      // also no point revealing any more: `whenRefunding`'s own recheck still
      // catches a claim that lands right at the boundary.
      if (this.now() >= row.refundLocktime) {
        return store.transition(row.id, 'funded', 'refunding', {})
      }
      // No covclaimd configured: nothing to reveal to, and nothing else to do
      // but wait for the client's own claim. The `findClaimPreimage` branch
      // below sees it exactly the same either way.
      if (row.revealedAt === null && this.deps.covclaimd) await this.revealToCovclaimd(row)
      return false
    }

    // Nothing spendable left — most likely covclaimd's claim landed.
    if (row.arkadeLockupTxid === null || row.arkadeLockupVout === null) {
      // Unreachable by construction: `funded` is only ever entered with these
      // set (whenArmed polls until it finds them). Guarded so a bad edit
      // fails loudly rather than reading null silently.
      await store.fail(row.id, 'funded', 'funded state with no funded outpoint recorded')
      return false
    }
    // ALL historical outpoints, not just the recorded one. The recorded
    // outpoint is this row's refund target, but it is not guaranteed to be the
    // one that got claimed — a row adopted out of a crashed funding attempt
    // (see `whenArmed`) may have more than one outpoint in its history, and the
    // preimage only has to appear in ONE of their spends for the swap to be
    // complete. Mirrors `receive/onchainOrchestrator.ts`'s `whenAwaitingClaim`.
    // Falls back to the recorded outpoint if the historical read comes back
    // empty, so indexer lag never narrows this to less than it was before.
    const historical = await arkade.findLockupOutpoints(row.pkScript)
    const searchable = historical.length > 0 ? historical : [{ txid: row.arkadeLockupTxid, vout: row.arkadeLockupVout }]
    const preimage = await arkade.findClaimPreimage(searchable, row.paymentHash)
    if (preimage) {
      return store.transition(row.id, 'funded', 'claimed', { preimage: hex.encode(preimage) })
    }
    // Nothing provable yet — could be ordinary read lag between findLockups
    // seeing the output gone and findClaimPreimage's own read of what spent
    // it. Keep waiting until the refund deadline; `refunding`'s own recheck
    // covers this resolving a moment later.
    if (this.now() >= row.refundLocktime) {
      return store.transition(row.id, 'funded', 'refunding', {})
    }
    return false
  }

  /** Hand the sealed claim packet to covclaimd. Only called when one is configured. Idempotent to retry — see this file's own top comment. */
  private async revealToCovclaimd(row: ReceiveSwapRow): Promise<void> {
    const { store, covclaimd } = this.deps
    if (!covclaimd) return
    const script = covenantScriptFromRow(receiveCovenantRowFor(row))
    if (!script.nonInteractiveClaimArkadeScript) {
      // Unreachable: every receive-leg row is quoted with the solver's own
      // key present, so the extended (eight-leaf) script — the one that
      // builds this leaf — is always what gets built. Guarded so a bad edit
      // fails loudly rather than silently skipping the reveal.
      throw new Error(`swap ${row.id}: covenant script has no nonInteractiveClaim leaf to reveal against`)
    }
    await covclaimd.reveal({
      swapAddress: row.lockupAddress,
      ciphertext: row.claimPacket,
      arkadeScript: base64.encode(script.nonInteractiveClaimArkadeScript),
      taptree: hex.encode(script.encode()),
    })
    await store.patch(row.id, { revealed_at: this.now() })
  }

  private async whenClaimed(row: ReceiveSwapRow): Promise<boolean> {
    const { store, ln } = this.deps
    if (!row.preimage) {
      await store.fail(row.id, 'claimed', 'claimed state with no preimage')
      return false
    }
    // NOTHING TO SETTLE ON A COUPLED SWAP. No htlc ever arrives on an invoice
    // we minted and cannot pay, and that invoice was CANCELLED when the
    // coupling was recognised. Settling is not merely pointless here, it
    // fails — `settleHodlInvoice` against a cancelled invoice errors — and the
    // handler below would then read the null `E` and fail the row, leaving
    // every completed coupled swap parked in `stuck` or `refused` with its
    // capital still counted against `maxExposedSats`.
    //
    // The coupling is RE-READ rather than inferred from the null `E` alone,
    // even though on this path the two coincide. A null `E` at `claimed` is
    // also the shape of a genuinely corrupt row, and that case must keep
    // escalating to a human below: treating it as "nothing to settle" would
    // mark a swap settled while a real held htlc went uncollected. Inferring
    // costs nothing to write and quietly widens a money gate; asking does not.
    const coupled =
      row.htlcExpiresAt === null ? await this.deps.coupledSendStore?.findLiveByPaymentHash(row.paymentHash) : null
    if (coupled) {
      return store.transition(row.id, 'claimed', 'settled', {})
    }
    // Pre-committed BEFORE the call, mirroring `revealed_at`. `settleHold` is
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
      // We have called `settleHold` before for this row, so the error may mean
      // "already settled" rather than "did not settle". Do not guess between
      // them — ASK. `getHoldState` reporting `settled` is the backend saying it
      // has been paid, which is the fact the CAS below records; anything else
      // falls through to the escalation unchanged.
      //
      // Only on a REPEAT: on the first attempt an error is just an error, and
      // reaching for the hold state there would paper over a real failure.
      if (row.settleAttemptedAt !== null) {
        const settled = await ln
          .getHoldState(row.paymentHash)
          .then((state) => state.status === 'settled')
          .catch(() => false)
        if (settled) return store.transition(row.id, 'claimed', 'settled', {})
      }
      // A null `E` that was NOT a coupling. `claimed` is otherwise only
      // reachable through an `armed` that recorded one, so this is a corrupt
      // row — and the cost of guessing is a settle that re-throws on every tick
      // with no deadline that could ever end the retry. Unchanged behaviour:
      // the coupled case returned above and never reaches here.
      if (row.htlcExpiresAt === null) {
        await store.fail(row.id, 'claimed', 'claimed state with no htlcExpiresAt recorded')
        return false
      }
      // Past E the held HTLC is gone regardless — no cancelHold exists, and
      // the backend fails a stale hold back on its own (src/ln/port.ts).
      // Nothing left here that could still succeed by retrying.
      if (this.now() >= row.htlcExpiresAt) {
        const detail = error instanceof Error ? error.message : String(error)
        await store.fail(row.id, 'claimed', `settle failing past E: ${detail}`)
        return false
      }
      throw error
    }
  }

  private async whenRefunding(row: ReceiveSwapRow): Promise<boolean> {
    const { store, arkade } = this.deps
    if (row.arkadeLockupTxid === null || row.arkadeLockupVout === null) {
      await store.fail(row.id, 'refunding', 'refunding state with no funded outpoint recorded')
      return false
    }

    // A late-but-valid claim can still land right up until this races it —
    // recheck before pushing a refund that could only ever lose that race.
    // Mirrors send/onchainOrchestrator.ts's whenRefundingOnchain.
    //
    // Over ALL historical outpoints for the same reason `whenFunded` is (see
    // there), and exactly as the onchain receive leg's `whenRefundingArkade`
    // already does: refunding a lockup whose late claim this could not see
    // because the claim landed on a sibling outpoint is the one outcome this
    // recheck exists to prevent.
    const historical = await arkade.findLockupOutpoints(row.pkScript)
    const searchable = historical.length > 0 ? historical : [{ txid: row.arkadeLockupTxid, vout: row.arkadeLockupVout }]
    const late = await arkade.findClaimPreimage(searchable, row.paymentHash)
    if (late) {
      return store.transition(row.id, 'refunding', 'claimed', { preimage: hex.encode(late) })
    }

    const outputs = await arkade.findLockups(row.pkScript)
    if (outputs.length === 0) {
      // Nothing left to refund and no claim readable either. Two very
      // different things look identical from here, and only TIME separates
      // them (see EMPTY_LOCKUP_GRACE): ordinary lag between these two reads,
      // which resolves in seconds, or a state outside this service's own
      // explanation (a key compromise, or a claim landing in a shape
      // findClaimPreimage cannot recognize), which never resolves.
      //
      // So wait it out before judging. `updatedAt` is the moment this row
      // entered `refunding` — nothing on this path patches the row, so it
      // does not move while we wait — and the `late` recheck at the top of
      // this method runs again on every tick, which is what actually recovers
      // the swap once the spending transaction becomes readable.
      if (this.now() - row.updatedAt < EMPTY_LOCKUP_GRACE) return false
      // Still nothing, long past any read lag. A human needs to look, same
      // posture the onchain leg takes for its own ambiguous-witness case.
      await store.fail(row.id, 'refunding', 'lockup empty during refunding with no matching claim found; needs review')
      return false
    }

    try {
      const txid = await arkade.refund(receiveCovenantRowFor(row), outputs)
      return store.transition(row.id, 'refunding', 'refunded', { refund_ark_txid: txid })
    } catch (error) {
      // TLA+ F5 (#38): the Arkade server stops co-signing and nothing ever gives up.
      //
      // MEASURED FROM ENTRY INTO `refunding`, not from `refundLocktime`: `whenFunded`
      // only moves a row here at or past its deadline, so `now >= refundLocktime` is
      // always true and a guard written that way escalates on the FIRST failed push,
      // parking a healthy row on a momentary arkd blip. `updatedAt` is the moment the
      // row entered `refunding` and nothing on this path patches it.
      //
      // Past the grace a still-failing refund is a real fault, and `receive-refund-now`
      // gives a human somewhere to go — which is what makes escalating safe at all.
      if (this.now() - row.updatedAt >= REFUND_CENSORSHIP_GRACE) {
        const detail = error instanceof Error ? error.message : String(error)
        await store.fail(row.id, 'refunding', `refund failing past the refund deadline: ${detail}`)
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
