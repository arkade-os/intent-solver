/**
 * The onchain-receive orchestrator: quote/watch/fund/claim, driven the same
 * way `src/send/onchainOrchestrator.ts` drives the send leg — the row is the
 * truth, every step commits intent before the irreversible side effect, and
 * `tick` is safe to call from any number of concurrent callers.
 *
 * The 6-step flow (design doc's "Receive flow", rfq-protocol.md §7.1.4):
 *
 *  1. client seals `P` into a `ClaimPacket`, requests a quote
 *  2. solver quotes its own onchain claim key, `min_confirmations`, and its
 *     own Arkade-side refund deadline
 *  3. client derives the onchain HTLC locally, funds it
 *  4. solver watches for `min_confirmations`, then funds the Arkade lockup
 *     pinned to the client's payout script
 *  5. the lockup is claimed and `P` becomes public — by the CLIENT through
 *     the collaborative claim leaf, or by covclaimd through
 *     `nonInteractiveClaim` if one is configured (see `deps.covclaimd`)
 *  6. solver uses the now-public `P` to claim the onchain HTLC
 *
 * Role reversal from the send leg: there the CLIENT funds Arkade and the SOLVER funds
 * onchain; here it is the other way round.
 *
 * The Arkade covenant is IDENTICAL to the Lightning receive leg's, field for field
 * (`receiveCovenantRowFor` below), because both corridors are the same swap on the
 * Arkade side — the solver funds, the client is the beneficiary and generated `P`. So
 * the CLIENT holds `receiver` and the SOLVER holds `client`/sender, which is what lets
 * the client claim without covclaimd.
 */

import { hex, base64 } from '@scure/base'
import type { AdmissionStrategy } from '@arkade-os/solver-core/core/admissionStrategy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ArkAddress } from '@arkade-os/sdk'
import {
  DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT,
  ONCHAIN_DUST_SATS,
  evaluateOnchainReceiveAcceptance,
  evaluateOnchainReceiveFunding,
  type OnchainReceiveAcceptanceRefusal,
} from '@arkade-os/solver-core/core/onchainReceive.js'
import type { Limits } from '@arkade-os/solver-core/core/limits.js'
import { FREE, type Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { fixedFeePricing, type PricingStrategy } from '@arkade-os/solver-core/core/pricing.js'
import { RFQ_PAIR_ONCHAIN_RECEIVE } from '../wire/onchainReceivePayloads.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { covenantScriptFromRow } from '../send/arkadeOps.js'
import type { CovenantScriptRow } from '../send/orchestrator.js'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { buildOnchainClaimTx, estimateClaimTxVsize, signOnchainClaimTx } from '@arkade-os/solver-rails/onchain/claim.js'
import type { OnchainSigner } from '@arkade-os/solver-rails/onchain/refund.js'
import type { OnchainReceiveBackend } from '@arkade-os/solver-core/ports/onchain.js'
import type { OnchainReceiveArkadeOps } from './onchainArkadeOps.js'
import { EMPTY_LOCKUP_GRACE, REFUND_CENSORSHIP_GRACE } from './orchestrator.js'
import type { OnchainReceiveSwapRow, OnchainReceiveSwapStore } from '../db/onchainReceiveSwaps.js'
import type { CovclaimdClient } from './covclaimd.js'
import type { SwapNetwork } from '@arkade-os/solver-core/core/networks.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'

export interface OnchainReceiveServiceDeps {
  /**
   * How this corridor prices. Absent means the configured flat+bps `fee`,
   * which is what every deployment used before pricing became injectable.
   */
  pricing?: PricingStrategy
  store: OnchainReceiveSwapStore
  onchain: OnchainReceiveBackend
  arkade: OnchainReceiveArkadeOps
  /**
   * OPTIONAL. When set, the solver hands covclaimd the sealed packet so the
   * claim can be pushed with the client offline. When absent (or null), the
   * solver simply waits for the CLIENT to claim the lockup itself — which it
   * can, holding the covenant's `receiver` key.
   *
   * Optional because covclaimd is not a dependency this corridor can rely on
   * today: `covclaimd:v0.0.1-rc.1` accepts a reveal (HTTP 200) against this
   * covenant and then silently never claims, observed on regtest 2026-08-07.
   * The watch path below does not care who spent the lockup — it recovers `P`
   * from whatever witness it finds — so "no covclaimd" costs only the
   * client's need to be online, not correctness.
   */
  covclaimd?: Pick<CovclaimdClient, 'reveal'> | null
  limits: Limits
  network: SwapNetwork
  maxExposedSats: number
  /** Sum of committed sats across every corridor, not just this notebook. */
  totalCommitted: () => Promise<number>
  /**
   * Reserves cap headroom for a quote whose row has not landed yet (#105).
   * SHARE one instance across every corridor: a per-corridor control bounds
   * only its own concurrency, which is the narrower half of the problem.
   */
  admission: AdmissionStrategy
  /** Signs the solver's own onchain claim spend — matches `ArkadeContext.identity`'s shape exactly. */
  signer: OnchainSigner
  /** Where the solver's own claimed onchain sats go. A P2TR pkScript the solver controls. */
  claimDestinationScript: Uint8Array
  /**
   * What this corridor charges. The client funds the onchain HTLC in full;
   * the solver funds the Arkade lockup with the amount MINUS the fee,
   * persisted on the row as `payoutSats` at quote time. Omitted means free,
   * which is what it charged before fees existed.
   */
  fee?: Fee
  /**
   * The OTHER corridors' stores, consulted for the duplicate-hash check. A
   * hash live in ANY corridor's store is spoken for — see the send
   * orchestrator's own `peerStores` for the self-payment blind spot this
   * closes.
   */
  peerStores?: readonly { findLiveByPaymentHash(paymentHash: string): Promise<unknown> }[]
  now?: () => number
}

export type QuoteRefusal =
  | OnchainReceiveAcceptanceRefusal
  | 'fee_consumes_swap'
  | 'payout_below_dust'
  | 'duplicate_swap'
  | 'provider_at_capacity'
  | 'invalid_payout_address'

export type QuoteOutcome =
  { accepted: true; swap: OnchainReceiveSwapRow; lockupDeadline: number } | { accepted: false; reason: QuoteRefusal }

export interface OnchainReceiveQuoteRequest {
  /** `sha256(P)`, hex (64 chars) — client-chosen. Same wire field as `payment_hash`. */
  paymentHash: string
  /**
   * The amount the request carries, read through `amountSide`: the client's
   * give (what they fund the onchain HTLC with) for exact-in, the payout
   * (what lands in the Arkade lockup) for exact-out.
   */
  amountSats: number
  /** exact-in (default): the fee comes out of the payout. exact-out: the give is solved up from the corridor's fee. */
  amountSide?: 'from' | 'to'
  /** `P` ECIES-sealed to covclaimd, base64 — carried blindly, never decrypted here. */
  claimPacket: string
  /** The client's x-only pubkey for the onchain HTLC's refund leaf. Wire field `refund_pubkey`. */
  refundPubkey: string
  /** The client's Arkade payout address — where a claim must pay. Wire field `payout_address`. */
  payoutAddress: string
  /**
   * The client's own Arkade x-only key — the covenant's `receiver` role, so
   * the client can spend the collaborative claim leaf itself rather than
   * depending on covclaimd. Wire field `payout_pubkey`. Same field, same
   * meaning, same name as the Lightning receive leg's.
   */
  payoutPubkey: string
  minConfirmations?: number
  rfqId?: string
}

/** `sha256(P)`, hex — same wire-form comparison `row.paymentHash` already uses. */
const paymentHashOf = (preimage: Uint8Array): string => hex.encode(sha256(preimage))

/**
 * Maps the receive row's fields onto the shape `covenantScriptFromRow` needs.
 *
 * IDENTICAL to `receive/orchestrator.ts`'s `receiveCovenantRowFor`, field for
 * field, and that is the point: both receive corridors are the same swap on
 * the Arkade side — the solver funds the lockup, the client is the
 * beneficiary, the client generated `P` — so they carry the same covenant.
 * Only the other leg differs (a hold invoice there, an L1 HTLC here), and
 * nothing about that justifies a different covenant.
 *
 * The CLIENT plays `receiver`: it holds `clientPayoutPubkey` and can therefore
 * spend the collaborative `claim` leaf (`preimage + receiver + server`)
 * itself. The SOLVER plays `client` (VHTLC "sender"): it funded the lockup, so
 * it is the one needing refund recourse.
 *
 * Client-as-`receiver` needs no unilateral-exit machinery: the `claim` leaf is
 * collaborative (no CSV, arkd co-signs), and the offline case is covered by
 * `nonInteractiveClaim`, signed by server+emulator alone and unaffected by who holds
 * `receiver`'s key.
 *
 * Exported for the watch loop's lockup-registration pass
 * (`arkade/vtxoLifecycle.ts`'s `liveLockupRows`), and aliased at that import site
 * because `receive/orchestrator.ts` exports a same-named function for the OTHER
 * receive corridor.
 */
export const receiveCovenantRowFor = (row: OnchainReceiveSwapRow): CovenantScriptRow => ({
  id: row.id,
  receiverPubkey: row.clientPayoutPubkey,
  serverPubkey: row.serverPubkey,
  paymentHash: row.paymentHash,
  refundLocktime: row.refundLocktime,
  claimDelay: row.claimDelay,
  emulatorPubkey: row.emulatorPubkey,
  refundPkScript: row.refundPkScript,
  pkScript: row.pkScript,
  clientRefundPubkey: row.providerPubkey,
  refundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
  refundDelay: row.refundDelay,
  receiverPkScript: row.clientPayoutPkScript,
  nonInteractiveParameters: row.nonInteractiveParameters,
})

export class OnchainReceiveSwapService {
  private readonly now: () => number
  private readonly inFlight = new Set<string>()
  private readonly fee: Fee
  /** How this corridor prices. Defaults to the configured flat+bps fee. */
  private readonly pricing: PricingStrategy

  private readonly admission: AdmissionStrategy

  constructor(private readonly deps: OnchainReceiveServiceDeps) {
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

  async quote(request: OnchainReceiveQuoteRequest): Promise<QuoteOutcome> {
    const { store, arkade, limits, network } = this.deps

    let clientPayoutPkScript: Uint8Array
    let clientPayoutPubkey: Uint8Array
    try {
      const address = ArkAddress.decode(request.payoutAddress)
      clientPayoutPkScript = address.pkScript
      if (!request.payoutAddress.toLowerCase().startsWith(`${arkade.hrp}1`)) {
        return { accepted: false, reason: 'invalid_payout_address' }
      }
      // Refused rather than allowed to throw: a malformed key here would
      // otherwise surface as an exception out of quote() where every other
      // bad client input is a clean refusal.
      clientPayoutPubkey = hex.decode(request.payoutPubkey)
      if (clientPayoutPubkey.length !== 32) return { accepted: false, reason: 'invalid_payout_address' }
    } catch {
      return { accepted: false, reason: 'invalid_payout_address' }
    }

    // exact-in: the client names what it GIVES. exact-out: it names what it
    // RECEIVES, and the give is solved up from the corridor's fee — the
    // payout is then the request by construction (`giveSatsFor`), which is
    // why `fee_consumes_swap` cannot fire on this side. The acceptance
    // bounds and the exposure cap both deal in the GIVE.
    const giveSats =
      request.amountSide === 'to'
        ? this.pricing.giveFor({ pair: RFQ_PAIR_ONCHAIN_RECEIVE, payoutSats: request.amountSats })
        : request.amountSats
    const acceptance = evaluateOnchainReceiveAcceptance({
      amountSats: giveSats,
      limits,
      now: this.now(),
      minConfirmations: request.minConfirmations,
    })
    if (!acceptance.accept) return { accepted: false, reason: acceptance.reason }

    // The client funds the onchain HTLC with the full give; the solver funds
    // the Arkade lockup with the give MINUS this corridor's fee.
    // `payoutSatsFor` deliberately does not clamp (see corridorPolicy.ts): a
    // payout at or below zero is "the fee ate the swap", refused by its own
    // name rather than folded into `amount_out_of_range` — the amount was
    // inside the range, it just cannot be priced. A payout below the dust
    // floor would have the solver fund a lockup worth less than an
    // unspendable output — the onchain legs' own floor, refused on BOTH
    // sides: a sub-dust payout is unfundable however the request named it.
    const payoutSats =
      request.amountSide === 'to'
        ? request.amountSats
        : this.pricing.payoutFor({ pair: RFQ_PAIR_ONCHAIN_RECEIVE, giveSats })
    if (request.amountSide !== 'to' && payoutSats <= 0) {
      return { accepted: false, reason: 'fee_consumes_swap' }
    }
    if (payoutSats < ONCHAIN_DUST_SATS) {
      return { accepted: false, reason: 'payout_below_dust' }
    }

    if (await store.findLiveByPaymentHash(request.paymentHash)) {
      return { accepted: false, reason: 'duplicate_swap' }
    }
    // The same check against the OTHER corridors' stores: a hash that is live
    // in ANY of them is spoken for.
    for (const peer of this.deps.peerStores ?? []) {
      if (await peer.findLiveByPaymentHash(request.paymentHash)) {
        return { accepted: false, reason: 'duplicate_swap' }
      }
    }
    // RESERVED, not merely observed: the row below is what makes this swap
    // visible to `totalCommitted()`, and until it lands a concurrent quote
    // reads the same headroom and takes it too (#105). Handed back in the
    // `finally`, by which point either the row counts instead or nothing
    // was committed at all.
    const reservation = await this.admission.admit({
      pair: RFQ_PAIR_ONCHAIN_RECEIVE,
      giveSats: giveSats,
      capSats: this.deps.maxExposedSats,
      committedSats: this.deps.totalCommitted,
    })
    if (reservation === null) {
      return { accepted: false, reason: 'provider_at_capacity' }
    }
    try {
      const serverKey = hex.decode(arkade.serverPubkey)
      const providerKey = hex.decode(arkade.providerPubkey)
      // The CLIENT is `receiver` and the SOLVER is `client` — the same mapping
      // the Lightning receive leg uses, for the same reasons. See
      // `receiveCovenantRowFor` above; the reconstruction there and this
      // construction must agree field for field or `assertScriptMatchesRow`
      // refuses every later spend.
      const arkadeScript = new CovenantSwapScript({
        receiver: clientPayoutPubkey,
        server: serverKey,
        preimageHash: scriptHashFromPaymentHash(request.paymentHash),
        refundLocktime: acceptance.arkadeRefundLocktime,
        claimDelay: arkade.delays.unilateralClaimDelay,
        client: providerKey,
        clientRefundDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
        refundWithoutServerDelay: arkade.delays.unilateralRefundDelay,
        // Every quote from here on carries the current, full covenant suite.
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(arkade.emulatorPubkey),
          // The CLIENT's own Arkade destination — the one place client identity
          // enters this covenant, pinned into nonInteractiveClaim.
          receiverPkScript: clientPayoutPkScript,
          // The SOLVER's own Arkade destination — where nonInteractiveRefund
          // pays if covclaimd never claims in time.
          senderPkScript: hex.decode(arkade.receiverPkScript),
        },
      })

      // acceptance.htlcLocktime is ALREADY an absolute unix-seconds CLTV
      // (core/onchainReceive.ts's htlcLocktimeFor) — no block-height/chain-tip
      // conversion needed anywhere in this flow.
      const claimPubkey = arkade.providerPubkey
      const onchainHtlc = buildOnchainHtlc({
        network: ONCHAIN_NETWORKS[network],
        paymentHash: request.paymentHash,
        claimPubkey: hex.decode(claimPubkey),
        refundPubkey: hex.decode(request.refundPubkey),
        refundLocktime: acceptance.htlcLocktime,
      })

      try {
        const swap = await store.insertQuote({
          id: crypto.randomUUID(),
          paymentHash: request.paymentHash,
          amountSats: giveSats,
          // Persisted, not recomputed later: once the client has funded their
          // HTLC, the fee that priced their payout is a fact, whatever the
          // config has changed to since.
          payoutSats,
          htlcLocktime: acceptance.htlcLocktime,
          refundLocktime: acceptance.arkadeRefundLocktime,
          minConfirmations: acceptance.minConfirmations,
          providerPubkey: arkade.providerPubkey,
          clientPayoutPubkey: request.payoutPubkey,
          serverPubkey: arkade.serverPubkey,
          claimDelay: arkade.delays.unilateralClaimDelay,
          refundDelay: arkade.delays.unilateralRefundDelay,
          refundWithoutReceiverDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
          emulatorPubkey: arkade.emulatorPubkey,
          pkScript: hex.encode(arkadeScript.pkScript),
          lockupAddress: arkadeScript.address(arkade.hrp, serverKey).encode(),
          refundPkScript: arkade.receiverPkScript,
          clientPayoutPkScript: hex.encode(clientPayoutPkScript),
          nonInteractiveParameters: true,
          htlcPubkey: claimPubkey,
          clientOnchainRefundPubkey: request.refundPubkey,
          onchainAddress: onchainHtlc.address,
          onchainPkScript: hex.encode(onchainHtlc.pkScript),
          claimPacket: request.claimPacket,
          rfqId: request.rfqId,
        })
        return { accepted: true, swap, lockupDeadline: this.now() + DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT }
      } catch (error) {
        if (error instanceof Error && /UNIQUE/i.test(error.message)) {
          return { accepted: false, reason: 'duplicate_swap' }
        }
        throw error
      }
    } finally {
      reservation.release()
    }
  }

  async tick(id: string): Promise<OnchainReceiveSwapRow> {
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

  async tickAll(): Promise<OnchainReceiveSwapRow[]> {
    const rows: OnchainReceiveSwapRow[] = []
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

  private async step(row: OnchainReceiveSwapRow): Promise<boolean> {
    switch (row.state) {
      case 'quoted':
        return this.whenQuoted(row)
      case 'awaiting_confirmations':
        return this.whenAwaitingConfirmations(row)
      case 'funding_arkade':
        return this.whenFundingArkade(row)
      case 'awaiting_claim':
        return this.whenAwaitingClaim(row)
      case 'claimed':
        return this.whenClaimed(row)
      case 'refunding_arkade':
        return this.whenRefundingArkade(row)
      default:
        return false
    }
  }

  /**
   * Watch the CLIENT's onchain HTLC address for their funding output.
   *
   * Single-output, exact-amount match only, unlike the Arkade-side lockup watching that
   * sums every output: a client funding their own HTLC has no reason to split it, and
   * `onchain/claim.ts` spends a single input. The exactness is for safety — adopting a
   * partial or dust payment as "the client funded it" would carry the swap into
   * Arkade-funding for the FULL amount against an HTLC holding a fraction of it.
   *
   * A mismatch that has CONFIRMED is refused on the spot rather than left to the lockup
   * timeout. Re-quoting to the amount actually funded would also be sound — the HTLC
   * script commits to a hash and a locktime, not an amount — but it changes what the
   * client gets paid after they have funded, and no client can currently be told.
   */
  private async whenQuoted(row: OnchainReceiveSwapRow): Promise<boolean> {
    const { store, onchain } = this.deps
    const outputs = await onchain.findOutputs({ address: row.onchainAddress })
    const match = outputs.find((o) => o.valueSats === row.amountSats)
    const timedOut = this.now() >= row.createdAt + DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT

    if (match) {
      return store.transition(row.id, 'quoted', 'awaiting_confirmations', {
        funding_txid: match.txid,
        funding_vout: match.vout,
      })
    }

    // Funded, but for the wrong amount, and CONFIRMED so it cannot become the
    // right one. Refuse now instead of sitting on it until the lockup timeout.
    //
    // Confirmed is the whole condition. An unconfirmed mismatch is not yet
    // anything: it can be replaced by fee-bump, or be the first of two sends
    // the client is still making. A confirmed one can be neither — and a second
    // output cannot rescue it either, because the exact-match rule above wants
    // ONE output and `onchain/claim.ts` spends one input.
    //
    // Nothing of the solver's is at risk here (`quoted` is not in EXPOSED), so
    // this buys the client time rather than saving the solver money: their sats
    // sit in their own HTLC behind their own CLTV, and the sooner they know
    // this swap is dead the sooner they can start reclaiming. Waiting for the
    // timeout told them the same thing, later, for no reason.
    const confirmedMismatch = outputs.find((o) => o.confirmations > 0)
    if (confirmedMismatch) {
      await store.fail(
        row.id,
        'quoted',
        `funding mismatch: ${confirmedMismatch.txid}:${confirmedMismatch.vout} holds ${confirmedMismatch.valueSats} sats, quote is for ${row.amountSats}`,
      )
      return false
    }

    if (timedOut) {
      await store.fail(row.id, 'quoted', 'lockup timeout')
    }
    return false
  }

  /**
   * Wait for `min_confirmations` on the client's already-observed funding
   * output, then hand off to funding the Arkade side.
   *
   * Gated the same way immediately BEFORE the hand-off as `evaluateOnchainReceiveFunding`
   * is documented to require — not only once, at the moment confirmations
   * are first reached, but also while STILL waiting: a swap that can never
   * reach `min_confirmations` before its own Arkade refund deadline would
   * otherwise sit here forever instead of failing cleanly. Nothing of the
   * solver's own is at risk in this state either way (`EXPOSED` starts at
   * `funding_arkade`), so failing here is always safe.
   */
  private async whenAwaitingConfirmations(row: OnchainReceiveSwapRow): Promise<boolean> {
    const { store, onchain } = this.deps
    if (!row.fundingTxid || row.fundingVout === null) {
      await store.fail(row.id, 'awaiting_confirmations', 'awaiting_confirmations state with no funding txid/vout')
      return false
    }
    const outputs = await onchain.findOutputs({ address: row.onchainAddress })
    const output = outputs.find((o) => o.txid === row.fundingTxid && o.vout === row.fundingVout)
    const confirmed = (output?.confirmations ?? 0) >= row.minConfirmations

    const decision = evaluateOnchainReceiveFunding({
      arkadeRefundLocktime: row.refundLocktime,
      htlcLocktime: row.htlcLocktime,
      // From the ROW: the covenant was built from this snapshot, so a rotated
      // operator delay must not change what the gate reasons about.
      unilateralRefundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
      now: this.now(),
    })
    if (!confirmed) {
      if (!decision.fund) {
        await store.fail(row.id, 'awaiting_confirmations', `confirmations not reached in time: ${decision.reason}`)
      }
      return false
    }
    if (!decision.fund) {
      await store.fail(row.id, 'awaiting_confirmations', decision.reason)
      return false
    }
    return store.transition(row.id, 'awaiting_confirmations', 'funding_arkade', {})
  }

  /**
   * Fund the Arkade lockup out of the solver's own wallet.
   *
   * Recovery path mirrors `send/onchainOrchestrator.ts`'s `recoverFunding`:
   * `IWallet.send` carries no idempotency key, so a blind resubmit after a
   * crash between broadcast and this transition recording it would fund the
   * Arkade lockup a SECOND time out of the solver's own pocket. Asking
   * `findLockups` what already landed at this swap's own (unique) script —
   * the same source of truth `whenQuoted` (send and receive) and
   * `pushRefund` already trust — closes that gap without needing a
   * persisted "did we already call fund" flag.
   */
  private async whenFundingArkade(row: OnchainReceiveSwapRow): Promise<boolean> {
    const { store, arkade } = this.deps
    // The lockup carries the PAYOUT — the client's HTLC amount minus this
    // corridor's fee, persisted at quote time — never the full `amountSats`.
    const existing = await arkade.findLockups(row.pkScript)
    const alreadyFunded = existing.reduce((sum, o) => sum + o.value, 0) >= row.payoutSats
    if (alreadyFunded) {
      return store.transition(row.id, 'funding_arkade', 'awaiting_claim', {})
    }
    // Re-checked here, immediately before the pay, and NOT before the adoption
    // above. The gate decides whether to CREATE exposure; exposure that already
    // exists must be adopted whatever the gate now says, or a row whose window
    // closed while it sat here would be failed with the solver's sats already
    // in the lockup and no path recording them.
    //
    // It is re-checked at all because `whenAwaitingConfirmations` evaluated it
    // against ITS `now`, and a row can sit in `funding_arkade` across a restart
    // or a failed tick. `now` only moves forward, so a window that was open at
    // the hand-off can be shut by the time the payment is actually made — and
    // funding then is precisely the trade #69 describes, where the trader lets
    // the onchain htlc time out and still claims the Arkade payout.
    const decision = evaluateOnchainReceiveFunding({
      arkadeRefundLocktime: row.refundLocktime,
      htlcLocktime: row.htlcLocktime,
      // From the ROW, for the same reason the hand-off reads it from the row:
      // the covenant was built from this snapshot.
      unilateralRefundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
      now: this.now(),
    })
    if (!decision.fund) {
      await store.fail(row.id, 'funding_arkade', decision.reason)
      return false
    }
    // The exclusive right to pay, taken BEFORE paying. The adoption check above
    // closes the crash case; this closes the concurrent one, which it cannot:
    // two workers in the same window both read an empty script — the first
    // one's payment has not landed yet, which is why the second is still
    // running — and coin selection is per-process, so both succeed against
    // different vtxos and leave two lockups where the swap needs one. The
    // compare-and-swap on `state` below gates RECORDING, not spending.
    //
    // Losing is not a failure: another worker holds this swap, so yield the
    // tick rather than fail the row.
    if (!(await store.claimFundLease(row.id, 'funding_arkade'))) return false

    let txid: string
    try {
      txid = await arkade.fund({ address: row.lockupAddress, amountSats: row.payoutSats })
    } catch (error) {
      // Hand the lease back on a throw: no money this service can see has
      // moved, and holding it would strand the row for every worker rather
      // than just this one. The adoption check above already owns the
      // ambiguity a throw leaves, and resolves it by reading the script.
      await store.releaseFundLease(row.id)
      throw error
    }
    return store.transition(row.id, 'funding_arkade', 'awaiting_claim', { arkade_fund_txid: txid })
  }

  /**
   * Wait for the claim to land, and — when covclaimd is configured — (re)ask
   * it to push one on every tick it hasn't.
   *
   * WHO claims is not this method's business. It looks for a spend of the
   * lockup and recovers `P` from its witness; the collaborative `claim` leaf
   * the CLIENT spends and the `nonInteractiveClaim` leaf covclaimd spends both
   * reveal the same preimage, and `findClaimPreimage` verifies whatever it
   * finds against the payment hash before trusting it. So with no covclaimd
   * this loop is simply a wait for the client, and nothing else changes.
   *
   * Calling `reveal()` repeatedly is deliberate, not an oversight: there is no
   * separate "did we already ask" flag to maintain — covclaimd's own claim
   * is idempotent against an already-spent lockup, so a repeat ask costs
   * nothing on a lockup that's already claimed, and is exactly what recovers
   * a transient covclaimd outage without a separate retry mechanism. A
   * failure from `reveal()` itself is a transient fault and is left to
   * throw, same as every other transient fault in this orchestrator —
   * `tickAll`'s `onTickError` catches it per-row and the next sweep retries.
   */
  private async whenAwaitingClaim(row: OnchainReceiveSwapRow): Promise<boolean> {
    const { store, arkade, covclaimd } = this.deps
    // Ask the outpoints this lockup ever held — spent ones included, which is
    // the whole point: by the time covclaimd's claim is worth reading, the
    // output it spent is gone from any spendable-only view.
    const outpoints = await arkade.findLockupOutpoints(row.pkScript)
    const preimage = outpoints.length > 0 ? await arkade.findClaimPreimage(outpoints, row.paymentHash) : null
    if (preimage) {
      return store.transition(row.id, 'awaiting_claim', 'claimed', { preimage: hex.encode(preimage) })
    }
    // A null here is deliberately NOT read as "spent by something else, give
    // up": it also covers not-spent-yet and ordinary indexer read lag between
    // the spend landing and the spending transaction becoming readable. The
    // refund-deadline backstop below is what ends the wait, exactly as the
    // Lightning receive leg's `whenFunded` handles the identical race —
    // failing fast here would turn a claim observed a moment late into a
    // stuck swap.

    if (covclaimd) {
      const script = covenantScriptFromRow(receiveCovenantRowFor(row))
      if (!script.nonInteractiveClaimArkadeScript) {
        // Unreachable by construction: every row on this leg is quoted with a
        // client key present (`quote()` always builds the extended script),
        // so the nonInteractiveClaim leaf always exists.
        await store.fail(row.id, 'awaiting_claim', 'covenant script has no nonInteractiveClaim leaf to reveal against')
        return false
      }
      await covclaimd.reveal({
        swapAddress: row.lockupAddress,
        ciphertext: row.claimPacket,
        arkadeScript: base64.encode(script.nonInteractiveClaimArkadeScript),
        taptree: hex.encode(script.encode()),
      })
    }

    // Deadline backstop: reuses the SAME headroom check that gates funding
    // the Arkade lockup in the first place — "is there still enough time
    // before our own refund path" is exactly the question here too, just
    // asked AFTER funding instead of before it.
    const decision = evaluateOnchainReceiveFunding({
      arkadeRefundLocktime: row.refundLocktime,
      htlcLocktime: row.htlcLocktime,
      // From the ROW: the covenant was built from this snapshot, so a rotated
      // operator delay must not change what the gate reasons about.
      unilateralRefundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
      now: this.now(),
    })
    if (!decision.fund) {
      return store.transition(row.id, 'awaiting_claim', 'refunding_arkade', {})
    }
    return false
  }

  /**
   * `P` is known — claim the onchain HTLC the client funded, using it.
   *
   * Checks for a PRE-EXISTING spend before broadcasting, same defensive
   * posture `send/onchainOrchestrator.ts`'s `whenRefundingOnchain` takes
   * before racing its own broadcast. Nobody but the solver holds the onchain
   * claim key, so the only thing that could already be there is the
   * CLIENT's own refund — reachable only in the pathological case of
   * claiming this late despite every margin this leg's timelocks build in.
   * If it happens anyway, the client has recovered their onchain funds AND
   * (if covclaimd's claim already landed) their Arkade payout — exactly the
   * double-loss-for-the-solver scenario the timelock-ordering invariant
   * exists to prevent — so this routes to a human rather than attempting a
   * broadcast that could never confirm.
   */
  private async whenClaimed(row: OnchainReceiveSwapRow): Promise<boolean> {
    const { store, onchain, signer, network, claimDestinationScript } = this.deps
    if (!row.preimage) {
      await store.fail(row.id, 'claimed', 'claimed state with no preimage')
      return false
    }
    if (!row.fundingTxid || row.fundingVout === null) {
      await store.fail(row.id, 'claimed', 'claimed state with no funding txid/vout')
      return false
    }
    // A BROADCAST CLAIM IS NOT A LANDED ONE, and `settled` is terminal (#204).
    if (row.onchainClaimTxid) {
      const outcome = await onchain.transactionOutcome(row.onchainClaimTxid)
      if (outcome === 'confirmed') return store.transition(row.id, 'claimed', 'settled', {})
      if (outcome === 'mempool') return false
    }
    const priorSpend = await onchain.findSpendWitness({
      txid: row.fundingTxid,
      vout: row.fundingVout,
      outputScript: hex.decode(row.onchainPkScript),
    })
    if (priorSpend) {
      // WHOSE spend? `broadcastRaw` below is irreversible and the compare-and-swap
      // that records it is a SEPARATE write, so a process that dies in between
      // comes back here and finds ITS OWN claim sitting at the outpoint.
      //
      // Read as the client's refund, that is a false-negative `stuck` — `fail`
      // from an exposed state lands there, terminal, for a swap the solver
      // successfully claimed — and the reason string blames the client for it,
      // which is worse than saying nothing: an operator reading "the client
      // refunded" concludes the onchain sats are gone when they are in hand.
      //
      // The witness distinguishes them, and the port's own contract says so:
      // "the claim witness's preimage push". The claim path needs `P`; the
      // refund path does not and cannot produce it. So a witness carrying this
      // row's preimage IS the claim path, which on this leg is ours.
      const preimage = hex.decode(row.preimage)
      const ourClaim = priorSpend.some(
        (element) => element.length === preimage.length && element.every((byte, i) => byte === preimage[i]),
      )
      if (ourClaim) {
        // Settled without a claim txid: `findSpendWitness` returns the witness
        // stack and not the spending txid, so there is nothing truthful to put
        // in the column. Leaving it null is the honest record — the state says
        // the money was collected, and inventing a txid to fill a field would
        // be worse than an empty one.
        // Reachable only before the pre-commit above; no txid to poll (#204).
        return store.transition(row.id, 'claimed', 'settled', {})
      }
      await store.fail(
        row.id,
        'claimed',
        "onchain HTLC already spent before the solver could claim it — likely the client's own refund past htlc_locktime",
      )
      return false
    }

    const htlc = buildOnchainHtlc({
      network: ONCHAIN_NETWORKS[network],
      paymentHash: row.paymentHash,
      claimPubkey: hex.decode(row.htlcPubkey),
      refundPubkey: hex.decode(row.clientOnchainRefundPubkey),
      refundLocktime: row.htlcLocktime,
    })
    if (hex.encode(htlc.pkScript) !== row.onchainPkScript) {
      // Unreachable by construction — same defensive check
      // send/onchainOrchestrator.ts's pushOnchainHtlcRefund makes for its
      // own rebuild. Refusing to sign against a script that doesn't match
      // what was actually funded is the safe failure.
      await store.fail(row.id, 'claimed', 'onchain HTLC rebuilt from row does not match the funded pkScript')
      return false
    }

    const feeRate = await onchain.estimateFeeRate()
    const preimage = hex.decode(row.preimage)
    const sizingParams = {
      htlc,
      preimage,
      fundingTxid: row.fundingTxid,
      fundingVout: row.fundingVout,
      fundingValueSats: row.amountSats,
      destinationScript: claimDestinationScript,
      payoutAmountSats: BigInt(row.amountSats),
    }
    const fee = BigInt(Math.ceil(estimateClaimTxVsize(sizingParams) * feeRate))
    const payoutAmountSats = BigInt(row.amountSats) - fee
    if (payoutAmountSats < BigInt(ONCHAIN_DUST_SATS)) {
      // Below dust is as unbroadcastable as negative — refuse rather than
      // build a non-standard transaction no relay policy will forward. Same
      // "the fee rate is the one lever, retry once it falls" situation
      // send/onchainOrchestrator.ts's pushOnchainHtlcRefund documents; this
      // leg has no operator-retry command yet, so `stuck` is where it
      // parks pending one.
      await store.fail(
        row.id,
        'claimed',
        `claim fee ${fee} at ${feeRate} sat/vB leaves ${payoutAmountSats} sats from a ${row.amountSats} sat HTLC — below the ${ONCHAIN_DUST_SATS} sat dust limit`,
      )
      return false
    }

    const unsigned = buildOnchainClaimTx({ ...sizingParams, payoutAmountSats })
    const signed = await signOnchainClaimTx(unsigned, signer, preimage)
    // Recorded BEFORE the broadcast, so a resumed process has a key to ask about.
    await store.patch(row.id, { onchain_claim_txid: signed.id })
    await onchain.broadcastRaw(hex.encode(signed.extract()))
    return false
  }

  /**
   * Operator override: try the client's L1 HTLC claim again, at TODAY's fee
   * rate. TLA+ finding F4 (#38).
   *
   * The row is `stuck` with a dust refusal: not a lost claim, but one that was
   * uneconomic at a moment when the payout after fees fell under
   * {@link ONCHAIN_DUST_SATS}. The fee rate is the one lever, and `stuck` is terminal
   * with no case in `step()`, so this is what retries it.
   *
   * NOT the refund. By `claimed` the client has already taken the Arkade lockup and
   * revealed `P`, so there is nothing at that script to give back. The solver has PAID
   * OUT and is trying to collect; this is the collecting.
   *
   * Safe to repeat: every attempt spends the SAME output, so a redundant broadcast is a
   * double-spend the network rejects rather than a second payout. No judgement call —
   * unlike the refunds, there is no direction to get wrong.
   *
   * Refuses rather than throws when the fee still eats the payout, and says both
   * numbers, so an operator knows to come back later rather than that something broke.
   */
  async claimNow(id: string): Promise<{ txid: string } | { refused: string }> {
    const { store, onchain, signer, network, claimDestinationScript } = this.deps
    const row = await store.get(id)
    if (!row.preimage) return { refused: 'no preimage on the row: nothing to claim with' }
    if (!row.fundingTxid || row.fundingVout === null) {
      return { refused: 'no funding txid/vout on the row: nothing to claim from' }
    }
    // OUR OWN EARLIER ATTEMPT, BY NAME (#204), and BEFORE the spend read below,
    // which cannot tell whose spend it found. `unknown` never went out: rebuild.
    if (row.onchainClaimTxid) {
      const outcome = await onchain.transactionOutcome(row.onchainClaimTxid)
      if (outcome !== 'unknown') return { txid: row.onchainClaimTxid }
    }
    // The already-spent check `whenClaimed` makes, and the one this method
    // shipped without. Past `htlc_locktime` the CLIENT can sweep the HTLC on
    // their own refund leaf; without this, `broadcastRaw` takes a double-spend
    // rejection from the network and THROWS — the caller gets an exception
    // where the whole point of the `refused` interface is that "come back when
    // fees fall" and "somebody already took it" are different answers. At 3am
    // on a stuck row they are very different answers.
    const priorSpend = await onchain.findSpendWitness({
      txid: row.fundingTxid,
      vout: row.fundingVout,
      outputScript: hex.decode(row.onchainPkScript),
    })
    if (priorSpend) {
      return {
        refused: "onchain HTLC output is already spent — most likely the client's own refund past htlc_locktime",
      }
    }
    const htlc = buildOnchainHtlc({
      network: ONCHAIN_NETWORKS[network],
      paymentHash: row.paymentHash,
      claimPubkey: hex.decode(row.htlcPubkey),
      refundPubkey: hex.decode(row.clientOnchainRefundPubkey),
      refundLocktime: row.htlcLocktime,
    })
    // The same defensive rebuild check the automatic path makes. An operator
    // override is exactly when a mismatched script must NOT be signed against.
    if (hex.encode(htlc.pkScript) !== row.onchainPkScript) {
      return { refused: 'onchain HTLC rebuilt from row does not match the funded pkScript' }
    }
    const feeRate = await onchain.estimateFeeRate()
    const preimage = hex.decode(row.preimage)
    const sizingParams = {
      htlc,
      preimage,
      fundingTxid: row.fundingTxid,
      fundingVout: row.fundingVout,
      fundingValueSats: row.amountSats,
      destinationScript: claimDestinationScript,
      payoutAmountSats: BigInt(row.amountSats),
    }
    const fee = BigInt(Math.ceil(estimateClaimTxVsize(sizingParams) * feeRate))
    const payoutAmountSats = BigInt(row.amountSats) - fee
    if (payoutAmountSats < BigInt(ONCHAIN_DUST_SATS)) {
      return {
        refused:
          `still uneconomic: fee ${fee} at ${feeRate} sat/vB leaves ${payoutAmountSats} sats ` +
          `from a ${row.amountSats} sat HTLC, under the ${ONCHAIN_DUST_SATS} sat dust limit`,
      }
    }
    const unsigned = buildOnchainClaimTx({ ...sizingParams, payoutAmountSats })
    const signed = await signOnchainClaimTx(unsigned, signer, preimage)
    // Recorded BEFORE the broadcast, so a resumed process has a key to ask about.
    await store.patch(row.id, { onchain_claim_txid: signed.id })
    await onchain.broadcastRaw(hex.encode(signed.extract()))
    return { txid: signed.id }
  }

  /**
   * covclaimd never got the claim in before the solver's own Arkade refund
   * deadline — reclaim the solver's own capital via the SAME
   * `nonInteractiveRefund` path the send leg already proves out.
   */
  private async whenRefundingArkade(row: OnchainReceiveSwapRow): Promise<boolean> {
    const { store, arkade } = this.deps

    // A late-but-valid claim can still land right up until the refund
    // actually executes — re-check before racing a refund broadcast against
    // it, same reasoning send's whenRefundingOnchain documents for the
    // identical race on the other leg.
    const outpoints = await arkade.findLockupOutpoints(row.pkScript)
    const preimage = outpoints.length > 0 ? await arkade.findClaimPreimage(outpoints, row.paymentHash) : null
    if (preimage) {
      return store.transition(row.id, 'refunding_arkade', 'claimed', { preimage: hex.encode(preimage) })
    }

    const outputs = await arkade.findLockups(row.pkScript)
    if (outputs.length === 0) {
      // Nothing provably claimed it and nothing is left to refund — most
      // likely our own refund from an earlier attempt that broadcast
      // successfully but crashed before this transition recorded it, though
      // an unreadable-yet claim looks identical from here.
      //
      // "Identical from here" is exactly why this cannot be judged on one
      // look: `findLockups` is `spendableOnly`, so it empties the instant a
      // claim lands, while `findClaimPreimage` above still has to fetch the
      // spending transaction. Give that lag the same bounded grace the
      // Lightning receive leg gives it (EMPTY_LOCKUP_GRACE documents why),
      // measured from this row's entry into `refunding_arkade` — nothing on
      // this leg patches a row, so `updatedAt` does not move while we wait —
      // and let the recheck above run again on the next tick.
      if (this.now() - row.updatedAt < EMPTY_LOCKUP_GRACE) return false
      // Still nothing, long past any read lag. Same "needs a human" posture
      // the send leg takes for the identical ambiguity.
      await store.fail(row.id, 'refunding_arkade', 'lockup empty with no matching claim; needs review')
      return false
    }
    try {
      const txid = await arkade.refund(receiveCovenantRowFor(row), outputs)
      return store.transition(row.id, 'refunding_arkade', 'refunded', { arkade_refund_txid: txid })
    } catch (error) {
      // TLA+ finding F5 (#38), the same escalation the Lightning receive leg
      // grows in `whenRefunding` and for the same reasons — see there for why
      // the deadline is `refundLocktime` rather than a grace, and why this is
      // only safe now that `onchain-receive-refund-now` gives a human somewhere
      // to take the row.
      if (this.now() - row.updatedAt >= REFUND_CENSORSHIP_GRACE) {
        const detail = error instanceof Error ? error.message : String(error)
        await store.fail(row.id, 'refunding_arkade', `refund failing for ${REFUND_CENSORSHIP_GRACE}s: ${detail}`)
        return false
      }
      throw error
    }
  }

  /**
   * Operator override: push this row's Arkade refund now, whatever state it is
   * in. The only path out of `stuck` on this leg, and the thing TLA+ findings
   * F4 and F5 (#38) both turn out to need first.
   *
   * F4 says a fee-dust failure parks here "with no operator retry"; F5 asks for
   * a deadline escalation when the Arkade server stops co-signing. Both are
   * about a row that stops moving, and neither could be answered while `stuck`
   * had no exit — an escalation into a state nothing can act on is a worse
   * outcome than the retry loop it replaces, not a better one.
   *
   * WHOSE MONEY. The solver's own: this leg funds the Arkade lockup out of the
   * float, so refunding takes those sats back. `arkade_refund_txid` was already
   * in this store's PATCH set for exactly this override — the note there
   * predates the override by design.
   *
   * Shares `whenRefundingArkade`'s push rather than reimplementing it, so the
   * manual and automatic paths cannot drift.
   */
  async refundNow(id: string): Promise<string | null> {
    const { store, arkade } = this.deps
    const row = await store.get(id)
    const outputs = await arkade.findLockups(row.pkScript)
    if (outputs.length === 0) return null
    const txid = await arkade.refund(receiveCovenantRowFor(row), outputs)
    await store.patch(row.id, { arkade_refund_txid: txid })
    return txid
  }
}
