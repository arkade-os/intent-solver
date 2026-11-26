/**
 * Settle an offer: spend the maker's deposit through its fulfill leaf, paying
 * the maker what the covenant obliges, in one Arkade transaction.
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
import {
  ASSET_CARRIER_SATS,
  bindingFromOffer,
  fillOffer,
  NoSpendableDepositError,
  type FillFunding,
  type Offer,
} from '@arkade-os/swap/protocol'
import { hex } from '@scure/base'
import { type ArkadeContext } from './wallet.js'
import { outpointKey } from './lockupFunding.js'
import { offerIsConsistent } from './offerConsistency.js'
import { depositSpentBy, type DepositSpendProbe } from './depositSpend.js'

/** The dust carrier output[0] takes when the maker is paid in an ASSET, not sats.
 * Re-exported from the SDK rather than restated: it is a covenant constant, and a
 * second copy here diverges silently the day upstream changes it. */
export { ASSET_CARRIER_SATS }

/**
 * A fill refusal that provably submitted nothing, so a caller holding the row in
 * `filling` may walk it back. Raised only ABOVE `fillOffer` — the call that
 * builds AND submits — at the taker check, the two coin-selection refusals below and at each
 * settle adapter's deposit-liveness guard. The other guards stay plain on
 * purpose: they mean the row disagrees with the chain, which needs a human.
 * @see FundNotSubmittedError, the same boundary on receive.
 */
export class OfferNotSubmittedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OfferNotSubmittedError'
  }
}

/** A fill that provably reached no chain from BELOW the latch — arkd refusing it, or the SDK
 * refusing to build it. `depositSpent` is the stronger claim on top: arkd NAMED the deposit as
 * already spent. NOT a subclass of {@link OfferNotSubmittedError}, whose walk-back no-ops here,
 * so the callers' existing arms would catch it and stick the row. */
export class OfferSubmitRejectedError extends Error {
  /** Named by a probe, never by arkd's refusal. The row's owner rules out our own
   * fill before ending the row on it. @see depositSpentBy */
  readonly spentBy?: string
  constructor(
    message: string,
    readonly spentOutpoints: readonly string[],
    readonly depositSpent: boolean,
    options?: { cause?: unknown; spentBy?: string },
  ) {
    super(message, options)
    this.name = 'OfferSubmitRejectedError'
    this.spentBy = options?.spentBy
  }
}

/** Names no culprit (another taker, the maker's `cancel`, our other watcher): the RFQ
 * path publishes it to the client verbatim. */
export const DEPOSIT_SPENT_REASON = 'the deposit was already spent by another transaction; this fill sent nothing'

const SUBMIT_FAILURE_PREFIX = 'Failed to submit tx to emulator: '

/** arkd flattens metadata through `fmt.Sprintf("%v", …)`, so `vtxo_outpoints` arrives as a
 * Go slice, `[txid:0 txid:1]`, unquoted. A JSON array parses too. */
const outpointsIn = (metadata: Record<string, unknown> | undefined): string[] => {
  const many = metadata?.vtxo_outpoints
  const listed = Array.isArray(many)
    ? many.map((entry) => String(entry))
    : typeof many === 'string'
      ? many.replace(/^\[|\]$/g, '').split(/[\s,]+/)
      : []
  const cleaned = listed.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '')
  if (cleaned.length > 0) return cleaned
  const one = metadata?.vtxo_outpoint
  return typeof one === 'string' && one.trim() !== '' ? [one.trim().toLowerCase()] : []
}

/** Null for anything but a parsed `VTXO_ALREADY_SPENT` entry: it is read off the structured
 * detail, never the prose, which is a format string in arkd. */
const spentOutpointsIn = (error: unknown): string[] | null => {
  if (!(error instanceof Error) || !error.message.startsWith(SUBMIT_FAILURE_PREFIX)) return null
  let body: unknown
  try {
    body = JSON.parse(error.message.slice(SUBMIT_FAILURE_PREFIX.length))
  } catch {
    return null
  }
  const details = (body as { details?: unknown } | null)?.details
  if (!Array.isArray(details)) return null
  for (const detail of details) {
    const entry = detail as { code?: unknown; name?: unknown; metadata?: Record<string, unknown> } | null
    // BOTH: arkd sets the two off one registry entry, and codes 4, 7, 8 and 9
    // carry this very metadata shape for entirely different facts.
    if (entry?.name !== 'VTXO_ALREADY_SPENT' || Number(entry?.code) !== 6) continue
    const outpoints = outpointsIn(entry?.metadata)
    if (outpoints.length > 0) return outpoints
  }
  return null
}

export interface FulfillOptions {
  minAssetOutputSats?: bigint
  /** Overrides the wallet's own indexer for the spend probe. @see depositSpentBy */
  probe?: DepositSpendProbe
  /**
   * Claimed immediately before the submission: `false` means another attempt
   * holds the row and nothing may be sent. A throw is left untyped — a failed
   * write cannot say whether the latch landed. @see OfferFillStore.markSubmitting
   */
  markSubmitting?: () => Promise<boolean>
}

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
 * Fulfil one offer and return the settled Arkade txid.
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
  options?: FulfillOptions,
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
  // A directed deposit's `fulfill` needs this wallet's signature. Under the latch the SDK
  // refuses a foreign taker with an untyped throw, which sticks the row for a fill never sent.
  if (offer.taker !== undefined) {
    const ours = hex.encode(await ctx.wallet.identity.xOnlyPublicKey())
    if (hex.encode(offer.taker) !== ours) {
      throw new OfferNotSubmittedError(
        `${deposit.txid}:${deposit.vout} was quoted for taker ${hex.encode(offer.taker)}, not this wallet's ${ours}; nothing was submitted`,
      )
    }
  }
  // Checked against `swapPkScript` HERE: `fillOffer` compares a binding with nothing.
  const binding = bindingFromOffer(offer, serverPubkey)

  // What the covenant obliges output[0] to carry, and the whole reason the
  // emulator will co-sign.
  const wantAmount = offer.wantAmount

  // Our own coins fund the maker payment; the deposit itself comes back to us.
  const wantedAssetId = offer.wantAsset?.toString()
  // GATED, as `fundLockup` reads it: `getVtxos` carries the escrowed and locked buckets
  // `offerInventory.ts` keeps out of the float this fill was admitted against.
  const spendable = (await ctx.wallet.getSpendableVtxos()) as ExtendedVirtualCoin[]
  // The gate hides escrow but not the solver's own in-flight spends. Drop what a
  // funding or renewal has pinned, then reserve our pick below in the same turn, so
  // neither side takes the other's coins. @see arkade/reservations.ts
  const reserved = ctx.reservations.reserved()
  const free = spendable.filter((coin) => !reserved.has(outpointKey(coin.txid, coin.vout)))

  // What output[0] must carry in SATS. An asset-wanting maker is paid through
  // the asset packet, so its BTC leg is only this server's own dust (§ 4.1).
  const changeFloor = options?.minAssetOutputSats
  const carrierSats = changeFloor ?? ctx.dustSats
  const makerSats = wantedAssetId === undefined ? wantAmount : carrierSats

  // Coins that carry the wanted ASSET when there is one, otherwise coins that
  // carry enough sats. Either way this is what funds the maker.
  let funding: ExtendedVirtualCoin[]
  try {
    if (wantedAssetId === undefined) {
      funding = selectVirtualCoins(free, Number(makerSats)).inputs ?? []
    } else {
      // Only the coins are taken from the helper. The surplus it gathered above
      // `wantAmount` is ours, and `fillOffer` routes it back by deriving the
      // taker's side from what the declared inputs carry — a subtraction here
      // would duplicate a job already discharged there.
      funding = selectCoinsWithAsset(free, wantedAssetId, wantAmount).selected
      if (changeFloor !== undefined) {
        const inputsSats = funding.reduce((total, coin) => total + BigInt(coin.value), BigInt(deposit.value))
        // The maker payout and solver change each carry assets and need the same sats minimum.
        const missingSats = makerSats + changeFloor - inputsSats
        if (missingSats > 0n) {
          const used = new Set(funding.map((coin) => outpointKey(coin.txid, coin.vout)))
          const rest = free.filter((coin) => !used.has(outpointKey(coin.txid, coin.vout)))
          funding = [...funding, ...selectVirtualCoins(rest, assertSafeAmount(missingSats)).inputs]
        }
      }
    }
  } catch (error) {
    const held = free.reduce((total, coin) => total + BigInt(coin.value), 0n)
    throw new OfferNotSubmittedError(
      `no spendable coins to pay the maker ${wantAmount} ${wantedAssetId ?? 'sats'} (holding ${held} sats): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
  if (funding.length === 0) throw new OfferNotSubmittedError(`no spendable coins to pay the maker ${wantAmount} sats`)

  const release = ctx.reservations.reserve(funding)
  try {
    // THE LAST AWAIT BEFORE THE SUBMISSION, and it has to be: anything awaited after
    // the latch is a window where a crash leaves a row claiming a fill never sent.
    if (options?.markSubmitting && !(await options.markSubmitting())) {
      throw new OfferNotSubmittedError(
        `another attempt already holds the fill for ${deposit.txid}:${deposit.vout}; nothing was submitted`,
      )
    }
    return await fillOffer(ctx.wallet, ctx.operatorUrl, binding, {
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
      fundingOutpoint: { txid: deposit.txid, vout: deposit.vout },
      assetCarrierSats: carrierSats,
      emulator: emulatorUrl,
      // No `emulatorPubkey`: that override is 33-byte COMPRESSED and an offer
      // carries the x-only 32, which cannot be widened — the parity bit is not in
      // it. It only ever names the client's own key anyway; the covenant here is
      // rebuilt from the offer's, and a mismatch fails loudly against
      // `swapPkScript` rather than silently.
    }).catch(async (error: unknown) => {
      // `resolveDeposit`, inside `fillOffer` nine lines above its only `send()`: nothing was
      // built, let alone sent. Absence is no proof, so ask the indexer; uncertainty leaves
      // `depositSpent` false and the caller walks the row back.
      if (error instanceof NoSpendableDepositError) {
        const outpoint = outpointKey(deposit.txid, deposit.vout)
        const spentBy = await depositSpentBy(options?.probe ?? ctx.wallet?.indexerProvider, deposit)
        throw new OfferSubmitRejectedError(
          spentBy === null
            ? `the deposit ${outpoint} was not spendable when the fill was built; nothing was submitted`
            : `the deposit ${outpoint} was spent by ${spentBy}; nothing was submitted`,
          spentBy === null ? [] : [outpoint],
          spentBy !== null,
          { cause: error, ...(spentBy === null ? {} : { spentBy }) },
        )
      }
      const spent = spentOutpointsIn(error)
      // Rethrown as it was: unclassified keeps meaning "outcome unknown".
      if (spent === null) throw error
      const depositSpent = spent.includes(outpointKey(deposit.txid, deposit.vout).toLowerCase())
      // THE SHAPE THAT PROVES NOTHING: arkd lists every already-spent input, so
      // the deposit named BESIDE a coin of ours is also what a fill of ours that
      // landed looks like. @see spec/tla OfferFill_RejectedProof.cfg
      const oursToo = funding.some((coin) => spent.includes(outpointKey(coin.txid, coin.vout).toLowerCase()))
      if (depositSpent && oursToo) throw error
      // Any other shape sent nothing, whichever input it named; only a named deposit ends the row.
      throw new OfferSubmitRejectedError(
        `arkd refused the fill: ${spent.join(', ')} already spent; nothing was submitted`,
        spent,
        depositSpent,
        { cause: error },
      )
    })
  } finally {
    // Freed on failure too, where nothing else would release the pin.
    release()
  }
}

/** The maker's script, hex, for logging a fill against its offer. */
export const makerScriptHex = (offer: Offer): string => hex.encode(offer.makerPkScript)

const assertSafeAmount = (sats: bigint): number => {
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`required funding of ${sats} sats exceeds a safe integer`)
  return Number(sats)
}

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
