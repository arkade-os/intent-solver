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
import { selectCoinsWithAsset, selectVirtualCoins, type ExtendedVirtualCoin } from '@arkade-os/sdk'
import { RFQ_ASSET_SWAP_DIRECTED, RFQ_ASSET_SWAP_DIRECTED_NONCE } from '@arkade-os/solver-core/core/rfqContract.js'
import type { ArkadeContext } from './wallet.js'
import { fulfillOffers, type BatchOfferFill, type BatchOfferSubmitOptions } from './batchOfferFulfill.js'
import { assetsOn, fulfillOffer, OfferNotSubmittedError, type FulfillOptions } from './offerFulfill.js'
import { heldOf } from './offerFill.js'
import { outpointKey } from './lockupFunding.js'
import { liveOfferOutpoints, type OfferOutpoint } from './offerOutpoints.js'
import { offerScriptFrom, type OfferDerivation, type QuotedOfferTerms } from './offerTerms.js'

const assertSafeSats = (sats: bigint): number => {
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`deposit of ${sats} sats exceeds a safe integer`)
  return Number(sats)
}

/** The negotiated row, structurally. `AssetRfqSwapRow` satisfies it. */
export interface QuotedOfferIntent {
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
  /** The negotiated contract version; null is the baseline, asset-swap-v2. */
  contractVersion: string | null
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
})

const prepareQuotedOfferFor = (
  deps: QuotedOfferSettleDeps,
): ((intent: QuotedOfferIntent) => Promise<BatchOfferFill>) => {
  const outpointsAt = deps.outpointsAt ?? ((pkScript: string) => liveOfferOutpoints(deps.ctx, pkScript))
  const derive = offerScriptFrom(deps.derivation)

  return async (intent) => {
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

    return {
      offer: derived.offer,
      deposit: {
        txid: deposit.txid,
        vout: deposit.vout,
        value: assertSafeSats(deposit.sats),
        assetAmount: intent.fromAssetId === null ? undefined : held,
      },
    }
  }
}

export const quotedOfferSettleFor = (
  deps: QuotedOfferSettleDeps,
): ((intent: QuotedOfferIntent, options?: FulfillOptions) => Promise<string>) => {
  const prepare = prepareQuotedOfferFor(deps)
  const fulfill = deps.fulfill ?? fulfillOffer
  return async (intent, options) => {
    const { offer, deposit } = await prepare(intent)
    return fulfill(deps.ctx, deps.emulatorUrl, offer, deposit, options)
  }
}

/** Settle funded RFQs after the caller checks action-time eligibility and approval for each row. */
export const quotedOffersSettleFor = (
  deps: Omit<QuotedOfferSettleDeps, 'fulfill'>,
): ((intents: readonly QuotedOfferIntent[], options?: BatchOfferSubmitOptions) => Promise<string>) => {
  const prepare = prepareQuotedOfferFor(deps)
  const { ctx, emulatorUrl } = deps
  return async (intents, options) => {
    if (intents.length < 2) throw new OfferNotSubmittedError('a grouped fill needs at least two offers')
    if (
      intents.some(
        ({ contractVersion }) =>
          contractVersion !== RFQ_ASSET_SWAP_DIRECTED && contractVersion !== RFQ_ASSET_SWAP_DIRECTED_NONCE,
      )
    ) {
      throw new OfferNotSubmittedError('a grouped fill requires directed offer covenants')
    }

    const fills = await Promise.all(intents.map(prepare))
    const spendable = (await ctx.wallet.getSpendableVtxos()) as ExtendedVirtualCoin[]
    const reserved = ctx.reservations.reserved()
    const available = new Map(
      spendable
        .filter((coin) => !reserved.has(outpointKey(coin.txid, coin.vout)))
        .map((coin) => [outpointKey(coin.txid, coin.vout), { ...coin, assets: assetsOn(coin) }]),
    )
    const wanted = new Map<string, bigint>()
    let makerSats = 0n
    let depositSats = 0n
    for (const { offer, deposit } of fills) {
      const assetId = offer.wantAsset?.toString()
      if (assetId !== undefined) wanted.set(assetId, (wanted.get(assetId) ?? 0n) + offer.wantAmount)
      makerSats += assetId === undefined ? offer.wantAmount : ctx.dustSats
      depositSats += BigInt(deposit.value)
      available.delete(outpointKey(deposit.txid, deposit.vout))
    }

    const selected: ExtendedVirtualCoin[] = []
    const select = (coins: ExtendedVirtualCoin[]) => {
      selected.push(...coins)
      for (const coin of coins) available.delete(outpointKey(coin.txid, coin.vout))
    }
    try {
      for (const [assetId, amount] of wanted) {
        const held = selected.reduce(
          (sum, coin) => sum + (coin.assets?.find((a) => a.assetId === assetId)?.amount ?? 0n),
          0n,
        )
        if (held < amount) select(selectCoinsWithAsset([...available.values()], assetId, amount - held).selected)
      }
      const minOutputSats = ctx.dustSats > ctx.vtxoMinSats ? ctx.dustSats : ctx.vtxoMinSats
      const changeTopUp = depositSats < minOutputSats ? minOutputSats - depositSats : 0n
      const neededSats = makerSats + changeTopUp - selected.reduce((sum, coin) => sum + BigInt(coin.value), 0n)
      if (neededSats > 0n) select(selectVirtualCoins([...available.values()], assertSafeSats(neededSats)).inputs)
    } catch (error) {
      throw new OfferNotSubmittedError('insufficient spendable wallet funding for the grouped fill', { cause: error })
    }
    return fulfillOffers(
      ctx,
      emulatorUrl,
      fills,
      selected.map((coin) => ({
        txid: coin.txid,
        vout: coin.vout,
        value: coin.value,
        tapLeafScript: coin.forfeitTapLeafScript,
        tapTree: coin.tapTree,
        assets: assetsOn(coin),
      })),
      options,
    )
  }
}
