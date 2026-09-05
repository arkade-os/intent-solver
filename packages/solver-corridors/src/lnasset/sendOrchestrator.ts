/**
 * `arkade:<asset>->lightning:BTC` — the client locks an ASSET at a VHTLC, the
 * solver pays sats over Lightning and claims the lockup with the preimage the
 * payment reveals. Issue #21's leg.
 *
 * A THIN SHELL over `planLnAssetSend`. Every ordering rule that can lose money
 * is in that planner and is unit-tested without a wallet, a node or a database;
 * this file resolves the observations the planner asks for, and carries out the
 * one action it returns. The BTC send leg keeps the same decisions inside a
 * 1,588-line service, which is why its ordering can only be tested through fakes.
 *
 * WHAT DIFFERS FROM `arkade:BTC->lightning:BTC`, and it is only two things:
 *
 * - The funding check is `lockupIsFunded`'s ASSET arm. Every `.value` sum in
 *   this repo reads an asset lockup with the right sats carrier as funded, so
 *   the sats-shaped gate is not merely insufficient here, it is affirmatively
 *   wrong.
 * - The quote window is `LN_ASSET_QUOTE_WINDOW`, not `DEFAULT_LOCKUP_TIMEOUT`.
 *   The pair is cross-asset, so the window is a free option on the rate.
 *
 * The claim, the covenant, the CLTV arithmetic and the exposure unit are all
 * unchanged — #21 § 1: the payout IS the BTC leg, so `committedSats` reports it
 * directly and no new denomination is needed.
 */

import { randomUUID } from 'node:crypto'
import type { AdmissionStrategy } from '@arkade-os/solver-core/core/admissionStrategy.js'
import { lockupIsFunded } from '@arkade-os/solver-core/core/lockupFunded.js'
import {
  evaluateLnAssetInventory,
  lnAssetPairFor,
  LN_ASSET_QUOTE_WINDOW,
  resolveLnAssetSendQuote,
  type LnAssetMarket,
} from '@arkade-os/solver-core/core/lnAsset.js'
import { planLnAssetSend, type LnAssetPaymentOutcome } from '@arkade-os/solver-core/core/lnAssetPlan.js'
import { evaluateSendAcceptance, evaluateSendPayment, payableCltvBlocks } from '@arkade-os/solver-core/core/send.js'
import type { Price } from '@arkade-os/solver-core/core/priceFeed.js'
import type { DecodedInvoice } from '@arkade-os/solver-core/invoice/decode.js'
import type { CovenantScriptRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'
import type { FundedOutput } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { LnAssetSendSwapStore, type LnAssetSendSwapRow } from '../db/lnAssetSendSwaps.js'

/** The Arkade operations this leg needs. A narrowing of `ArkadeOps`. */
export interface LnAssetSendArkadeOps {
  providerPubkey: string
  serverPubkey: string
  emulatorPubkey: string
  receiverPkScript: string
  delays: { unilateralClaimDelay: number; unilateralRefundDelay: number; unilateralRefundWithoutReceiverDelay: number }
  hrp: string
  findLockups(pkScriptHex: string): Promise<FundedOutput[]>
  /**
   * Spend the claim leaf, revealing the preimage — and DECLARING THE ASSET.
   * `claimSwapScript` builds the packet from what the funded outputs carry, so
   * the same call serves both denominations.
   */
  claim(row: CovenantScriptRow, outputs: FundedOutput[], preimageHex: string): Promise<string>
  /** Spendable balance of one asset, atomic units. */
  assetBalance(assetId: string): Promise<bigint>
}

/** The Lightning operations this leg needs. A narrowing of `SendBackend`. */
export interface LnAssetSendLightning {
  routeCltvBudgetBlocks: number
  enforcesRouteCltv: boolean
  payInvoice(params: {
    invoice: string
    maxFeeSats: number
    idempotencyKey: string
    maxCltvBlocks: number
  }): Promise<{ id: string; status: string; preimage?: string; failureReason?: string }>
  getPayment(id: string): Promise<{ status: string; preimage?: string; failureReason?: string } | null>
}

/** How this leg builds the covenant it will claim. Injected so core stays script-free. */
export interface LnAssetCovenantBuilder {
  (params: {
    receiverPubkey: string
    clientRefundPubkey: string
    paymentHash: string
    refundLocktime: number
    refundPkScript: string
    assetId: string
  }): { pkScript: string; lockupAddress: string }
}

export interface LnAssetSendDeps {
  store: LnAssetSendSwapStore
  market: LnAssetMarket
  arkade: LnAssetSendArkadeOps
  ln: LnAssetSendLightning
  buildCovenant: LnAssetCovenantBuilder
  decodeInvoice: (invoice: string) => DecodedInvoice
  fetchPrice: (feedUrl: string, pricePath: string) => Promise<Price>
  /** bech32 prefix this deployment serves, for the invoice's network check. */
  providerNetwork: string
  /** What the solver will spend on routing, sats. */
  maxRoutingFeeSats: number
  maxExposedSats: number
  totalCommitted: () => Promise<number>
  admission: AdmissionStrategy
  /** Sums this asset's inbound commitments elsewhere, for the ceiling. */
  committedAssetUnits?: (assetId: string) => Promise<bigint>
  onError?: (id: string, error: unknown) => void
  now?: () => number
  newId?: () => string
}

export type LnAssetSendQuoteRefusal =
  | 'unsupported_pair'
  | 'price_unavailable'
  | 'fee_consumes_swap'
  | 'amount_out_of_range'
  | 'invoice_expired'
  | 'invoice_expires_too_soon'
  | 'wrong_network'
  | 'zero_amount_invoice'
  | 'cltv_too_large'
  | 'duplicate_swap'
  | 'provider_at_capacity'
  | 'inventory_ceiling_reached'

export type LnAssetSendQuoteOutcome =
  { accepted: true; swap: LnAssetSendSwapRow } | { accepted: false; reason: LnAssetSendQuoteRefusal; detail?: string }

export interface LnAssetSendQuoteRequest {
  rfqId: string
  pair: string
  invoice: string
  /** Where the CLIENT's own refund pays, and the key that signs it. */
  refundPkScript: string
  clientRefundPubkey: string
}

const paymentOutcomeOf = (status: string | undefined): LnAssetPaymentOutcome => {
  if (status === 'succeeded' || status === 'settled') return 'succeeded'
  if (status === 'failed') return 'failed'
  return status === undefined ? 'none' : 'in_flight'
}

export class LnAssetSendSwapService {
  private readonly now: () => number
  private readonly newId: () => string
  private readonly inFlight = new Set<string>()

  constructor(private readonly deps: LnAssetSendDeps) {
    this.now = deps.now ?? nowSeconds
    this.newId = deps.newId ?? (() => randomUUID())
  }

  /** The pair this instance serves. */
  get pair(): string {
    return lnAssetPairFor(this.deps.market.assetId, 'send')
  }

  /**
   * Quote a swap: decode the invoice, price the asset the client must lock, and
   * persist the row BEFORE the client is told anything.
   *
   * Cheap gates first, then the feed, then the reservation — so a retry storm on
   * one rfq id cannot drive traffic to the price source, and so a refusal is the
   * most specific true statement rather than whichever gate ran first.
   */
  async quote(request: LnAssetSendQuoteRequest): Promise<LnAssetSendQuoteOutcome> {
    const { store, market, arkade, ln } = this.deps
    if (request.pair !== this.pair) {
      return { accepted: false, reason: 'unsupported_pair', detail: `this corridor serves ${this.pair}` }
    }

    let decoded: DecodedInvoice
    try {
      decoded = this.deps.decodeInvoice(request.invoice)
    } catch (error) {
      return {
        accepted: false,
        reason: 'zero_amount_invoice',
        detail: error instanceof Error ? error.message : String(error),
      }
    }

    if (await store.findByRfqId(request.rfqId)) {
      return { accepted: false, reason: 'duplicate_swap', detail: 'rfq_id already names a negotiation' }
    }
    if (await store.findLiveByPaymentHash(decoded.paymentHash)) {
      return { accepted: false, reason: 'duplicate_swap', detail: 'a live swap already holds this payment hash' }
    }

    const now = this.now()
    const acceptance = evaluateSendAcceptance({
      invoiceExpiresAt: decoded.expiresAt,
      invoiceAmountSats: decoded.amountSats,
      invoiceNetwork: decoded.network,
      providerNetwork: this.deps.providerNetwork,
      limits: market.limits,
      minFinalCltvBlocks: decoded.minFinalCltvBlocks,
      worstRouteHintCltvBlocks: decoded.worstRouteHintCltvBlocks,
      bestRouteHintCltvBlocks: decoded.bestRouteHintCltvBlocks,
      routeCltvBudgetBlocks: ln.routeCltvBudgetBlocks,
      enforcesRouteCltv: ln.enforcesRouteCltv,
      unilateralClaimDelay: arkade.delays.unilateralClaimDelay,
      // The cross-asset window, not the 15-minute same-asset one: the deadline
      // has to reserve the funding time it actually grants.
      lockupTimeout: LN_ASSET_QUOTE_WINDOW,
      now,
    })
    if (!acceptance.accept) {
      return { accepted: false, reason: acceptance.reason, detail: acceptance.detail }
    }

    let feed: Price
    try {
      feed = await this.deps.fetchPrice(market.feedUrl, market.pricePath)
    } catch (error) {
      // An unreadable feed must never become a free fill.
      this.deps.onError?.('price', error)
      return { accepted: false, reason: 'price_unavailable', detail: 'the market feed could not be read' }
    }

    const priced = resolveLnAssetSendQuote({ payoutSats: decoded.amountSats, market, feed })
    if (!priced.ok) return { accepted: false, reason: priced.reason }

    // The ceiling counts what this solver is ALREADY owed as well as what this
    // swap would add: a gate reading only the settled balance admits every
    // concurrent quote and breaches the ceiling by their sum.
    const committed = (await this.deps.committedAssetUnits?.(market.assetId)) ?? 0n
    const inventory = evaluateLnAssetInventory({
      direction: 'send',
      held: (await arkade.assetBalance(market.assetId)) + committed,
      amount: priced.giveAsset,
      ceiling: market.inventoryCeiling,
    })
    if (!inventory.ok) return { accepted: false, reason: inventory.reason as LnAssetSendQuoteRefusal }

    // RESERVED, not merely observed (#105): until the row lands, a concurrent
    // quote reads the same headroom and takes it too.
    const reservation = await this.deps.admission.admit({
      pair: this.pair,
      giveSats: decoded.amountSats,
      capSats: this.deps.maxExposedSats,
      committedSats: this.deps.totalCommitted,
    })
    if (reservation === null) return { accepted: false, reason: 'provider_at_capacity' }

    try {
      const covenant = this.deps.buildCovenant({
        receiverPubkey: arkade.providerPubkey,
        clientRefundPubkey: request.clientRefundPubkey,
        paymentHash: decoded.paymentHash,
        refundLocktime: acceptance.refundLocktime,
        refundPkScript: request.refundPkScript,
        assetId: market.assetId,
      })
      const swap = await store.insertQuote({
        id: this.newId(),
        paymentHash: decoded.paymentHash,
        pair: this.pair,
        invoice: decoded.invoice,
        invoiceExpiresAt: decoded.expiresAt,
        payoutSats: decoded.amountSats,
        assetId: market.assetId,
        // Snapshotted: a market re-configured after the quote must not change
        // what this row means.
        assetDecimals: market.decimals,
        lockupAssetAmount: priced.giveAsset,
        lockupDeadline: acceptance.lockupDeadline,
        refundLocktime: acceptance.refundLocktime,
        solverPubkey: arkade.providerPubkey,
        serverPubkey: arkade.serverPubkey,
        claimDelay: arkade.delays.unilateralClaimDelay,
        refundDelay: arkade.delays.unilateralRefundDelay,
        refundWithoutReceiverDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
        emulatorPubkey: arkade.emulatorPubkey,
        pkScript: covenant.pkScript,
        lockupAddress: covenant.lockupAddress,
        refundPkScript: request.refundPkScript,
        clientRefundPubkey: request.clientRefundPubkey,
        rfqId: request.rfqId,
      })
      return { accepted: true, swap }
    } catch (error) {
      this.deps.onError?.(request.rfqId, error)
      return { accepted: false, reason: 'duplicate_swap', detail: 'a negotiation already holds this id or hash' }
    } finally {
      reservation.release()
    }
  }

  /** Advance one swap as far as it can go right now. Re-entrant; re-reads the row. */
  async tick(id: string): Promise<LnAssetSendSwapRow> {
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

  async tickAll(): Promise<string[]> {
    const driven: string[] = []
    for (const row of await this.deps.store.findRecoverable()) {
      if (this.inFlight.has(row.id)) continue
      try {
        await this.tick(row.id)
        driven.push(row.id)
      } catch (error) {
        this.deps.onError?.(row.id, error)
      }
    }
    return driven
  }

  private async observe(row: LnAssetSendSwapRow) {
    const { arkade, ln } = this.deps
    const outputs = await arkade.findLockups(row.pkScript)
    const holds = lockupIsFunded(outputs, {
      kind: 'asset',
      assetId: row.assetId,
      amount: row.lockupAssetAmount,
    })

    let outcome: LnAssetPaymentOutcome = 'none'
    let preimage = row.preimage
    if (row.paymentId !== null) {
      const payment = await ln.getPayment(row.paymentId).catch(() => null)
      outcome = paymentOutcomeOf(payment?.status)
      preimage = payment?.preimage ?? preimage
    } else if (row.payAttemptedAt !== null) {
      // A payment was ATTEMPTED and no id was recorded, so its outcome is
      // unknown — never `none`, which the planner reads as "nothing left".
      outcome = 'in_flight'
    }

    const now = this.now()
    const decision = evaluateSendPayment({
      invoiceExpiresAt: row.invoiceExpiresAt,
      refundLocktime: row.refundLocktime,
      // The amount gates live in the ASSET arm above; this call answers the
      // time and CLTV questions only, so it is handed a satisfied sats pair
      // rather than a sats figure this corridor does not have.
      lockedSats: 1,
      expectedSats: 1,
      minFinalCltvBlocks: this.cltvOf(row).minFinalCltvBlocks,
      worstRouteHintCltvBlocks: this.cltvOf(row).worstRouteHintCltvBlocks,
      bestRouteHintCltvBlocks: this.cltvOf(row).bestRouteHintCltvBlocks,
      routeCltvBudgetBlocks: ln.routeCltvBudgetBlocks,
      enforcesRouteCltv: ln.enforcesRouteCltv,
      now,
    })

    return {
      outputs,
      seen: {
        lockupHoldsQuotedAsset: holds,
        payment: decision,
        paymentOutcome: outcome,
        preimage,
        nowSeconds: now,
      },
    }
  }

  private cltvOf(row: LnAssetSendSwapRow): DecodedInvoice {
    return this.deps.decodeInvoice(row.invoice)
  }

  private async step(row: LnAssetSendSwapRow): Promise<boolean> {
    const { store, arkade, ln } = this.deps
    const { outputs, seen } = await this.observe(row)
    const action = planLnAssetSend(
      {
        state: row.state,
        lockupDeadline: row.lockupDeadline,
        refundLocktime: row.refundLocktime,
        preimage: row.preimage,
      },
      seen,
    )

    switch (action.do) {
      case 'wait':
        return false

      case 'refuse':
        // `paying` has proof only when the backend said `failed`; `fail()`
        // routes every other exposed state to `stuck` by itself.
        if (row.state === 'paying') {
          return store.transition(row.id, 'paying', 'refused', { failure_reason: action.reason })
        }
        await store.fail(row.id, row.state, action.reason)
        return false

      case 'stick':
        await store.fail(row.id, row.state, action.reason)
        return false

      case 'pay_invoice': {
        // INTENT BEFORE THE IRREVERSIBLE ACT. `quoted -> funded -> paying` are
        // two compare-and-swaps, and only the second one guards the payment:
        // a crash between it and `payInvoice` leaves a row that says something
        // may be in flight, rather than one that still reads payable.
        if (
          row.state === 'quoted' &&
          !(await store.transition(row.id, 'quoted', 'funded', {
            lockup_txid: outputs[0]?.txid ?? null,
            lockup_vout: outputs[0]?.vout ?? null,
            lockup_asset_held: seen.lockupHoldsQuotedAsset ? row.lockupAssetAmount.toString() : null,
          }))
        ) {
          return false
        }
        if (row.state === 'quoted') return true

        if (!(await store.transition(row.id, 'funded', 'paying', { pay_attempted_at: this.now() }))) return false
        const cltv = this.cltvOf(row)
        const result = await ln.payInvoice({
          invoice: row.invoice,
          maxFeeSats: this.deps.maxRoutingFeeSats,
          // Stable per swap, so a retried call cannot pay twice.
          idempotencyKey: row.id,
          maxCltvBlocks: payableCltvBlocks(
            {
              minFinalCltvBlocks: cltv.minFinalCltvBlocks,
              worstRouteHintCltvBlocks: cltv.worstRouteHintCltvBlocks,
              bestRouteHintCltvBlocks: cltv.bestRouteHintCltvBlocks,
              routeCltvBudgetBlocks: ln.routeCltvBudgetBlocks,
              enforcesRouteCltv: ln.enforcesRouteCltv,
            },
            row.refundLocktime,
            this.now(),
          ),
        })
        await store.patch(row.id, { payment_id: result.id })
        return true
      }

      case 'record_payment':
        return store.transition(row.id, 'paying', 'paid', { preimage: action.preimage })

      case 'claim_asset': {
        if (outputs.length === 0) {
          await store.fail(row.id, row.state, 'nothing left at the lockup to claim')
          return false
        }
        if (row.state === 'paid' && !(await store.transition(row.id, 'paid', 'claiming', {}))) return false
        const txid = await arkade.claim(covenantRowFor(row), outputs, action.preimage)
        return store.transition(row.id, 'claiming', 'claimed', { claim_ark_txid: txid })
      }
    }
  }
}

/** Maps this leg's row onto the shape the covenant helpers take. */
export const covenantRowFor = (row: LnAssetSendSwapRow): CovenantScriptRow => ({
  id: row.id,
  receiverPubkey: row.solverPubkey,
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
  receiverPkScript: row.refundPkScript,
  nonInteractiveParameters: true,
  /** What makes the rebuilt script an ASSET covenant rather than a sats one. */
  assetId: row.assetId,
})
