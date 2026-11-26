/**
 * The `settle` port the RFQ route injects: a quoted, funded row in, a fill txid
 * out.
 *
 * `offerSettle.ts` is the packet path's equivalent and rebuilds the offer by
 * decoding the funding transaction, because there the maker's terms are only
 * ever known from the packet. Here THIS solver quoted them, so the row is the
 * authority and the covenant is re-derived from it — every guard below is a way
 * the row and the chain can disagree, and each refuses before `fulfillOffer`
 * because a mismatch found afterwards is a spend rather than a refusal.
 *
 * A throw leaves the row `stuck`, which is what a row disagreeing with the chain
 * needs: a human. Its deposit's own liveness is the exception — a lost race is
 * no disagreement — so that one is typed. @see OfferNotSubmittedError
 */
import type { ArkadeContext } from './wallet.js'
import { fulfillOffer, OfferNotSubmittedError, type FulfillOptions } from './offerFulfill.js'
import { heldOf } from './offerFill.js'
import { liveOfferOutpoints, type OfferOutpoint } from './offerOutpoints.js'
import { offerScriptFrom, type OfferDerivation, type QuotedOfferTerms } from './offerTerms.js'
import { encodeOffer } from '@arkade-os/swap/protocol'
import { hex } from '@scure/base'

const assertSafeSats = (sats: bigint): number => {
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`deposit of ${sats} sats exceeds a safe integer`)
  return Number(sats)
}

/** The negotiated row, structurally. `AssetRfqSwapRow` satisfies it. */
export interface QuotedOfferIntent {
  id: string
  rfqId: string
  offerPkScript: string
  fromAssetId: string | null
  fromAmount: bigint
  toAssetId: string | null
  toAmount: bigint
  makerPkScript: string
  makerPublicKey: string
  depositTxid: string | null
  depositVout: number | null
  carrierTerms?: { mode: 'purchase' | 'recycle' | 'recycle_receiver' } | null
  /** The negotiated contract version; null is the baseline, asset-swap-v2. */
  contractVersion: string | null
  /** Null on a row quoted before the key was stored: it was derived with the deployment's own. */
  emulatorPubkey?: string | null
}

export interface QuotedOfferSettleDeps {
  ctx: ArkadeContext
  emulatorUrl: string
  derivation: OfferDerivation
  /** Injected so the guards are testable without an Arkade Service. */
  outpointsAt?: (pkScript: string) => Promise<OfferOutpoint[]>
  fulfill?: typeof fulfillOffer
}

const termsOf = (intent: QuotedOfferIntent): QuotedOfferTerms => ({
  wantAmount: intent.toAmount,
  wantAssetId: intent.toAssetId,
  offerAssetId: intent.fromAssetId,
  makerPkScript: intent.makerPkScript,
  makerPublicKey: intent.makerPublicKey,
  rfqId: intent.rfqId,
  emulatorPubkey: intent.emulatorPubkey,
})

/** The offer a row's deposit was derived from, taker and nonce included: what a Taxi fill rebuilds its spend from. */
export const quotedOfferHexFor = (derivation: OfferDerivation): ((intent: QuotedOfferIntent) => string) => {
  const derive = offerScriptFrom(derivation)
  return (intent) => {
    const derived = derive(termsOf(intent), intent.contractVersion ?? undefined)
    if (derived.pkScript.toLowerCase() !== intent.offerPkScript.toLowerCase()) {
      throw new Error(`the recorded terms derive ${derived.pkScript}, not the offer script ${intent.offerPkScript}`)
    }
    return hex.encode(encodeOffer(derived.offer))
  }
}

export const quotedOfferSettleFor = (
  deps: QuotedOfferSettleDeps,
): ((intent: QuotedOfferIntent, options?: FulfillOptions) => Promise<string>) => {
  const outpointsAt = deps.outpointsAt ?? ((pkScript: string) => liveOfferOutpoints(deps.ctx, pkScript))
  const fulfill = deps.fulfill ?? fulfillOffer
  const derive = offerScriptFrom(deps.derivation)

  return async (intent, options) => {
    if (intent.carrierTerms?.mode === 'recycle' || intent.carrierTerms?.mode === 'recycle_receiver') {
      throw new Error(`${intent.carrierTerms.mode} settlement requires the dedicated receive-carrier adapter`)
    }
    if (intent.depositTxid === null || intent.depositVout === null) {
      throw new Error(`the negotiation at ${intent.offerPkScript} records no deposit outpoint to spend`)
    }

    // Derived, never read off the row. The row's terms are what was quoted and
    // its script is what the client was told; if the two have stopped agreeing,
    // spending the row's script would spend a covenant these terms do not open.
    const derived = derive(termsOf(intent), intent.contractVersion ?? undefined)
    if (derived.pkScript.toLowerCase() !== intent.offerPkScript.toLowerCase()) {
      throw new Error(`the recorded terms derive ${derived.pkScript}, not the offer script ${intent.offerPkScript}`)
    }

    const live = await outpointsAt(intent.offerPkScript)
    const deposit = live.find((o) => o.txid === intent.depositTxid && o.vout === intent.depositVout)
    // ABOVE `fulfill`, so nothing is sent. NOT terminal: one absent read is weaker than arkd's
    // refusal, and § 9's gate re-reads next tick and ends the row itself when it is really gone.
    if (!deposit) {
      throw new OfferNotSubmittedError(
        `${intent.depositTxid}:${intent.depositVout} is no longer live at ${intent.offerPkScript}; nothing was submitted`,
      )
    }

    // The outpoint the row was moved to `funded` on, re-measured. Identical
    // terms compile to one address, so a second deposit can land beside this
    // one — spending it against a decision made about the other is the trade
    // this refuses.
    const held = heldOf(deposit, intent.fromAssetId)
    if (held < intent.fromAmount) {
      throw new Error(
        `${intent.depositTxid}:${intent.depositVout} holds ${held} of the deposit leg, ` +
          `but the quote was priced against ${intent.fromAmount}`,
      )
    }

    return fulfill(
      deps.ctx,
      deps.emulatorUrl,
      // The offer the derived script was compiled from, taker included.
      derived.offer,
      {
        txid: deposit.txid,
        vout: deposit.vout,
        // Narrowed because `OfferDepositOutpoint.value` is `number`. Safe while
        // sats are: 21M BTC is 2.1e15, well inside 2^53. Guarded rather than
        // trusted, because the solver COMPILES this packet from terms it named
        // itself, and a truncated value describes an input that does not exist.
        value: assertSafeSats(deposit.sats),
        // What vin 0 actually carries, not what was quoted: the packet declares
        // the input, and declaring an amount the input does not hold describes
        // an input that does not exist.
        assetAmount: intent.fromAssetId === null ? undefined : held,
      },
      { ...options, parent: { kind: 'rfq', id: intent.id } },
    )
  }
}
