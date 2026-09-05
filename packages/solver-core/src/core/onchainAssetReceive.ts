/**
 * `onchain:BTC->arkade:<asset>` — the client funds a Bitcoin L1 HTLC and an
 * ARKADE ASSET lands on the other side.
 *
 * The sats-out mirror is `core/onchainReceive.ts`, and every timelock rule here
 * is IMPORTED from it rather than restated. The two legs differ only in what
 * the solver pays out; a second copy of the deadline arithmetic could drift
 * into funding swaps the other refuses, which is the divergence
 * `UNILATERAL_RECOURSE_MARGIN` is shared to prevent.
 *
 * What is genuinely new is the PAYOUT UNIT. The give is sats and the payout is
 * atomic units of an asset at a decimals exponent, so the two are related only
 * through a price — and that price is fetched, directional and rounded. The
 * arithmetic is therefore not redone here either: {@link resolveAssetQuote}
 * already owns it for the arkade-to-arkade class, exactly and in integers, and
 * this corridor reuses it so one market cannot be priced two ways.
 */

import { resolveAssetQuote, type AssetQuoteMarket, type AssetQuoteRefusal } from './assetRfq.js'
import type { Price } from './priceFeed.js'
import { ASSET_ID_HEX_LENGTH } from './marketKey.js'

/**
 * The precision a price is quoted in for the BTC leg: whole BTC, not sats.
 *
 * Stated rather than passed as configuration, unlike an asset's own decimals.
 * BTC's exponent is not a deployment's choice, and letting an operator name it
 * would admit a market priced in whole-sats — off by 10^8, quoting and settling
 * the whole way.
 */
export const BTC_DECIMALS = 8

const ASSET_ID = new RegExp(`^[0-9a-f]{${ASSET_ID_HEX_LENGTH}}$`)
const ONCHAIN_ASSET_PAIR = new RegExp(`^onchain:BTC->arkade:([0-9a-f]{${ASSET_ID_HEX_LENGTH}})$`)

/** The corridor string for one served asset. */
export const onchainAssetReceivePairFor = (assetId: string): string => {
  if (!ASSET_ID.test(assetId)) {
    throw new Error(`asset id must be ${ASSET_ID_HEX_LENGTH} LOWERCASE hex characters, got ${JSON.stringify(assetId)}`)
  }
  return `onchain:BTC->arkade:${assetId}`
}

/**
 * The asset a pair names, or null when it is not this corridor's.
 *
 * Byte for byte, with no normalisation, for the reason `marketKey.ts` gives: an
 * id normalised in one layer and not another derives the right market and is
 * then refused as unserved, with a stated reason that is a lie.
 */
export const assetOfOnchainAssetReceivePair = (pair: string): string | null =>
  ONCHAIN_ASSET_PAIR.exec(pair)?.[1] ?? null

/** One asset this deployment pays out on the onchain receive leg. */
export interface OnchainAssetMarket {
  /** Uppercase label — the env stem fragment, never the identity. */
  symbol: string
  /** Canonical 68-hex asset id: the identity, and what reaches the wire. */
  assetId: string
  /**
   * The asset's own precision, declared at ITS genesis.
   *
   * REQUIRED with no default, for the reason `evmCorridorConfig.ts` states
   * about an ERC20's: the price is quoted in whole units and the payout is
   * carried in atomic ones, so this exponent IS the relationship between them.
   * A wrong value is silent — every swap still quotes and settles, each moving
   * the wrong amount.
   */
  decimals: number
  feedUrl: string
  pricePath: string
  /** The solver's margin, taken out of the payout. */
  feeBps: number
  /**
   * Bounds on the PAYOUT, in the asset's atomic units.
   *
   * A second gate beside the corridor's sats {@link Limits}, not a replacement:
   * the sats bound already constrains the give, and the payout is derived from
   * it through the price — so this is redundant exactly while the price is what
   * the operator expects, and stops being redundant when the rate runs away.
   */
  minPayout: bigint
  maxPayout: bigint
}

export type OnchainAssetQuoteRefusal = AssetQuoteRefusal

export type OnchainAssetPayout = { ok: true; payoutUnits: bigint } | { ok: false; reason: OnchainAssetQuoteRefusal }

/**
 * What the solver will pay out, in atomic units, for a give of `giveSats`.
 *
 * EXACT-IN ONLY, inherited from {@link resolveAssetQuote} rather than decided
 * again: exact-out across two different assets means inverting a fetched,
 * rounded, directional rate, which § 7.1.5 refuses on the EVM corridors for
 * exactly this reason.
 *
 * The market is expressed with BTC as `base` so the feed's own quote-per-base
 * convention reads the way an operator writes it — an ASSET/BTC feed.
 */
export const resolveOnchainAssetPayout = (args: {
  giveSats: number
  market: OnchainAssetMarket
  feed: Price
}): OnchainAssetPayout => {
  const market: AssetQuoteMarket = {
    base: null,
    quote: args.market.assetId,
    baseDecimals: BTC_DECIMALS,
    quoteDecimals: args.market.decimals,
    feeBps: args.market.feeBps,
    minPayout: args.market.minPayout,
    maxPayout: args.market.maxPayout,
  }
  const resolved = resolveAssetQuote({
    pair: { from: null, to: args.market.assetId },
    amount: BigInt(args.giveSats),
    amountSide: 'from',
    market,
    feed: args.feed,
  })
  return resolved.ok ? { ok: true, payoutUnits: resolved.toAmount } : { ok: false, reason: resolved.reason }
}

export type OnchainAssetInventoryDecision = { fund: true } | { fund: false; reason: 'insufficient_inventory' }

/**
 * Does the float hold the payout, RIGHT NOW?
 *
 * Asked at quote time and again immediately before the lockup is funded. The
 * second ask is the load-bearing one: quoting and funding are separated by a
 * confirmation wait, and the balance can be spent down by another corridor in
 * between. Read on the leg being PAID, and on `available` rather than `total` —
 * a coin already reserved for another lockup cannot fund this one.
 */
export const evaluateOnchainAssetInventory = (args: {
  payoutUnits: bigint
  assetId: string
  available: ReadonlyMap<string, bigint>
}): OnchainAssetInventoryDecision =>
  (args.available.get(args.assetId) ?? 0n) >= args.payoutUnits
    ? { fund: true }
    : { fund: false, reason: 'insufficient_inventory' }
