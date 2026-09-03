/**
 * The `settle` port `ops/assetOffers.ts` injects: a recorded intent in, a fill
 * txid out.
 *
 * `fulfillOffer` builds and submits the spend and needs the OFFER — the maker's
 * script, their key, the emulator's — while an `offer_fill` row stores only the
 * terms. That is deliberate on the store's side ("the covenant is derived from
 * those values, so a row that could edit them could describe a contract that
 * was never funded"), and it leaves exactly one honest way back: re-read the
 * funding transaction the row is keyed to and decode the packet again.
 *
 * WHICH MAKES THIS FILE THE JOIN, and the join is where the two can disagree.
 * The row is what `consider()` priced; the transaction is what will actually be
 * spent. Every guard below is one way those two can differ, and every one of
 * them refuses BEFORE `fulfillOffer` — a mismatch discovered afterwards is a
 * spend, not a refusal. None of them can be reached through `consider()` alone;
 * they are tripwires on someone else's deposit, not error handling.
 *
 * A throw is the right shape for all of them. `tickAll` moves the row from
 * `filling` to `stuck` on a throw, and `stuck` means "needs a human" — which is
 * precisely what a row disagreeing with the chain needs.
 *
 * MONEY PATH, AND UNEXERCISED AGAINST REAL FUNDS. The guards are unit-pinned
 * below; the spend they gate is only ever executed by
 * `test/e2e/assetOffer.e2e.test.ts` against a live Arkade Service.
 */
import { hex } from '@scure/base'
import type { ArkadeContext } from './wallet.js'
import { offerFromFundingTx } from './offerPacket.js'
import { offerFillInputFrom } from './offerFill.js'
import { fulfillOffer } from './offerFulfill.js'

/**
 * The recorded intent, structurally.
 *
 * Not `OfferFillRow`: that type lives in `solver-corridors`, which depends on
 * this package rather than the other way round. These fields are the whole
 * dependency, and `OfferFillRow` satisfies them.
 */
export interface OfferFillIntent {
  offerTxid: string
  offerVout: number
  offerPkScript: string
  wantAssetId: string | null
  wantAmount: bigint
  offerAssetId: string | null
  offerAmount: bigint
}

export interface OfferSettleDeps {
  ctx: ArkadeContext
  emulatorUrl: string
  /**
   * The funding transaction as base64 PSBT, or null when the source has none.
   *
   * Defaults to the wallet's own indexer, which is where `fulfillOffer` reads
   * its prevouts from — so settlement proves the prevout twice against one view
   * rather than deciding against a second.
   */
  fetchTx?: (txid: string) => Promise<string | null>
  /** Injected so the guards are testable without an Arkade Service. */
  fulfill?: typeof fulfillOffer
}

/** One virtual transaction from the wallet's indexer, or null. */
const indexerTxSource =
  (ctx: ArkadeContext) =>
  async (txid: string): Promise<string | null> => {
    const { txs } = await ctx.wallet.indexerProvider.getVirtualTxs([txid])
    return txs[0] ?? null
  }

/**
 * Bind a settle port to this deployment's wallet and emulator.
 *
 * Curried rather than a four-argument call because `AssetOfferDeps.settle` is a
 * one-argument port: the row is the only thing that varies per fill.
 */
export const offerSettleFor = (deps: OfferSettleDeps): ((intent: OfferFillIntent) => Promise<string>) => {
  const fetchTx = deps.fetchTx ?? indexerTxSource(deps.ctx)
  const fulfill = deps.fulfill ?? fulfillOffer

  return async (intent) => {
    const raw = await fetchTx(intent.offerTxid)
    if (raw === null || raw === '') {
      throw new Error(`no funding transaction for ${intent.offerTxid}: the offer cannot be rebuilt to fill it`)
    }

    const found = offerFromFundingTx(raw)
    if (found === null) {
      throw new Error(`${intent.offerTxid} carries no offer this taker can decode`)
    }
    if (found.txid !== intent.offerTxid) {
      throw new Error(`${found.txid} is not the funding transaction ${intent.offerTxid} this intent was recorded on`)
    }
    if (found.vout !== intent.offerVout) {
      throw new Error(
        `the offer's deposit is at vout ${found.vout}, but the intent was recorded on ${intent.offerVout}`,
      )
    }
    if (hex.encode(found.offer.swapPkScript).toLowerCase() !== intent.offerPkScript.toLowerCase()) {
      throw new Error(`${intent.offerTxid} funds a different offer script than the intent was recorded against`)
    }

    // The packet's terms, read through the SAME adapter the decision read them
    // through, so a change in how an asset id is spelled cannot make these
    // comparisons pass for the wrong reason. `offerAmount` here is the sats at
    // the outpoint — `heldOf` returns the deposit's sats when the deposit leg is
    // BTC, and 0 when it names an asset this deposit view does not carry.
    const terms = offerFillInputFrom(found.offer, { sats: BigInt(found.value) })
    if (terms.wantAmount !== intent.wantAmount) {
      throw new Error(
        `${intent.offerTxid} wants ${terms.wantAmount}, but the intent was priced at ${intent.wantAmount}`,
      )
    }
    if (terms.wantAssetId !== intent.wantAssetId) {
      throw new Error(
        `${intent.offerTxid} names want asset ${terms.wantAssetId ?? 'BTC'}, not ${intent.wantAssetId ?? 'BTC'}`,
      )
    }
    if (terms.offerAssetId !== intent.offerAssetId) {
      throw new Error(
        `${intent.offerTxid} names deposit asset ${terms.offerAssetId ?? 'BTC'}, not ${intent.offerAssetId ?? 'BTC'}`,
      )
    }

    // A ROW CAN BE PRICED AGAINST MORE THAN THE OUTPOINT HOLDS.
    // `offerDepositFrom` sums every live output at the offer's script, and
    // identical offers derive an identical address — so two deposits at one
    // script are summed into a decision that only ever spends one of them. The
    // fill still pays `wantAmount` in full, so the shortfall is ours.
    //
    // Only the SATS side is checked, because only the sats side is observable
    // from the funding transaction: an output's asset amounts live in the asset
    // packet, keyed to receivers positionally, not on the output. An asset
    // deposit that over-counts is caught one layer down instead, where arkd
    // refuses a packet declaring more than its inputs carry — a refusal, which
    // leaves the row `stuck`, rather than a loss.
    if (terms.offerAssetId === null && terms.offerAmount < intent.offerAmount) {
      throw new Error(
        `${intent.offerTxid}:${found.vout} holds ${terms.offerAmount} sats, ` +
          `but the intent was priced against ${intent.offerAmount}`,
      )
    }

    return fulfill(deps.ctx, deps.emulatorUrl, found.offer, {
      txid: found.txid,
      vout: found.vout,
      value: found.value,
      // OBSERVED at decision time and carried on the row. Omitted for a BTC
      // deposit: `assetAmount` is what vin 0 is declared to hold, and declaring
      // an asset a sats deposit does not carry describes an input that does not
      // exist.
      assetAmount: intent.offerAssetId === null ? undefined : intent.offerAmount,
    })
  }
}
