/**
 * Which Arkade asset markets this deployment trades, and on what terms.
 *
 * `assetOffers.ts` already takes a `markets` list and a `pricing` list; nothing
 * ever produced them. An operator could not say "I will trade asset X against
 * BTC, off feed F, at this spread" anywhere — not in the environment, not in the
 * console — so the offer path had no served pair and no price to check against.
 * This is the record that says it, and the rules that decide whether it is one
 * this solver may act on.
 *
 * PURE. No database, no HTTP, no clock. `admin/db.ts` persists these rows and
 * `admin/routes/markets.ts` writes them; both call in here for the verdict, and
 * so does startup, so there is exactly one definition of a legal market.
 *
 * THE SAME DIALECT AS THE EVM TOKENS. `evmCorridorConfig.ts` already answered
 * "where does a price come from" for ERC20s — a feed URL plus an RFC 6901
 * pointer, the pointer derivable for known providers, and a token that cannot be
 * priced refused rather than served. Those helpers are imported rather than
 * re-implemented: a second spelling of "price_path is required" would let the
 * two halves of one deployment disagree about which feeds are usable.
 *
 * It diverges on one thing, and only one: an EVM token's terms live in the
 * ENVIRONMENT because a container's env is where a chain's addresses already
 * are, while these are CRUD in the console because an operator adds and drops
 * asset pairs as a trading decision rather than as a redeploy. They still take
 * effect only at startup — see `admin/routes/settings.ts` for why nothing in a
 * running solver re-reads its policy.
 */

import { BPS_DENOMINATOR } from './assetOfferPrice.js'
import { ASSET_ID_HEX_LENGTH, marketKeyForPair } from './marketKey.js'
import { defaultPricePath, validatePricePath } from './priceFeed.js'

/**
 * A payout bound for one direction, in the WANT leg's atomic units.
 *
 * `max: 0n` DISABLES that direction rather than meaning unbounded, which is the
 * reading `ops/assetOffers.ts` already gives it — so a market can be one-way
 * without being two rows.
 */
export interface AssetMarketBounds {
  min: bigint
  max: bigint
}

/**
 * One market, as an operator states it.
 *
 * `null` is the BTC leg throughout, matching how an offer packet omits the asset
 * field rather than naming a BTC id.
 *
 * `base` and `quote` are DIRECTIONAL even though a market is not, because the
 * feed quotes quote-per-base: which leg is which decides the comparison in
 * `offerWithinTolerance`, so it is stated rather than inferred from the order
 * two ids happened to be typed in.
 */
export interface AssetMarketConfig {
  base: string | null
  quote: string | null
  /** Each leg's own precision. A price is quoted in WHOLE units; amounts are atomic. */
  baseDecimals: number
  quoteDecimals: number
  /** Where the price comes from, fetched per offer. */
  feedUrl: string
  /** RFC 6901 pointer into the response. Empty means "derive it" — see {@link defaultPricePath}. */
  pricePath: string
  /** Deviation from the feed this solver will accept. */
  toleranceBps: number
  /** The solver's margin, folded into the offer price against the maker. */
  feeBps: number
  /** Payout bounds per direction, or null to inherit the deployment-wide pair. */
  sellBase: AssetMarketBounds | null
  buyBase: AssetMarketBounds | null
  /**
   * Whether this market is served at all.
   *
   * A pause that is not a delete, matching `EvmCorridorPolicy.enabled`: an
   * operator stopping a pair for an afternoon should not have to retype a
   * 68-character asset id to start it again.
   */
  enabled: boolean
}

/**
 * The widest precision a leg may declare — the same bound `convertAmount`
 * enforces, for the reason `evmCorridorConfig.ts` states: a value past it would
 * be refused there instead, mid-decision, after the market had been accepted.
 */
const MAX_DECIMALS = 36

/** § 2's identity rule for an Arkade asset id, verbatim. Lowercase only; hex is case-insensitive and this is not. */
const ASSET_ID = new RegExp(`^[0-9a-f]{${ASSET_ID_HEX_LENGTH}}$`)

/**
 * The § 2 pair string for a market's two legs, arbitrarily oriented.
 *
 * `BTC` rather than an id for the sats leg, because that is the ticker
 * `marketKeyForPair` resolves through the § 2 asset registry.
 */
const pairStringFor = (base: string | null, quote: string | null): string =>
  `arkade:${base ?? 'BTC'}->arkade:${quote ?? 'BTC'}`

/**
 * A market's identity: the canonical § 2 market key, DERIVED from its legs.
 *
 * Derived rather than chosen, and order-free, and both properties are doing
 * work:
 *
 * - Order-free means one market cannot be stored twice with its legs swapped.
 *   `AssetOfferService.withinTolerance` picks its market with `pricing.find()`,
 *   so the FIRST match wins silently — two rows for one pair would make which
 *   feed and which spread applies a coin flip decided by row order. The same
 *   hazard `evmCorridorConfig.ts` names for a token's market: two feeds for one
 *   pair let the two directions disagree about the price, which is an arbitrage
 *   against the solver by whoever notices first.
 * - Derived means the key can never describe a pair other than the one the row's
 *   own columns hold, which a hand-chosen id could.
 *
 * It is also the string the open-RFQ subscription already derives, so the market
 * an operator configures and the market key they see on the wire are one value
 * rather than two that have to be reconciled.
 */
export const assetMarketKey = (base: string | null, quote: string | null): string =>
  marketKeyForPair(pairStringFor(base, quote))

const legName = (leg: string | null): string => leg ?? 'BTC'

const checkLeg = (label: string, leg: string | null): void => {
  if (leg === null) return
  if (!ASSET_ID.test(leg)) {
    throw new Error(
      `${label} must be null for the BTC leg or a lowercase ${ASSET_ID_HEX_LENGTH}-character Arkade asset id, ` +
        `got ${JSON.stringify(leg)}`,
    )
  }
}

const checkDecimals = (label: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DECIMALS) {
    throw new Error(`${label} must be an integer in 0..${MAX_DECIMALS}, got ${JSON.stringify(value)}`)
  }
}

/**
 * Both bps knobs, against the EXCLUSIVE ceiling `offerWithinTolerance` itself
 * uses.
 *
 * The ceiling is the whole reason this check exists, and it is not tidiness. At
 * `BPS_DENOMINATOR` the `buy_base` comparison is made against
 * `feed * (BPS - tolerance)`: the factor reaches zero, `right` goes with it, and
 * `left >= right` is trivially true — the solver accepts ANY buy_base offer at
 * ANY price. That was shipped once. Storing such a market would be storing the
 * gate switched off, so it is refused where the operator can still see why,
 * rather than left for the runtime to refuse silently on every offer.
 *
 * The bound is IMPORTED, never restated, so this cannot become weaker than the
 * guard it stands in front of.
 */
const checkBps = (label: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0 || value >= BPS_DENOMINATOR) {
    throw new Error(
      `${label} must be an integer in 0..${BPS_DENOMINATOR - 1}; ${BPS_DENOMINATOR} is a 100% band, which is the ` +
        `price gate switched off rather than a configuration. Got ${JSON.stringify(value)}`,
    )
  }
}

const checkBounds = (label: string, bounds: AssetMarketBounds | null): void => {
  if (bounds === null) return
  if (bounds.min < 0n || bounds.max < 0n) {
    throw new Error(`${label} bounds must not be negative, got ${bounds.min}..${bounds.max}`)
  }
  // `min > max` admits no amount at all, which is indistinguishable at run time
  // from a market nobody is offering into. `max: 0n` is the SUPPORTED way to
  // close a direction and stays legal.
  if (bounds.min > bounds.max) {
    throw new Error(`${label} minimum ${bounds.min} may not exceed its maximum ${bounds.max}`)
  }
}

/**
 * Refuse a market this solver must not act on, naming the reason. Throws;
 * returns nothing.
 *
 * Called from THREE places, deliberately:
 *
 * - before a write, so a refused market is never persisted. `routes/settings.ts`
 *   states the rule for overrides and it is the same one here: a stored market
 *   that is silently ignored on load is the worst of both, because the console
 *   shows it as configured while the solver prices on something else.
 * - at startup, because a row can outlive the rules that admitted it — a
 *   hand-edited database, or a bound this file tightened in a later release.
 * - in {@link assetMarketPolicy}, which is what startup actually calls.
 *
 * NO NETWORK. Whether the feed answers is a separate question with a separate
 * answer at each of those moments; see {@link assetMarketPolicy}.
 */
export const validateAssetMarket = (market: AssetMarketConfig): void => {
  checkLeg('base', market.base)
  checkLeg('quote', market.quote)
  if (market.base === market.quote) {
    throw new Error(`a market names ${legName(market.base)} on both legs; the two legs must differ`)
  }
  checkDecimals('baseDecimals', market.baseDecimals)
  checkDecimals('quoteDecimals', market.quoteDecimals)
  checkBps('toleranceBps', market.toleranceBps)
  checkBps('feeBps', market.feeBps)
  checkBounds('sellBase', market.sellBase)
  checkBounds('buyBase', market.buyBase)

  const feedUrl = market.feedUrl.trim()
  if (!feedUrl) throw new Error('feedUrl is required: a market that cannot be priced fills at whatever a maker asks')
  let parsed: URL
  try {
    parsed = new URL(feedUrl)
  } catch {
    throw new Error(`feedUrl must be an absolute URL, got ${JSON.stringify(market.feedUrl)}`)
  }
  // `createPriceFeed` calls `fetch`, which speaks these two and nothing else. A
  // `file:` feed would also read the solver's own disk through an admin port
  // that has no authentication of its own.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`feedUrl must be http or https, got ${JSON.stringify(parsed.protocol)}`)
  }

  // Shape first, so a pointer missing its leading slash is named as such rather
  // than reported as an underivable feed.
  validatePricePath(market.pricePath)
  if (market.pricePath === '' && defaultPricePath(feedUrl) === null) {
    throw new Error(`pricePath is required: it cannot be derived from ${JSON.stringify(feedUrl)}`)
  }

  // Last, because it is the only rule that is about the PAIR rather than a
  // field, and because `marketKeyForPair` throws with its own vocabulary — a
  // reader who got here has already been told about anything simpler.
  assetMarketKey(market.base, market.quote)
}

/** The unordered pair `ops/assetOffers.ts` matches an offer's legs against. `null` is BTC. */
export interface AssetMarketPair {
  readonly a: string | null
  readonly b: string | null
}

/** One market's pricing, in the shape `AssetOfferService` consumes. */
export interface AssetMarketPricingView {
  readonly base: string | null
  readonly quote: string | null
  readonly baseDecimals: number
  readonly quoteDecimals: number
  readonly feedUrl: string
  readonly pricePath: string
  readonly toleranceBps: number
  readonly feeBps: number
  readonly sellBase?: AssetMarketBounds
  readonly buyBase?: AssetMarketBounds
}

/**
 * The two lists the offer path needs, from the stored rows. Together, always.
 *
 * ONE FUNCTION FOR BOTH, and that is the safety property rather than a
 * convenience. `AssetOfferService` reads them separately and they fail in
 * OPPOSITE directions:
 *
 * - `markets` empty means no offer matches a served pair, so everything is
 *   refused. Safe.
 * - `pricing` empty means `withinTolerance` returns TRUE for every offer — the
 *   deployment is read as "has not opted into price gating", and the solver
 *   fills at whatever a maker names.
 *
 * So a market must never leave one list without leaving the other. Deriving both
 * here, from one filter, makes the dangerous combination unrepresentable at the
 * call site: disable every market and `markets` empties too, which refuses
 * rather than fills.
 *
 * Disabled rows are dropped from BOTH for exactly that reason.
 */
export const assetMarketPolicy = (
  markets: readonly AssetMarketConfig[],
): { pairs: readonly AssetMarketPair[]; pricing: readonly AssetMarketPricingView[] } => {
  // Validated BEFORE the enabled filter, so a disabled row that has gone bad is
  // still reported. A market an operator paused is one they intend to resume,
  // and discovering on that morning that it never loaded is discovering it at
  // the worst moment.
  for (const market of markets) validateAssetMarket(market)

  const seen = new Set<string>()
  for (const market of markets) {
    const key = assetMarketKey(market.base, market.quote)
    // The store's primary key already forbids this. Re-checked because startup
    // reads whatever is on disk, and `pricing.find()` resolving a duplicate by
    // row order is the silent misprice this file exists to prevent — a
    // hand-edited database must not be able to reach it.
    if (seen.has(key)) throw new Error(`two markets share the key ${key}; a pair may be configured only once`)
    seen.add(key)
  }

  const served = markets.filter((market) => market.enabled)
  return {
    pairs: served.map((market) => ({ a: market.base, b: market.quote })),
    pricing: served.map((market) => ({
      base: market.base,
      quote: market.quote,
      baseDecimals: market.baseDecimals,
      quoteDecimals: market.quoteDecimals,
      feedUrl: market.feedUrl,
      pricePath: market.pricePath,
      toleranceBps: market.toleranceBps,
      feeBps: market.feeBps,
      ...(market.sellBase === null ? {} : { sellBase: market.sellBase }),
      ...(market.buyBase === null ? {} : { buyBase: market.buyBase }),
    })),
  }
}
