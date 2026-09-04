/**
 * The onchain-send orchestrator: quote/fund/broadcast/claim, driven the same
 * way `src/send/orchestrator.ts` drives the Lightning leg — the row is the
 * truth, every step commits intent before the irreversible side effect, and
 * `tick` is safe to call from any number of concurrent callers.
 *
 * The Arkade-side script is UNCHANGED from the Lightning leg:
 * `CovenantSwapScript` already takes a raw 20-byte preimage hash and a
 * refund pkScript, neither of which is Lightning-specific. The client still
 * funds the Arkade lockup and still gets refunded there if the solver never
 * claims — exactly like the Lightning leg. What's new is the OTHER side: the
 * solver funds an onchain HTLC instead of paying an invoice, and claims the
 * Arkade lockup once the CLIENT reveals the preimage by claiming the onchain
 * HTLC (not automatically, the way a Lightning payment reveals it).
 */

import { hex } from '@scure/base'
import type { AdmissionStrategy } from '@arkade-os/solver-core/core/admissionStrategy.js'
import { RFQ_PAIR_ONCHAIN_SEND } from '../wire/onchainPayloads.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ArkAddress } from '@arkade-os/sdk'
import {
  ARKADE_CLAIM_WINDOW_SECONDS,
  DEFAULT_ONCHAIN_LOCKUP_TIMEOUT,
  HTLC_REFUND_MTP_MARGIN,
  ONCHAIN_DUST_SATS,
  arkadeClaimTimeLeft,
  evaluateOnchainSendAcceptance,
  evaluateOnchainSendFunding,
  type OnchainSendAcceptanceRefusal,
} from '@arkade-os/solver-core/core/onchainSend.js'
import type { Limits } from '@arkade-os/solver-core/core/limits.js'
import { FREE, type Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { fixedFeePricing, type PricingStrategy } from '@arkade-os/solver-core/core/pricing.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import {
  buildOnchainRefundTx,
  estimateRefundTxVsize,
  signOnchainRefundTx,
  type OnchainSigner,
} from '@arkade-os/solver-rails/onchain/refund.js'
import type { OnchainSendBackend, ReceiveSettlement } from '@arkade-os/solver-core/ports/onchain.js'
import type { OnchainSendSwapRow, OnchainSendSwapStore } from '../db/onchainSwaps.js'
import type { SwapNetwork } from '@arkade-os/solver-core/core/networks.js'
import type { ArkadeOps, CovenantScriptRow } from './orchestrator.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { MINUTE } from '@arkade-os/solver-core/core/timelocks.js'

export type { ArkadeOps as OnchainArkadeOps } from './orchestrator.js'

export interface OnchainSendServiceDeps {
  /**
   * How this corridor prices. Absent means the configured flat+bps `fee`,
   * which is what every deployment used before pricing became injectable.
   */
  pricing?: PricingStrategy
  store: OnchainSendSwapStore
  onchain: OnchainSendBackend
  arkade: ArkadeOps
  limits: Limits
  network: SwapNetwork
  maxExposedSats: number
  /** Sum of committed sats across every corridor, not just this notebook. */
  totalCommitted: () => Promise<number>
  /**
   * Reserves cap headroom for a quote that has not yet inserted its row (#105).
   * SHARE one instance across every corridor — a per-corridor control bounds
   * only its own concurrency, which is the narrower half of the problem.
   */
  admission: AdmissionStrategy
  /** Signs the solver's own onchain refund spend — matches `ArkadeContext.identity`'s shape exactly. */
  signer: OnchainSigner
  /** Where the solver's own refunded onchain sats go. A P2TR pkScript the solver controls. */
  refundDestinationScript: Uint8Array
  /**
   * What this corridor charges. The client locks the full amount; the solver
   * funds the onchain HTLC with the amount MINUS the fee, persisted on the
   * row as `payoutSats` at quote time. Omitted means free, which is what it
   * charged before fees existed.
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
  | OnchainSendAcceptanceRefusal
  | 'fee_consumes_swap'
  | 'payout_below_dust'
  | 'duplicate_swap'
  | 'provider_at_capacity'
  | 'invalid_refund_address'

export type QuoteOutcome =
  { accepted: true; swap: OnchainSendSwapRow; lockupDeadline: number } | { accepted: false; reason: QuoteRefusal }

export interface OnchainQuoteRequest {
  /** `sha256(P)`, hex (64 chars) — client-chosen; the client is the eventual onchain claimer. Same wire field as `payment_hash`. */
  paymentHash: string
  /**
   * The amount the request carries, read through `amountSide`: the client's
   * give (what they lock at the Arkade covenant) for exact-in, the payout
   * (what lands in the onchain HTLC) for exact-out.
   */
  amountSats: number
  /** exact-in (default): the fee comes out of the payout. exact-out: the give is solved up from the corridor's fee. */
  amountSide?: 'from' | 'to'
  /** The client's x-only pubkey for the onchain HTLC's claim leaf. Wire field `payout_pubkey`. */
  payoutPubkey: string
  /** The client's Arkade refund address — same role as the Lightning leg's `refund_address`. */
  refundAddress: string
  /**
   * The client's own refund key for the covenant's client-side leaves.
   * Required — unlike the Lightning leg, this corridor has no legacy family
   * to accommodate an absent one; every quote gets the extended, eight-leaf
   * script.
   */
  clientRefundPubkey: string
  rfqId?: string
}

/** `sha256(P)`, hex — the same wire-form comparison `row.paymentHash` already uses. */
const paymentHashOf = (preimage: Uint8Array): string => hex.encode(sha256(preimage))

/** Extract the preimage from a claim witness: `[signature, preimage, claimScript, controlBlock]`. */
const preimageFromClaimWitness = (witness: Uint8Array[]): Uint8Array | null => witness[1] ?? null

/**
 * One attempt at the solver's own onchain HTLC refund — see
 * {@link OnchainSendSwapService.pushOnchainHtlcRefund}.
 *
 * The two PERMANENT refusals come back as data rather than as a throw because
 * the callers record them differently: the automatic path burns the row to
 * `stuck`, the operator override prints the reason and leaves the row alone.
 * A TRANSIENT fault (the fee estimate or the broadcast RPC failing) still
 * throws, so neither caller can mistake "the node was unreachable" for "this
 * refund is impossible" — the distinction that keeps a network blip from
 * permanently sticking a row that only needed the next sweep.
 */
type OnchainHtlcRefundAttempt = { broadcast: true; txid: string } | { broadcast: false; reason: string }

/**
 * Re-exported, not defined here: `core/onchainSend.ts` owns it now, because
 * `onchainRefundLocktimeFor` has to reserve time to answer a claim that lands
 * inside this margin. Kept exported from here so the callers that already
 * import it — and the tests that pin refund arming against it — do not move.
 */
export { HTLC_REFUND_MTP_MARGIN }

/**
 * Maps the onchain row's fields onto the shape `covenantScriptFromRow` needs — see `CovenantScriptRow`'s doc comment.
 *
 * Exported for the watch loop's VTXO-lifecycle pass, which has to rebuild the
 * same lockup script this orchestrator does in order to register it as a
 * contract. Sharing the one mapping is the point: a second copy in the caller
 * would derive a different script the moment either drifted, and a contract
 * row is keyed by exactly that script.
 */
export const covenantRowFor = (row: OnchainSendSwapRow): CovenantScriptRow => ({
  id: row.id,
  receiverPubkey: row.providerPubkey,
  serverPubkey: row.serverPubkey,
  paymentHash: row.paymentHash,
  refundLocktime: row.refundLocktime,
  claimDelay: row.claimDelay,
  emulatorPubkey: row.emulatorPubkey,
  refundPkScript: row.refundPkScript,
  pkScript: row.pkScript,
  clientRefundPubkey: row.clientRefundPubkey,
  refundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
  refundDelay: row.refundDelay,
  receiverPkScript: row.receiverPkScript,
  nonInteractiveParameters: row.nonInteractiveParameters,
})

export class OnchainSendSwapService {
  private readonly now: () => number
  private readonly inFlight = new Set<string>()
  private readonly fee: Fee
  /** How this corridor prices. Defaults to the configured flat+bps fee. */
  private readonly pricing: PricingStrategy

  private readonly admission: AdmissionStrategy

  constructor(private readonly deps: OnchainSendServiceDeps) {
    this.now = deps.now ?? nowSeconds
    this.fee = deps.fee ?? FREE
    this.pricing = deps.pricing ?? fixedFeePricing(this.fee)
    this.admission = deps.admission
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

  async quote(request: OnchainQuoteRequest): Promise<QuoteOutcome> {
    const { store, arkade, limits, network } = this.deps

    let refundPkScript: Uint8Array
    try {
      const address = ArkAddress.decode(request.refundAddress)
      refundPkScript = address.pkScript
      if (!request.refundAddress.toLowerCase().startsWith(`${arkade.hrp}1`)) {
        return { accepted: false, reason: 'invalid_refund_address' }
      }
    } catch {
      return { accepted: false, reason: 'invalid_refund_address' }
    }

    // exact-in: the client names what it GIVES. exact-out: it names what it
    // RECEIVES, and the give is solved up from the corridor's fee — the
    // payout is then the request by construction (`giveSatsFor`), which is
    // why `fee_consumes_swap` cannot fire on this side. The acceptance
    // bounds and the exposure cap both deal in the GIVE.
    const giveSats =
      request.amountSide === 'to'
        ? this.pricing.giveFor({ pair: RFQ_PAIR_ONCHAIN_SEND, payoutSats: request.amountSats })
        : request.amountSats
    const acceptance = evaluateOnchainSendAcceptance({
      amountSats: giveSats,
      limits,
      unilateralClaimDelay: arkade.delays.unilateralClaimDelay,
      now: this.now(),
    })
    if (!acceptance.accept) return { accepted: false, reason: acceptance.reason }

    // The client locks the full give; the solver funds the onchain HTLC with
    // the give MINUS this corridor's fee. `payoutSatsFor` deliberately does
    // not clamp (see corridorPolicy.ts): a payout at or below zero is "the
    // fee ate the swap", refused by its own name rather than folded into
    // `amount_out_of_range` — the amount was inside the range, it just
    // cannot be priced. A payout below the dust floor would fund an HTLC
    // nobody can spend — the onchain legs' own floor, refused on BOTH sides:
    // a sub-dust payout is unfundable however the request named it.
    const payoutSats =
      request.amountSide === 'to'
        ? request.amountSats
        : this.pricing.payoutFor({ pair: RFQ_PAIR_ONCHAIN_SEND, giveSats })
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
    // would read the same headroom and take it too (#105). Held until the
    // insert succeeds, and handed back on every path that does not insert.
    const reservation = await this.admission.admit({
      pair: RFQ_PAIR_ONCHAIN_SEND,
      giveSats: giveSats,
      capSats: this.deps.maxExposedSats,
      committedSats: this.deps.totalCommitted,
    })
    if (reservation === null) {
      return { accepted: false, reason: 'provider_at_capacity' }
    }
    try {
      const serverKey = hex.decode(arkade.serverPubkey)
      const arkadeScript = new CovenantSwapScript({
        receiver: hex.decode(arkade.providerPubkey),
        server: serverKey,
        // The Arkade-side script's `preimageHash` param is the 20-byte
        // ripemd160(sha256(P)) — same helper the Lightning leg already uses
        // (`src/send/orchestrator.ts`'s `scriptHashFromPaymentHash(decoded.paymentHash)`),
        // never a raw decode of the wire's sha256 form.
        preimageHash: scriptHashFromPaymentHash(request.paymentHash),
        refundLocktime: acceptance.refundLocktime,
        claimDelay: arkade.delays.unilateralClaimDelay,
        client: hex.decode(request.clientRefundPubkey),
        clientRefundDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
        refundWithoutServerDelay: arkade.delays.unilateralRefundDelay,
        // Every quote from here on carries the current, full covenant suite.
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(arkade.emulatorPubkey),
          receiverPkScript: hex.decode(arkade.receiverPkScript),
          senderPkScript: refundPkScript,
        },
      })

      // acceptance.htlcLocktime is ALREADY an absolute unix-seconds CLTV
      // (src/core/onchainSend.ts's htlcLocktimeFor) — no block-height/chain-tip
      // conversion needed anywhere in this flow. buildOnchainHtlc takes the
      // wire-form sha256 paymentHash directly and derives the script's HASH160
      // commitment internally, same as arkadeScript above does via the shared
      // scriptHashFromPaymentHash helper.
      //
      // htlcPubkey: reusing the solver's Arkade settlement key as its onchain
      // HTLC key too. Cryptographically fine (both are secp256k1 x-only keys
      // in unrelated script contexts), but a deliberate v1 simplification, not
      // a requirement — a deployment that wants key separation between the two
      // roles can swap this for a dedicated onchain key without protocol impact.
      const htlcPubkey = arkade.providerPubkey
      const onchainHtlc = buildOnchainHtlc({
        network: ONCHAIN_NETWORKS[network],
        paymentHash: request.paymentHash,
        claimPubkey: hex.decode(request.payoutPubkey),
        refundPubkey: hex.decode(htlcPubkey),
        refundLocktime: acceptance.htlcLocktime,
      })

      try {
        const swap = await store.insertQuote({
          id: crypto.randomUUID(),
          paymentHash: request.paymentHash,
          amountSats: giveSats,
          // Persisted, not recomputed later: once the client has locked, the fee
          // that priced their payout is a fact, whatever the config has changed
          // to since.
          payoutSats,
          refundLocktime: acceptance.refundLocktime,
          providerPubkey: arkade.providerPubkey,
          serverPubkey: arkade.serverPubkey,
          claimDelay: arkade.delays.unilateralClaimDelay,
          refundDelay: arkade.delays.unilateralRefundDelay,
          refundWithoutReceiverDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
          pkScript: hex.encode(arkadeScript.pkScript),
          lockupAddress: arkadeScript.address(arkade.hrp, serverKey).encode(),
          refundPkScript: hex.encode(refundPkScript),
          emulatorPubkey: arkade.emulatorPubkey,
          clientRefundPubkey: request.clientRefundPubkey,
          receiverPkScript: arkade.receiverPkScript,
          nonInteractiveParameters: true,
          payoutPubkey: request.payoutPubkey,
          htlcPubkey,
          htlcLocktime: acceptance.htlcLocktime,
          minConfirmations: acceptance.minConfirmations,
          onchainAddress: onchainHtlc.address,
          onchainPkScript: hex.encode(onchainHtlc.pkScript),
          rfqId: request.rfqId,
        })
        return { accepted: true, swap, lockupDeadline: this.now() + DEFAULT_ONCHAIN_LOCKUP_TIMEOUT }
      } catch (error) {
        if (error instanceof Error && /UNIQUE/i.test(error.message)) {
          return { accepted: false, reason: 'duplicate_swap' }
        }
        throw error
      }
    } finally {
      // Success or failure, the claim is done: on success the row now
      // counts in `totalCommitted()`, and leaving it up would count the
      // same sats twice; on failure nothing was committed at all.
      reservation.release()
    }
  }

  async tick(id: string): Promise<OnchainSendSwapRow> {
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

  async tickAll(): Promise<OnchainSendSwapRow[]> {
    const rows: OnchainSendSwapRow[] = []
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

  /**
   * Push the covenant refund for ONE row's Arkade lockup, back to the client's
   * committed refund destination.
   *
   * The single definition of "refund this row", shared by the automatic sweep
   * and the operator's {@link refundNow} below so the two can never drift on
   * what that means. Throws on failure rather than swallowing: the sweep wants
   * to log and move to the next row, an operator wants the reason on stdout.
   *
   * @returns the Arkade txid, or null when the script is PROVABLY empty — the
   * client (or another watcher) already moved it. The outcome discriminator
   * records that; the txid column only ever holds txids.
   */
  private async pushRefund(row: OnchainSendSwapRow): Promise<string | null> {
    const { store, arkade } = this.deps
    const outputs = await arkade.findLockups(row.pkScript)
    if (outputs.length === 0) {
      // The Lightning leg's `refundSweep` guards this identically, for the
      // identical reason: `findLockups` is `spendableOnly`, so an empty answer
      // is not proof of a spend, and `findRefundable` (src/db/onchainSwaps.ts)
      // filters `refund_outcome IS NULL` — so recording one shuts the row for
      // good and reports the swap refunded while the money is still there.
      //
      // Throwing rather than returning null is this method's EXISTING contract
      // for "I could not do it", and it is what makes one guard correct for
      // both callers: `refundSweep` logs it through `onTickError` and retries
      // the row next pass, while an operator running {@link refundNow} is told
      // why, instead of being handed a `null` that reads as "already refunded"
      // — the very mistake this guard exists to stop making to a client.
      if (!(await arkade.lockupProvablySpent(row.pkScript))) {
        throw new Error(
          `swap ${row.id}: lockup reads empty but no spend is provable yet — indexer lag, not an external refund`,
        )
      }
      await store.patch(row.id, { refund_outcome: 'external' })
      return null
    }
    const txid = await arkade.refund(covenantRowFor(row), outputs)
    await store.patch(row.id, { refund_outcome: 'pushed', refund_ark_txid: txid })
    return txid
  }

  async refundSweep(): Promise<string[]> {
    const pushed: string[] = []
    for (const row of await this.deps.store.findRefundable(this.now())) {
      try {
        if (await this.pushRefund(row)) pushed.push(row.id)
      } catch (error) {
        this.onTickError?.(row.id, error)
      }
    }
    return pushed
  }

  /**
   * Operator override: push the covenant refund for ONE specific row now,
   * whatever state it is in — the only way a `stuck` swap's Arkade lockup ever
   * moves again.
   *
   * ARKADE LOCKUP ONLY. This never touches the solver's own onchain HTLC, even
   * though it lives on the onchain corridor's service — "onchain" here names
   * the corridor the row belongs to, not the leg being refunded. The other
   * leg is {@link reclaimOnchainHtlc}.
   *
   * `findRefundable` selects `refused` rows only, so the automatic sweep never touches
   * a swap that was ever EXPOSED — and here `stuck` conflates outcomes that are
   * opposites. `whenClaiming` reaches it holding a preimage the client already
   * revealed, so the solver has PAID OUT and refunding would pay the client twice;
   * `whenRefundingOnchain`'s dust case reaches it having just confirmed the client did
   * NOT claim, where refunding is correct. Nothing on the row separates the two —
   * `failure_reason` is free text, and even the "spent by something other than a
   * matching claim" verdict is a guess, since `preimageFromClaimWitness` reads
   * `witness[1]`. A human reads the chain; this is how they act on it.
   *
   * No deadline wait: the leaf this spends is the covenant's
   * `nonInteractiveRefund` (server + receiver + emulator), which carries no
   * timelock, so once that decision is made there is nothing left to wait for.
   */
  async refundNow(id: string): Promise<string | null> {
    return this.pushRefund(await this.deps.store.get(id))
  }

  /**
   * Operator override for the OTHER leg: rebuild and broadcast the solver's
   * own onchain HTLC refund for one row now, whatever state it is in.
   *
   * {@link refundNow} moves the CLIENT's Arkade lockup back; this reclaims the
   * SOLVER's own L1 sats. Without it those sats have no recourse once
   * `whenRefundingOnchain` fails: `fail()` routes every EXPOSED state to `stuck`, which
   * is not a key of `LEGAL_EDGES` and has no case in {@link step}.
   *
   * Unlike {@link refundNow} this carries no double-payout judgement, and that is a
   * property of the leg: refund and claim spend the SAME output, so re-broadcasting
   * against one the client already claimed is a double-spend consensus rejects. The
   * Arkade side has no such backstop, where the lockup and the onchain payout are
   * different assets that really can both land.
   *
   * Manual anyway, because a `stuck` row may be stuck precisely because the client
   * already claimed, and an automatic sweep re-broadcasting a doomed double-spend every
   * cycle is noise an operator has to read past.
   *
   * No state is rewritten on success: the refund txid is recorded and the terminal
   * verdict left alone. Giving `stuck` an edge would hand rows a human parked back to
   * the automatic machinery.
   *
   * @returns the broadcast refund txid.
   * @throws when the refund cannot be attempted at all: no funding output on the row,
   * the client's claim already took it (the recovered preimage is in the message), the
   * row no longer rebuilds the funded script, or the fee at the CURRENT estimate would
   * leave a sub-dust output. Only the last is worth retrying, and only once fees fall.
   */
  async reclaimOnchainHtlc(id: string): Promise<string> {
    const { store, onchain } = this.deps
    const row = await store.get(id)
    if (!row.fundingTxid || row.fundingVout === null) {
      throw new Error(`swap ${id} has no funding txid/vout: nothing was ever broadcast to the onchain HTLC`)
    }

    // Re-read the chain even though the operator asked for a refund. Not to
    // second-guess them about the double-spend — that is harmless here — but
    // because a matching claim means there is something strictly better to do
    // than broadcast: the claim leaf carries no locktime (src/onchain/htlc.ts),
    // so a client can still claim long after `htlcLocktime` and long after the
    // row went `stuck`, and when they have, the preimage on that witness is
    // exactly what the Arkade lockup needs. Surfacing it beats a broadcast
    // that could never confirm.
    const witness = await onchain.findSpendWitness({
      txid: row.fundingTxid,
      vout: row.fundingVout,
      outputScript: hex.decode(row.onchainPkScript),
    })
    const preimage = witness ? preimageFromClaimWitness(witness) : null
    if (preimage && paymentHashOf(preimage) === row.paymentHash) {
      throw new Error(
        `swap ${id}'s onchain HTLC was already claimed by the client, preimage ${hex.encode(preimage)} — ` +
          'a refund of it can never confirm; claim the Arkade lockup with that preimage instead',
      )
    }

    // Any OTHER witness falls through to a broadcast on purpose. That is the
    // case this command exists for: `whenRefundingOnchain` fails a row to
    // `stuck` on exactly this reading, and its likeliest cause is our own
    // earlier refund going out and the process dying before the transition
    // recorded it — same crash shape `recoverFunding` handles for funding.
    // Re-broadcasting then costs nothing: either it lands because the earlier
    // one never really did, or the node rejects it against the spend that
    // did, and the operator reads which from the error.

    // The SAME slot `tick()` takes: each attempt re-reads the fee rate, so two
    // interleaved pre-commit different txids and the row keeps the loser's (#169).
    if (this.inFlight.has(id)) throw new Error(`swap ${id} is already being ticked; retry once that tick finishes`)
    this.inFlight.add(id)
    try {
      const attempt = await this.pushOnchainHtlcRefund(row, row.fundingTxid, row.fundingVout)
      if (!attempt.broadcast) throw new Error(attempt.reason)
      return attempt.txid
    } finally {
      this.inFlight.delete(id)
    }
  }

  /**
   * Finish the job {@link pushOnchainHtlcRefund} starts: make the sats it
   * broadcast back to the solver actually spendable again.
   *
   * Broadcasting a refund only moves the money to the address
   * `OnchainSendBackend.newReceiveAddress` handed out; on a backend where that address
   * does not credit its own wallet, the reclaim is unfinished until this runs. A sweep
   * rather than a step of the refund because the deposit has to confirm first.
   *
   * ROW-INDEPENDENT, unlike every other sweep here: it reads no row and writes
   * none. The backend's own address is the whole input, and what is
   * outstanding at it is a question only the backend can answer — persisting a
   * per-row "settled?" flag would duplicate that answer in a place that can go
   * stale, to no end. It lives on this service anyway because this is where
   * the onchain backend and the refund that created the deposit both already
   * live, and it wants the same cadence as {@link refundSweep}.
   *
   * Empty on a backend that needs no settling — `settleReceiveAddress` is
   * optional, and LND does not implement it.
   */
  async settleRefundDeposits(): Promise<ReceiveSettlement[]> {
    return (await this.deps.onchain.settleReceiveAddress?.()) ?? []
  }

  private async step(row: OnchainSendSwapRow): Promise<boolean> {
    switch (row.state) {
      case 'quoted':
        return this.whenQuoted(row)
      case 'funded':
        return this.whenFunded(row)
      case 'funding_onchain':
        return this.whenFundingOnchain(row)
      case 'awaiting_claim':
        return this.whenAwaitingClaim(row)
      case 'claiming':
        return this.whenClaiming(row)
      case 'refunding_onchain':
        return this.whenRefundingOnchain(row)
      default:
        return false
    }
  }

  private async whenQuoted(row: OnchainSendSwapRow): Promise<boolean> {
    const { store, arkade } = this.deps
    const outputs = await arkade.findLockups(row.pkScript)
    const locked = outputs.reduce((sum, o) => sum + o.value, 0)
    const timedOut = this.now() >= row.createdAt + DEFAULT_ONCHAIN_LOCKUP_TIMEOUT

    if (locked > row.amountSats) {
      await store.fail(row.id, 'quoted', `overfunded lockup: ${locked} > ${row.amountSats} sats`)
      return false
    }
    if (locked === row.amountSats && !timedOut) {
      const [first] = outputs
      return store.transition(row.id, 'quoted', 'funded', {
        onchain_lockup_txid: first?.txid ?? null,
        onchain_lockup_vout: first?.vout ?? null,
        onchain_lockup_value: locked,
      })
    }
    if (timedOut) {
      if (locked > 0) await store.patch(row.id, { onchain_lockup_value: locked })
      await store.fail(row.id, 'quoted', locked > 0 ? `lockup timeout with partial ${locked} sats` : 'lockup timeout')
    }
    return false
  }

  private async whenFunded(row: OnchainSendSwapRow): Promise<boolean> {
    const { store } = this.deps
    const decision = evaluateOnchainSendFunding({ refundLocktime: row.refundLocktime, now: this.now() })
    if (!decision.fund) {
      await store.fail(row.id, 'funded', decision.reason)
      return false
    }
    const won = await store.transition(row.id, 'funded', 'funding_onchain', {})
    if (!won) return false
    return this.submitFunding(await store.get(row.id))
  }

  private async whenFundingOnchain(row: OnchainSendSwapRow): Promise<boolean> {
    if (row.fundingTxid) return this.checkFunded(row)
    return this.recoverFunding(row)
  }

  /**
   * Recovery path: `funding_onchain` with no txid on disk means the process died around
   * `onchain.fund`, which may or may not have gone out. On a backend that drops the
   * per-swap idempotency key, a blind resubmit is a SECOND funding transaction paying
   * the same HTLC out of the solver's own pocket, with no way to recover the first.
   *
   * So ask the chain instead. `row.onchainAddress` is a per-swap P2TR derived from this
   * swap's payment hash, claim key and locktime, so an output there for exactly
   * `payoutSats` is this swap's own funding; adopting its txid/vout finishes the write
   * that never landed.
   *
   * The amount filter is load-bearing: `onchainAddress` is public from the moment the
   * client holds a quote, so adopting an arbitrary output would let one dust payment
   * stop the solver funding at all — leaving a client who claims that dust to reveal
   * `P` and lose the whole Arkade lockup for a few sats. Both backends pay exactly
   * `payoutSats`, so anything else falls through to a real fund.
   *
   * RESIDUAL WINDOW: a crash after the backend commits to paying but before the payment
   * is visible to `findOutputs`. Small for LND; for a backend that accepts first and
   * broadcasts afterwards the idempotency key is what closes it, not this query.
   */
  private async recoverFunding(row: OnchainSendSwapRow): Promise<boolean> {
    const { store, onchain } = this.deps
    const outputs = await onchain.findOutputs({ address: row.onchainAddress })
    const already = outputs.find((output) => output.valueSats === row.payoutSats)
    if (!already) return this.submitFunding(row)
    return store.transition(row.id, 'funding_onchain', 'awaiting_claim', {
      funding_txid: already.txid,
      funding_vout: already.vout,
    })
  }

  private async submitFunding(row: OnchainSendSwapRow): Promise<boolean> {
    const { store, onchain } = this.deps
    // The HTLC carries the PAYOUT — the locked amount minus this corridor's
    // fee, persisted at quote time — never the full `amountSats` the client
    // locked at the Arkade covenant.
    // The exclusive right to broadcast, taken BEFORE broadcasting. Without it
    // two workers both pay the client's HTLC address from different UTXOs, and
    // the compare-and-swap below gates only the recording. `tick()`'s `inFlight`
    // set hides that within one process; a second worker does not have it.
    //
    // Losing is not a failure: another worker holds this swap, so yield.
    if (!(await store.claimFundLease(row.id, 'funding_onchain'))) return false

    let result
    try {
      result = await onchain.fund({
        address: row.onchainAddress,
        amountSats: row.payoutSats,
        // The row id, which is stable across every re-drive of this swap and
        // unique to it — so a backend that honours the key answers a repeat with
        // the funding it already made rather than making another.
        idempotencyKey: `onchain-swap-${row.id}`,
      })
    } catch (error) {
      // Hand the lease back: a throw here moved no money that this service can
      // see, and holding it would strand the row for every worker rather than
      // just this one. The surrounding recovery already owns the ambiguity a
      // throw leaves — it looks for an output at the address for exactly the
      // right amount — and this must not take that away from it.
      await store.releaseFundLease(row.id)
      throw error
    }
    await store.transition(row.id, 'funding_onchain', 'awaiting_claim', {
      funding_txid: result.txid,
      funding_vout: result.vout,
    })
    return true
  }

  private async checkFunded(row: OnchainSendSwapRow): Promise<boolean> {
    return this.deps.store.transition(row.id, 'funding_onchain', 'awaiting_claim', {})
  }

  private async whenAwaitingClaim(row: OnchainSendSwapRow): Promise<boolean> {
    const { store, onchain } = this.deps
    if (!row.fundingTxid || row.fundingVout === null) {
      await store.fail(row.id, 'awaiting_claim', 'awaiting_claim state with no funding txid/vout')
      return false
    }
    const witness = await onchain.findSpendWitness({
      txid: row.fundingTxid,
      vout: row.fundingVout,
      outputScript: hex.decode(row.onchainPkScript),
    })
    if (!witness) {
      // Margin against MTP lag, not just the bare deadline — see
      // HTLC_REFUND_MTP_MARGIN's doc comment.
      if (this.now() >= row.htlcLocktime + HTLC_REFUND_MTP_MARGIN) {
        return store.transition(row.id, 'awaiting_claim', 'refunding_onchain', {})
      }
      return false // client has not claimed yet, and the timeout hasn't matured — keep waiting
    }

    const preimage = preimageFromClaimWitness(witness)
    if (!preimage || paymentHashOf(preimage) !== row.paymentHash) {
      // A spend exists but does not look like our claim leaf (or reveals a
      // preimage that does not fit) — most likely the SOLVER'S OWN refund
      // spend after a timeout, not the client's claim. Routed to a human:
      // the exposed capital needs eyes either way.
      await store.fail(row.id, 'awaiting_claim', 'onchain HTLC spent by something other than a matching claim')
      return false
    }
    // TLA+ FINDING F7 (#104), THE HALF NO LOCKTIME CAN FIX.
    //
    // `onchainRefundLocktimeFor` reserves ARKADE_CLAIM_WINDOW_SECONDS past the
    // last instant a claim can arrive, so the GEOMETRY of a quote always leaves
    // room. What it cannot reserve is elapsed time: a solver that was down for
    // hours comes back to a claim already on the chain and a deadline nearly
    // spent. From here the race is real — we hold `P`, and the client can pull
    // their lockup back on its refund leaf the moment `refund_locktime` passes.
    //
    // Claiming anyway is right: it is the only recourse, and a claim that lands
    // one second before the deadline collects in full. So the row is NOT failed
    // and the transition is NOT skipped. What was missing is that nobody was
    // told — the loss would arrive as a swap that simply stopped being worth
    // anything, with no record of the squeeze that caused it.
    const timeLeft = arkadeClaimTimeLeft(row.refundLocktime, this.now())
    if (timeLeft < ARKADE_CLAIM_WINDOW_SECONDS) {
      this.onTickError?.(
        row.id,
        new Error(
          `claim race: ${timeLeft}s left to claim the arkade lockup, under the ${ARKADE_CLAIM_WINDOW_SECONDS}s budget ` +
            `(refund_locktime ${row.refundLocktime}, htlc_locktime ${row.htlcLocktime}) — claiming anyway`,
        ),
      )
    }
    return store.transition(row.id, 'awaiting_claim', 'claiming', { preimage: hex.encode(preimage) })
  }

  private async whenClaiming(row: OnchainSendSwapRow): Promise<boolean> {
    const { store, arkade } = this.deps
    if (!row.preimage) {
      await store.fail(row.id, 'claiming', 'claiming state with no preimage')
      return false
    }
    const outputs = await arkade.findLockups(row.pkScript)
    if (outputs.length === 0) {
      await store.fail(row.id, 'claiming', 'lockup empty while claiming with no claim txid recorded; needs review')
      return false
    }
    try {
      const txid = await arkade.claim(covenantRowFor(row), outputs, row.preimage)
      await store.transition(row.id, 'claiming', 'claimed', { claim_ark_txid: txid })
      return false
    } catch (error) {
      if (this.now() >= row.refundLocktime) {
        const detail = error instanceof Error ? error.message : String(error)
        await store.fail(row.id, 'claiming', `claim failing past the refund deadline: ${detail}`)
        return false
      }
      throw error
    }
  }

  /**
   * The client never claimed the onchain HTLC past `htlcLocktime` — reclaim
   * the solver's own funds via the refund leaf `buildOnchainHtlc` already
   * builds. Rebuilds the HTLC FROM THE ROW rather than trusting live state,
   * same principle `covenantScriptFromRow` (src/send/arkadeOps.ts) documents
   * for the Arkade side.
   */
  private async whenRefundingOnchain(row: OnchainSendSwapRow): Promise<boolean> {
    const { store, onchain } = this.deps
    if (!row.fundingTxid || row.fundingVout === null) {
      await store.fail(row.id, 'refunding_onchain', 'refunding_onchain state with no funding txid/vout')
      return false
    }

    // OUR OWN EARLIER ATTEMPT, BY NAME (#169, #204): the pre-committed txid stops
    // a refund that went out before a crash being written off as a foreign spend
    // below. Before the claim read, because a CONFIRMED refund of this outpoint
    // means no claim can exist; the reverse is not true.
    if (row.onchainRefundTxid) {
      const outcome = await onchain.transactionOutcome(row.onchainRefundTxid)
      if (outcome === 'confirmed') return store.transition(row.id, 'refunding_onchain', 'refunded', {})
      if (outcome === 'mempool') return false
    }

    // The client can still land a valid claim right up to (and, within
    // HTLC_REFUND_MTP_MARGIN, briefly after) htlcLocktime matures. Re-check
    // before racing a refund broadcast against it: without this, a
    // late-but-valid claim leaves this row retrying a failing double-spend
    // forever (LEGAL_EDGES has no way back to `claiming` otherwise) — the
    // preimage is never recovered, the Arkade lockup is never claimed, and
    // the client can still unilaterally refund that same lockup once
    // refundLocktime passes. Net: the solver pays onchain AND loses the
    // lockup.
    const claimWitness = await onchain.findSpendWitness({
      txid: row.fundingTxid,
      vout: row.fundingVout,
      outputScript: hex.decode(row.onchainPkScript),
    })
    if (claimWitness) {
      const preimage = preimageFromClaimWitness(claimWitness)
      if (preimage && paymentHashOf(preimage) === row.paymentHash) {
        return store.transition(row.id, 'refunding_onchain', 'claiming', { preimage: hex.encode(preimage) })
      }
      // Neither a matching claim nor the refund above: genuinely unrecognisable.
      await store.fail(row.id, 'refunding_onchain', 'onchain HTLC spent by something other than a matching claim')
      return false
    }

    const attempt = await this.pushOnchainHtlcRefund(row, row.fundingTxid, row.fundingVout)
    if (!attempt.broadcast) {
      await store.fail(row.id, 'refunding_onchain', attempt.reason)
      return false
    }
    return false
  }

  /**
   * Rebuild, size, sign and broadcast the solver's own refund spend of ONE
   * row's onchain HTLC.
   *
   * The single definition of "reclaim our own L1 sats", shared by the
   * automatic {@link whenRefundingOnchain} and the operator's
   * {@link reclaimOnchainHtlc} so the two can never drift on what that means —
   * the same reason {@link pushRefund} is shared by `refundSweep` and
   * {@link refundNow} on the Arkade side. Rebuilds the HTLC FROM THE ROW
   * rather than trusting live state, same principle `covenantScriptFromRow`
   * (src/send/arkadeOps.ts) documents for the Arkade side.
   *
   * Deliberately reads neither `row.state` nor whether the output has already
   * been spent: both are the caller's policy, and the two callers differ on
   * both. `fundingTxid`/`fundingVout` come in narrowed for the same reason —
   * a row without them never broadcast anything, and what to say about that
   * differs per caller.
   */
  private async pushOnchainHtlcRefund(
    row: OnchainSendSwapRow,
    fundingTxid: string,
    fundingVout: number,
  ): Promise<OnchainHtlcRefundAttempt> {
    const { onchain, signer, refundDestinationScript, network } = this.deps

    const htlc = buildOnchainHtlc({
      network: ONCHAIN_NETWORKS[network],
      paymentHash: row.paymentHash,
      claimPubkey: hex.decode(row.payoutPubkey),
      refundPubkey: hex.decode(row.htlcPubkey),
      refundLocktime: row.htlcLocktime,
    })
    if (hex.encode(htlc.pkScript) !== row.onchainPkScript) {
      // Unreachable by construction — same defensive check `arkadeOps.ts`'s
      // `assertScriptMatchesRow` makes for the Arkade side. Refusing to sign
      // against a script that doesn't match what was actually funded is the
      // safe failure.
      //
      // Nothing retryable about it either: this rebuild is a pure function of
      // columns that never change after the quote, so a second attempt hits
      // the identical mismatch. If it ever fires for real the row's script
      // parameters and the funded output have genuinely diverged, and only a
      // human reading both can say which one is wrong — hence a refusal that
      // says so, rather than a loop.
      return { broadcast: false, reason: 'onchain HTLC rebuilt from row does not match the funded pkScript' }
    }

    const feeRate = await onchain.estimateFeeRate()
    const sizingParams = {
      htlc,
      fundingTxid,
      fundingVout,
      // The HTLC holds the PAYOUT (locked amount minus this corridor's fee),
      // so that — not `amountSats` — is what a reclaim is sized against.
      fundingValueSats: row.payoutSats,
      destinationScript: refundDestinationScript,
      payoutAmountSats: BigInt(row.payoutSats),
    }
    const fee = BigInt(Math.ceil(estimateRefundTxVsize(sizingParams) * feeRate))
    const payoutAmountSats = BigInt(row.payoutSats) - fee
    if (payoutAmountSats < BigInt(ONCHAIN_DUST_SATS)) {
      // Below dust is as unbroadcastable as negative — refuse rather than
      // build a non-standard transaction no relay policy will forward.
      //
      // The one lever a human has here is the fee rate, and it is a real one:
      // `estimateFeeRate` is re-read on every attempt, so an HTLC priced out
      // by a mempool spike becomes refundable again once fees fall, and
      // {@link reclaimOnchainHtlc} is how that retry is driven. Below that,
      // nothing in this module helps — dust is a floor on the OUTPUT value,
      // so an HTLC too small to cover its own spend at ANY plausible rate can
      // only be recovered by batching it with other inputs, which the
      // deliberately single-input builder in `src/onchain/refund.ts` cannot
      // express. An accepted limit, not a TODO in disguise; the rate goes in
      // the reason so the two cases can be told apart from the row alone.
      return {
        broadcast: false,
        reason: `refund fee ${fee} at ${feeRate} sat/vB leaves ${payoutAmountSats} sats from a ${row.payoutSats} sat HTLC — below the ${ONCHAIN_DUST_SATS} sat dust limit`,
      }
    }

    const unsigned = buildOnchainRefundTx({ ...sizingParams, payoutAmountSats })
    const signed = await signOnchainRefundTx(unsigned, signer)
    // PRE-COMMITTED, here so both callers get it (#169). Holding the id of a
    // broadcast that threw is the safe direction: `unknown`, then rebuild.
    await this.deps.store.patch(row.id, { onchain_refund_txid: signed.id })
    await onchain.broadcastRaw(hex.encode(signed.extract()))
    return { broadcast: true, txid: signed.id }
  }
}
