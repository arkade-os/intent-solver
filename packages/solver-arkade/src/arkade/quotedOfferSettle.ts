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
 * needs: a human.
 */
import { hex } from '@scure/base'
import type { ArkadeContext } from './wallet.js'
import { fulfillOffer } from './offerFulfill.js'
import { heldOnOutpoint, liveOfferOutpoints, type OfferOutpoint } from './offerOutpoints.js'
import {
  offerFromTerms,
  offerScriptFrom,
  xOnlyPubkey,
  type OfferDerivation,
  type QuotedOfferTerms,
} from './offerTerms.js'

/** The negotiated row, structurally. `AssetRfqSwapRow` satisfies it. */
export interface QuotedOfferIntent {
  offerPkScript: string
  fromAssetId: string | null
  fromAmount: bigint
  toAssetId: string | null
  toAmount: bigint
  makerPkScript: string
  makerPublicKey: string
  depositTxid: string | null
  depositVout: number | null
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
})

export const quotedOfferSettleFor = (
  deps: QuotedOfferSettleDeps,
): ((intent: QuotedOfferIntent) => Promise<string>) => {
  const outpointsAt = deps.outpointsAt ?? ((pkScript: string) => liveOfferOutpoints(deps.ctx, pkScript))
  const fulfill = deps.fulfill ?? fulfillOffer
  const derive = offerScriptFrom(deps.derivation)
  // The same normalisation `offerScriptFrom` applies, or the offer handed to
  // `fulfillOffer` would carry a key the derived script was not compiled from.
  const emulatorPubkey = xOnlyPubkey(deps.derivation.emulatorPubkey)

  return async (intent) => {
    if (intent.depositTxid === null || intent.depositVout === null) {
      throw new Error(`the negotiation at ${intent.offerPkScript} records no deposit outpoint to spend`)
    }

    // Derived, never read off the row. The row's terms are what was quoted and
    // its script is what the client was told; if the two have stopped agreeing,
    // spending the row's script would spend a covenant these terms do not open.
    const derived = derive(termsOf(intent))
    if (derived.pkScript.toLowerCase() !== intent.offerPkScript.toLowerCase()) {
      throw new Error(`the recorded terms derive ${derived.pkScript}, not the offer script ${intent.offerPkScript}`)
    }

    const live = await outpointsAt(intent.offerPkScript)
    const deposit = live.find((o) => o.txid === intent.depositTxid && o.vout === intent.depositVout)
    if (!deposit) {
      throw new Error(`${intent.depositTxid}:${intent.depositVout} is no longer live at ${intent.offerPkScript}`)
    }

    // The outpoint the row was moved to `funded` on, re-measured. Identical
    // terms compile to one address, so a second deposit can land beside this
    // one — spending it against a decision made about the other is the trade
    // this refuses.
    const held = heldOnOutpoint(deposit, intent.fromAssetId)
    if (held < intent.fromAmount) {
      throw new Error(
        `${intent.depositTxid}:${intent.depositVout} holds ${held} of the deposit leg, ` +
          `but the quote was priced against ${intent.fromAmount}`,
      )
    }

    return fulfill(
      deps.ctx,
      deps.emulatorUrl,
      { ...offerFromTerms(termsOf(intent), emulatorPubkey), swapPkScript: hex.decode(derived.pkScript) },
      {
        txid: deposit.txid,
        vout: deposit.vout,
        value: Number(deposit.sats),
        // What vin 0 actually carries, not what was quoted: the packet declares
        // the input, and declaring an amount the input does not hold describes
        // an input that does not exist.
        assetAmount: intent.fromAssetId === null ? undefined : held,
      },
    )
  }
}
