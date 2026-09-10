/**
 * Settle an offer: spend the maker's deposit through its fulfill leaf, paying
 * the maker what the covenant obliges, in one Ark transaction.
 *
 * Swap Protocol V1 § 4. The covenant is what makes this trustless for the
 * maker: the fulfill leaf's second key is the emulator's, tweaked by a commitment
 * to `FulfillScript`, so the emulator's signature is only obtainable for a
 * transaction whose outputs satisfy that script. A wrong destination or a short
 * value is refused by the emulator — that is the security model working, not an
 * error to route around.
 *
 * **The spend itself is the SDK's `fillOffer`, not ours.** This module used to
 * assemble it — inputs, outputs, prevout proofs, the asset packet, the emulator
 * packet, signing, submission — against the same covenant the SDK targets. Two
 * implementations of one covenant is a standing risk that only shows up as a
 * transaction arkd will not accept, so the assembly is now upstream's.
 *
 * What stays here is what upstream deliberately refuses to do:
 *
 * - **Coin selection.** `fillOffer` requires `fund` explicitly, on the grounds
 *   that only the caller knows which coins are reserved. That is exactly this
 *   solver's problem — `getSpendableVtxos` is gated so `offerInventory` can keep
 *   the escrowed and locked buckets out of the float a fill was admitted against.
 * - **The § 5.1 abort.** Re-checked here rather than trusted from the caller,
 *   because this is the function that spends.
 */
import { selectVirtualCoins, selectCoinsWithAsset, type ExtendedVirtualCoin } from '@arkade-os/sdk'
import { ASSET_CARRIER_SATS, encodeOffer, fillOffer, type FillFunding, type Offer } from '@arkade-os/swap'
import { hex } from '@scure/base'
import { type ArkadeContext } from './wallet.js'
import { offerIsConsistent } from './offerConsistency.js'

/** The dust carrier output[0] takes when the maker is paid in an ASSET, not sats.
 * Re-exported from the SDK rather than restated: it is a covenant constant, and a
 * second copy here diverges silently the day upstream changes it. */
export { ASSET_CARRIER_SATS }

export interface OfferDepositOutpoint {
  txid: string
  vout: number
  value: number
  /**
   * How much of the offer's asset this deposit holds, OBSERVED at the script.
   *
   * NOT read by the fill any more — `fillOffer` reads the deposit's assets off
   * chain itself, which is the better source. It stays because `offerSettle`
   * computes it to refuse a deposit holding less than the intent was priced
   * against, and that guard runs before this is ever called.
   */
  assetAmount?: bigint
}

/**
 * Fulfil one offer and return the settled ark txid.
 *
 * Both directions: an asset-wanting maker is paid through the asset packet with
 * a 330-sat carrier at output[0], and an asset DEPOSIT is routed to us the same
 * way. Exactly one leg names an asset (§ 2.1), and both being set is refused.
 */
export const fulfillOffer = async (
  ctx: ArkadeContext,
  emulatorUrl: string,
  offer: Offer,
  deposit: OfferDepositOutpoint,
): Promise<string> => {
  const serverPubkey = ctx.wallet.arkServerPublicKey
  if (!offerIsConsistent(offer, serverPubkey)) {
    // § 5.1: a taker MUST abort on mismatch. Checked again here rather than
    // trusted from the caller, because this is the function that spends.
    throw new Error('offer inconsistency: the script does not encode the stated terms')
  }
  if (offer.wantAsset !== undefined && offer.offerAsset !== undefined) {
    throw new Error('an offer names an asset on exactly one leg, not both')
  }

  // What the covenant obliges output[0] to carry, and the whole reason the
  // emulator will co-sign.
  const wantAmount = offer.wantAmount

  // Our own coins fund the maker payment; the deposit itself comes back to us.
  const wantedAssetId = offer.wantAsset?.toString()
  // GATED, as `fundLockup` reads it: `getVtxos` carries the escrowed and locked buckets
  // `offerInventory.ts` keeps out of the float this fill was admitted against.
  const spendable = (await ctx.wallet.getSpendableVtxos()) as ExtendedVirtualCoin[]

  // What output[0] must carry in SATS. An asset-wanting maker is paid through
  // the asset packet, so its BTC leg is only the dust carrier (§ 4.1).
  const makerSats = wantedAssetId === undefined ? wantAmount : ASSET_CARRIER_SATS

  // Coins that carry the wanted ASSET when there is one, otherwise coins that
  // carry enough sats. Either way this is what funds the maker.
  let funding: ExtendedVirtualCoin[]
  try {
    if (wantedAssetId === undefined) {
      funding = selectVirtualCoins(spendable, Number(makerSats)).inputs ?? []
    } else {
      // Only the coins are taken from the helper. The surplus it gathered above
      // `wantAmount` is ours, and `fillOffer` routes it back by deriving the
      // taker's side from what the declared inputs carry — a subtraction here
      // would duplicate a job already discharged there.
      funding = selectCoinsWithAsset(spendable, wantedAssetId, wantAmount).selected
    }
  } catch (error) {
    const held = spendable.reduce((total, coin) => total + BigInt(coin.value), 0n)
    throw new Error(
      `no spendable coins to pay the maker ${wantAmount} ${wantedAssetId ?? 'sats'} (holding ${held} sats): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (funding.length === 0) throw new Error(`no spendable coins to pay the maker ${wantAmount} sats`)

  return await fillOffer(ctx.wallet, ctx.arkServerUrl, hex.encode(encodeOffer(offer)), {
    // Inputs 1..n, in this order. Every asset a coin carries is declared, not
    // just the two the swap is about: arkd refuses with ASSET_NOT_FOUND when an
    // input owns an asset the packet does not mention, and selection picks for
    // sats or for the wanted asset — whatever else rides along comes too.
    fund: funding.map((coin): FillFunding => ({
      txid: coin.txid,
      vout: coin.vout,
      value: coin.value,
      tapLeafScript: coin.forfeitTapLeafScript,
      tapTree: coin.tapTree,
      assets: assetsOn(coin),
    })),
    // The deposit this fill was admitted against. Identical offers share one
    // address, so without it `fillOffer` refuses rather than guessing.
    fundingTxid: deposit.txid,
    emulator: emulatorUrl,
    // No `emulatorPubkey`: that override is 33-byte COMPRESSED and an offer
    // carries the x-only 32, which cannot be widened — the parity bit is not in
    // it. It only ever names the client's own key anyway; the covenant here is
    // rebuilt from the offer's, and a mismatch fails loudly against
    // `swapPkScript` rather than silently.
  })
}

/** The maker's script, hex, for logging a fill against its offer. */
export const makerScriptHex = (offer: Offer): string => hex.encode(offer.makerPkScript)

/**
 * Assets a coin carries, normalised.
 *
 * `getVtxos` reports asset amounts as STRINGS while the contract manager
 * reports bigints, and an asset amount is 256-bit — so the string form is the
 * one that must not go near a `number`.
 */
const assetsOn = (coin: ExtendedVirtualCoin): { assetId: string; amount: bigint }[] => {
  const assets = (coin as unknown as { assets?: { assetId: string; amount: bigint | string }[] }).assets ?? []
  return assets
    .map((entry) => ({ assetId: entry.assetId, amount: BigInt(entry.amount) }))
    .filter((entry) => entry.amount > 0n)
}
