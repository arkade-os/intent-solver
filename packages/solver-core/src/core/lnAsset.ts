/**
 * `lightning:BTC<->arkade:<asset>` — the pair grammar, the market an operator
 * configures, and the quote each direction resolves.
 *
 * Two legs, one module, because they differ only in WHICH SIDE IS SATS. The
 * inbound covenant is the same asset-denominated VHTLC either way and the
 * outbound rail is Lightning either way; what flips is who funds and who is paid.
 *
 * `arkade:<asset>->lightning:BTC` is issue #21's design. That issue also covers
 * `arkade:<asset>->onchain:BTC`, which differs from it ONLY in the outbound
 * rail — the way `core/send.ts` and `core/onchainSend.ts` differ today. Nothing
 * in this module is Lightning-specific, so the onchain leg should consume it
 * rather than restate it.
 *
 * Pure: no clock, no network, no store.
 */

import type { Limits } from './limits.js'
import { ASSET_ID_HEX_LENGTH } from './marketKey.js'
import { convertAmount, type Price } from './priceFeed.js'

/**
 * Which way round the asset moves.
 *
 * `receive` mirrors `lightning:BTC->arkade:BTC` — the client pays Lightning and
 * the solver funds an Arkade lockup, only denominated in an asset. `send`
 * mirrors `arkade:BTC->lightning:BTC` — the client funds the lockup and the
 * solver pays out over Lightning.
 */
export type LnAssetDirection = 'receive' | 'send'

/**
 * The corridor family this module serves.
 *
 * A template literal rather than a member of `CORRIDORS`, for the reason
 * `EvmCorridor` gives: the asset id is runtime data, so a compile-time union
 * cannot hold the set a deployment serves.
 */
export type LnAssetCorridor = `lightning:BTC->arkade:${string}` | `arkade:${string}->lightning:BTC`

/** § 2's identity rule: lowercase only. Hex is case-insensitive and this is not. */
const ASSET_ID = new RegExp(`^[0-9a-f]{${ASSET_ID_HEX_LENGTH}}$`)
const RECEIVE_PAIR = new RegExp(`^lightning:BTC->arkade:([0-9a-f]{${ASSET_ID_HEX_LENGTH}})$`)
const SEND_PAIR = new RegExp(`^arkade:([0-9a-f]{${ASSET_ID_HEX_LENGTH}})->lightning:BTC$`)

export const lnAssetPairFor = (assetId: string, direction: LnAssetDirection): LnAssetCorridor => {
  if (!ASSET_ID.test(assetId)) {
    throw new Error(`asset id must be ${ASSET_ID_HEX_LENGTH} lowercase hex characters, got ${JSON.stringify(assetId)}`)
  }
  return direction === 'receive' ? `lightning:BTC->arkade:${assetId}` : `arkade:${assetId}->lightning:BTC`
}

/** Which direction a pair string names, or null when it names neither. */
export const lnAssetDirectionOf = (pair: string): LnAssetDirection | null => {
  if (RECEIVE_PAIR.test(pair)) return 'receive'
  return SEND_PAIR.test(pair) ? 'send' : null
}

/** The asset a pair names, or null when it is not one of this family's pairs. */
export const lnAssetIdOf = (pair: string): string | null =>
  RECEIVE_PAIR.exec(pair)?.[1] ?? SEND_PAIR.exec(pair)?.[1] ?? null

/**
 * The env stem for one market and direction.
 *
 * Built from the SYMBOL, not the id: `LN_ASSET_<68 hex>_SEND` is a legal shell
 * identifier and an unusable one. Mirrors the BTC legs' `LN_SEND`/`LN_RECEIVE`
 * so an operator reads the direction the same way on both families, and is
 * prefixed distinctly from `assetRfqEnvStem`'s `ASSET_<SYM>_BUY` so one symbol
 * configured on both paths does not collide at registry composition.
 */
export const lnAssetEnvStem = (market: { symbol: string }, direction: LnAssetDirection): string =>
  `LN_ASSET_${market.symbol.toUpperCase()}_${direction === 'receive' ? 'RECEIVE' : 'SEND'}`

/**
 * BTC's precision, for the price conversion.
 *
 * Amounts on the sats leg are ATOMIC (sats) while a feed quotes a WHOLE unit, so
 * the price these markets take is `asset per whole BTC` — the same convention
 * `assetMarketConfig.ts` uses with `base: null, baseDecimals: 8`.
 */
export const BTC_DECIMALS = 8

/**
 * One market this deployment serves over Lightning, plus where its price comes
 * from.
 *
 * BASE IS BTC AND QUOTE IS THE ASSET, fixed rather than configurable, because
 * one leg of this family is always sats. `assetMarketConfig.ts` keeps them
 * orientable because both of ITS legs may be assets; here an orientation field
 * would only be a way to configure the market backwards.
 */
export interface LnAssetMarket {
  /** Canonical 68-hex asset id. */
  assetId: string
  /** Short name for the env stem and the console — `USDA`. */
  symbol: string
  /**
   * The asset's own precision. REQUIRED with no default, for the reason
   * `evmCorridorConfig.ts` gives about `decimals`: defaulting would misprice a
   * 6-decimal asset by a factor of a million million while every swap still
   * quoted and settled.
   */
  decimals: number
  /** The solver's margin. */
  feeBps: number
  /** The BTC side, in sats — the give on `receive`, the payout on `send`. */
  limits: Limits
  /**
   * The ASSET side, in its own atomic units. Absent means unbounded.
   *
   * A SECOND gate, not a replacement for {@link LnAssetMarket.limits}, exactly
   * as `EvmCorridorPolicy.tokenLimits` is: the asset amount is derived from the
   * sats bound through the price, so this is redundant while the price is what
   * the operator expects — and stops being redundant exactly when it is not.
   */
  assetLimits?: { minUnits: bigint; maxUnits: bigint }
  /**
   * How much of this asset the solver will hold before it stops quoting the
   * `send` direction, in atomic units. `null` is unbounded, which is what the
   * ERC20 legs do today.
   *
   * The only bound expressible without an oracle: the position's SATS value is
   * not answerable without a price, and `erc20Balance.ts` already refuses to
   * fabricate one. @see issue #21 § 6.
   */
  inventoryCeiling: bigint | null
  feedUrl: string
  pricePath: string
}

export type LnAssetQuoteRefusal =
  | 'unsupported_pair'
  | 'exact_out_unsupported'
  | 'price_unavailable'
  | 'fee_consumes_swap'
  | 'amount_out_of_range'

export type LnAssetReceiveQuote = { ok: true; giveSats: number; payoutAsset: bigint }
export type LnAssetSendQuote = { ok: true; giveAsset: bigint; payoutSats: number }
export type LnAssetQuoteRefused = { ok: false; reason: LnAssetQuoteRefusal }

const BPS = 10_000n

/** Both bps guards, shared so the two directions cannot drift on what a usable price is. */
const feedUnusable = (market: LnAssetMarket, feed: Price): boolean =>
  feed.mantissa <= 0n || market.feeBps < 0 || market.feeBps >= 10_000

const outsideAssetLimits = (market: LnAssetMarket, units: bigint): boolean =>
  market.assetLimits !== undefined &&
  (units < market.assetLimits.minUnits || units > market.assetLimits.maxUnits)

/**
 * How much ASSET the solver pays out for `giveSats` — the `receive` direction.
 *
 * ROUNDED DOWN, then the fee rounded UP out of it, matching `resolveAssetQuote`
 * and `feeSatsFor` rather than inventing a third convention: rounding a payout
 * up or a fee down means the solver eats the remainder on every swap.
 */
export const resolveLnAssetReceiveQuote = (args: {
  giveSats: number
  market: LnAssetMarket
  feed: Price
}): LnAssetReceiveQuote | LnAssetQuoteRefused => {
  const { giveSats, market, feed } = args
  if (feedUnusable(market, feed)) return { ok: false, reason: 'price_unavailable' }
  if (!Number.isInteger(giveSats) || giveSats <= 0) return { ok: false, reason: 'amount_out_of_range' }
  if (giveSats < market.limits.minSats || giveSats > market.limits.maxSats) {
    return { ok: false, reason: 'amount_out_of_range' }
  }

  const mid = convertAmount({
    baseAmount: BigInt(giveSats),
    price: feed,
    baseDecimals: BTC_DECIMALS,
    quoteDecimals: market.decimals,
    rounding: 'down',
  })
  const fee = (mid * BigInt(market.feeBps) + BPS - 1n) / BPS
  const payoutAsset = mid - fee
  // Not clamped, for the reason `payoutSatsFor` states: "the fee ate the swap"
  // and "the amount is out of range" want different refusals.
  if (payoutAsset <= 0n) return { ok: false, reason: 'fee_consumes_swap' }
  if (outsideAssetLimits(market, payoutAsset)) return { ok: false, reason: 'amount_out_of_range' }
  return { ok: true, giveSats, payoutAsset }
}

/**
 * How much ASSET the client must lock to be paid `payoutSats` — the `send`
 * direction, and the only one that is EXACT-OUT by construction.
 *
 * The BOLT11 fixes the payout, so the give is solved up from it rather than
 * chosen. `resolveAssetQuote` refuses exact-out for the atomic class because
 * inverting a rounded rate invents a second rounding convention; here there is
 * no alternative — an invoice cannot be paid for less than it asks — so the
 * inversion is explicit and rounded AGAINST the client, the one direction that
 * cannot leak.
 */
export const resolveLnAssetSendQuote = (args: {
  payoutSats: number
  market: LnAssetMarket
  feed: Price
}): LnAssetSendQuote | LnAssetQuoteRefused => {
  const { payoutSats, market, feed } = args
  if (feedUnusable(market, feed)) return { ok: false, reason: 'price_unavailable' }
  if (!Number.isInteger(payoutSats) || payoutSats <= 0) return { ok: false, reason: 'amount_out_of_range' }
  if (payoutSats < market.limits.minSats || payoutSats > market.limits.maxSats) {
    return { ok: false, reason: 'amount_out_of_range' }
  }

  const mid = convertAmount({
    baseAmount: BigInt(payoutSats),
    price: feed,
    baseDecimals: BTC_DECIMALS,
    quoteDecimals: market.decimals,
    rounding: 'up',
  })
  // ADDED ON TOP rather than taken out: the payout is fixed by an invoice nobody
  // may shave, so the client's give is the only side left to carry the margin.
  const fee = (mid * BigInt(market.feeBps) + BPS - 1n) / BPS
  const giveAsset = mid + fee
  if (giveAsset <= 0n) return { ok: false, reason: 'fee_consumes_swap' }
  if (outsideAssetLimits(market, giveAsset)) return { ok: false, reason: 'amount_out_of_range' }
  return { ok: true, giveAsset, payoutSats }
}

/**
 * How long a quote on this family binds, seconds.
 *
 * `docs/rfq-protocol.md` § 5 puts cross-asset windows "on the order of ~30
 * seconds", and every pair here is cross-asset: the solver is short the
 * asset/BTC rate for the whole window, so the window IS the exposure. The BTC
 * legs' 15-minute `DEFAULT_LOCKUP_TIMEOUT` would be a free 15-minute option on
 * that rate — the client watches the market and funds only if it moved their way.
 *
 * Ninety seconds rather than thirty because a client must derive, sign and
 * submit an Arkade covenant inside it. That is a risk decision (#21's open
 * question 1), so it is a named constant an operator can move rather than an
 * expression nobody can find.
 */
export const LN_ASSET_QUOTE_WINDOW = 90

/** Why an inventory check refused. */
export type LnAssetInventoryRefusal = 'insufficient_inventory' | 'inventory_ceiling_reached'

export type LnAssetInventoryDecision = { ok: true } | { ok: false; reason: LnAssetInventoryRefusal }

/**
 * Whether the asset position permits one more swap in this direction.
 *
 * The two directions ask OPPOSITE questions, and conflating them refuses for the
 * wrong reason. Paying an asset out needs enough of it to pay; taking one in
 * needs room under the ceiling to hold it. Only the first exists on the BTC legs.
 */
export const evaluateLnAssetInventory = (args: {
  direction: LnAssetDirection
  /** Spendable balance of THIS asset, atomic units — `available`, never `total`. */
  held: bigint
  /** Atomic units this swap pays out (`receive`) or takes in (`send`). */
  amount: bigint
  ceiling: bigint | null
}): LnAssetInventoryDecision => {
  if (args.direction === 'receive') {
    return args.held < args.amount ? { ok: false, reason: 'insufficient_inventory' } : { ok: true }
  }
  if (args.ceiling === null) return { ok: true }
  return args.held + args.amount > args.ceiling ? { ok: false, reason: 'inventory_ceiling_reached' } : { ok: true }
}
