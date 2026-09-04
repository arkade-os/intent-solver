/**
 * `arkade:<X>->arkade:<Y>` over RFQ — the atomic class of
 * `docs/rfq-protocol.md` § 7.2, decided as pure data.
 *
 * RFQ is the spec's standard negotiation layer for ALL corridors, this one
 * included; the extension-packet path (`core/assetOffer.ts` and
 * `ops/assetOffers.ts`) is the other way the same settlement is reached, and
 * the two coexist. The difference is only WHO NAMES THE PRICE. On the packet
 * path a maker publishes an offer and this solver decides whether to take the
 * price it names. Here the client asks first, and the solver names a binding
 * price the client then funds against.
 *
 * WHAT DOES NOT CHANGE IS WHO IS THE TAKER. § 7.2: "The offer IS the contract,
 * and the CLIENT funds it." So even over RFQ the solver never publishes an
 * offer and never funds a covenant — it quotes, waits for the client's deposit
 * at an address BOTH SIDES DERIVE INDEPENDENTLY, and fills. That is what keeps
 * `ops/assetOffers.ts`'s money constraint intact: "publishing an offer would
 * write a free option", because an offer is a standing commitment with no
 * intrinsic expiry, and this quote is not one. A quote binds for `valid_until`
 * — seconds, on a cross-asset pair — and puts NOTHING on chain until the client
 * itself deposits. Nobody can hold it open while the market moves.
 *
 * THE ADDRESS IS THE COMMITMENT, and it is why this corridor needs no
 * accept message and no contract identifier on the wire. `offerVtxoScript`
 * compiles the covenant from `(makerWP, wantAmount, wantAsset, server, user)`,
 * so a deposit funded under DIFFERENT terms than the ones quoted derives a
 * DIFFERENT address, which the solver is not watching. A client cannot bind
 * this solver to terms it did not quote, and neither side has to trust the
 * other's arithmetic.
 */
import type { Price } from './priceFeed.js'

/**
 * One leg's asset: the canonical 68-hex Arkade asset id, or `null` for BTC.
 *
 * `null` rather than a `"btc"` sentinel because that is the distinction the
 * offer packet itself draws — `wantAsset`/`offerAsset` are OMITTED for BTC, not
 * set to some BTC id — and `core/assetOffer.ts` already keys its markets and
 * inventory the same way. One spelling across both paths.
 */
export type AssetLeg = string | null

export interface AssetPair {
  /** What the CLIENT deposits into the offer covenant. */
  from: AssetLeg
  /** What any spend of that covenant must deliver — the offer's `wantAmount` leg. */
  to: AssetLeg
}

/** § 2's identity rule: lowercase only, 32-byte txid then a u16 group index. */
const ASSET_ID = /^[0-9a-f]{68}$/
const ARKADE_PAIR = /^arkade:([A-Za-z0-9]+)->arkade:([A-Za-z0-9]+)$/

const legOf = (ticker: string): AssetLeg | undefined => {
  if (ticker === 'BTC') return null
  // Lowercase only, and NOT normalised — `marketKey.ts` carries the same rule
  // with the reason: a pair is compared byte for byte elsewhere, so a spelling
  // accepted here and rejected there derives the right market key and is then
  // refused as unserved, with a stated reason that is a lie.
  return ASSET_ID.test(ticker) ? ticker : undefined
}

/**
 * The two legs an arkade-to-arkade pair names, or null when it names none.
 *
 * EXACTLY ONE LEG MAY BE AN ASSET, and that is not this repo's rule to relax:
 * `@arkade-os/swap`'s `encodeOffer` "refuses a packet naming both a want asset
 * and an offer asset, or neither" (§ 7.2), and `fulfillOffer` throws on the
 * same shape. An asset-to-asset offer is not expressible in the packet, so
 * quoting one would be quoting a swap that can never be funded or settled.
 * Refusing it at the pair is what stops that reaching a client as a quote.
 */
export const parseAssetPair = (pair: string): AssetPair | null => {
  const match = ARKADE_PAIR.exec(pair)
  if (!match) return null
  const from = legOf(match[1]!)
  const to = legOf(match[2]!)
  if (from === undefined || to === undefined) return null
  // Both BTC is degenerate and both assets is unrepresentable; the packet
  // refuses each, so neither can be quoted.
  if ((from === null) === (to === null)) return null
  return { from, to }
}

/**
 * One priced market, in the same base/quote terms `assetOfferPrice.ts` uses.
 *
 * Shares that module's convention deliberately: the feed quotes QUOTE PER BASE,
 * and which leg is which decides the arithmetic. A deployment that priced the
 * packet path and this one differently would quote two prices for one market.
 */
export interface AssetQuoteMarket {
  base: AssetLeg
  quote: AssetLeg
  baseDecimals: number
  quoteDecimals: number
  /** The solver's margin, taken out of the payout. */
  feeBps: number
  /** Inclusive bounds on the PAYOUT — the `to` leg — in its atomic units. */
  minPayout: bigint
  maxPayout: bigint
}

export type AssetQuoteRefusal =
  'unsupported_pair' | 'exact_out_unsupported' | 'price_unavailable' | 'fee_consumes_swap' | 'amount_out_of_range'

export type AssetQuoteOutcome =
  { ok: true; fromAmount: bigint; toAmount: bigint } | { ok: false; reason: AssetQuoteRefusal }

const BPS = 10_000n
const pow10 = (n: number): bigint => 10n ** BigInt(n)

/**
 * The two amounts a quote resolves, exactly — § 4.2's "the solver's fee lives
 * in the spread between them; there is no separate fee field".
 *
 * EXACT INTEGER ARITHMETIC, never a float, for the reason `assetOfferPrice.ts`
 * gives about the same comparison: at 6-decimal amounts against a sats leg the
 * float64 rounding is real and it decides money. Here it would decide it in a
 * direction nobody chose.
 *
 * EXACT-IN ONLY. § 7.1.5 refuses exact-out on the EVM corridors because "the
 * two legs are different assets, so exact-out would mean inverting a fetched,
 * rounded, directional rate", and this corridor is cross-asset by construction
 * — `parseAssetPair` refuses a same-asset pair outright. So the same refusal
 * applies for the same reason, rather than a second rounding convention being
 * invented for one corridor.
 */
export const resolveAssetQuote = (args: {
  pair: AssetPair
  amount: bigint
  amountSide: 'from' | 'to'
  market: AssetQuoteMarket
  feed: Price
}): AssetQuoteOutcome => {
  const { pair, amount, amountSide, market, feed } = args

  if (amountSide !== 'from') return { ok: false, reason: 'exact_out_unsupported' }

  // Which way round the client is trading across this market's two legs.
  const givesBase = pair.from === market.base && pair.to === market.quote
  const givesQuote = pair.from === market.quote && pair.to === market.base
  if (!givesBase && !givesQuote) return { ok: false, reason: 'unsupported_pair' }

  // A non-positive price is not a cheap swap, it is an unusable feed. Left
  // unchecked, `givesQuote` would divide by zero and `givesBase` would price
  // everything at nothing.
  if (feed.mantissa <= 0n) return { ok: false, reason: 'price_unavailable' }
  if (market.feeBps < 0 || market.feeBps >= 10_000) return { ok: false, reason: 'price_unavailable' }
  if (amount <= 0n) return { ok: false, reason: 'amount_out_of_range' }

  const scale = pow10(feed.scale)
  const baseUnit = pow10(market.baseDecimals)
  const quoteUnit = pow10(market.quoteDecimals)

  // The payout before the solver's margin, floored — one division, so one
  // rounding, and it lands against the client the way every other payout in
  // this repo does.
  const mid = givesBase
    ? (amount * feed.mantissa * quoteUnit) / (baseUnit * scale)
    : (amount * baseUnit * scale) / (quoteUnit * feed.mantissa)

  // Fee rounded UP out of the floored mid, matching `corridorPolicy.ts`'s
  // `feeSatsFor` exactly rather than inventing a second convention: rounding a
  // fee down means the solver eats the remainder on every swap.
  const fee = (mid * BigInt(market.feeBps) + BPS - 1n) / BPS
  const toAmount = mid - fee

  // Not clamped to zero, for the reason `payoutSatsFor` states: "the fee ate
  // the swap" and "the amount is below the minimum" want different refusals,
  // and a clamp would silently turn the first into a payout of nothing.
  if (toAmount <= 0n) return { ok: false, reason: 'fee_consumes_swap' }

  // Bounds are evaluated on the TO leg — what the solver pays out — which is
  // § 4.6's rule for `min`/`max` and the registry card's own convention.
  if (toAmount < market.minPayout || toAmount > market.maxPayout) {
    return { ok: false, reason: 'amount_out_of_range' }
  }

  return { ok: true, fromAmount: amount, toAmount }
}

export type AssetFillRefusal = 'quote_expired' | 'deposit_short' | 'insufficient_inventory'

export type AssetFillDecision = { fill: true } | { fill: false; reason: AssetFillRefusal }

/**
 * Whether to spend the client's deposit RIGHT NOW — § 9's action-time gate.
 *
 * Re-evaluated immediately before `fulfill`, never inherited from quote time:
 * quoting and funding are separated by a network wait, and all three facts
 * below can be false by the time the money would move.
 *
 * Ordered so a refusal is the most specific true statement rather than
 * whichever gate ran first — the same discipline `evaluateOfferFill` states.
 */
export const evaluateAssetFill = (args: {
  /** What the covenant obliges any spend to deliver, and on which leg. */
  toAmount: bigint
  toAssetId: AssetLeg
  /** What the quote said the client would deposit. */
  fromAmount: bigint
  /** What the client ACTUALLY deposited, observed at the offer's own script. */
  depositedAmount: bigint
  /** Spendable balance per asset id — `available`, never `total`. */
  available: ReadonlyMap<AssetLeg, bigint>
  now: number
  validUntil: number
}): AssetFillDecision => {
  // FIRST. § 5: late funding "MUST be refused... Never silently filled, never
  // silently re-priced." On a cross-asset pair the solver is short the market
  // for the whole window, so a lapsed quote is a price the market has already
  // left. The client is not stranded — § 7.2's `cancel` is a 2-of-2 of the
  // FUNDER and the Arkade Service, so it reclaims the deposit without needing
  // this solver at all.
  if (args.now > args.validUntil) return { fill: false, reason: 'quote_expired' }

  // The covenant obliges the full payout whatever was deposited, so a short
  // deposit means paying the quoted amount for less than the quoted input.
  // Over-funding only ever favours the solver and is not refused.
  if (args.depositedAmount < args.fromAmount) return { fill: false, reason: 'deposit_short' }

  // Last, because it is the only one whose answer changes minute to minute, so
  // a refusal here is the one worth retrying. Read on the leg being PAID.
  const held = args.available.get(args.toAssetId) ?? 0n
  if (held < 0n) return { fill: false, reason: 'insufficient_inventory' }

  return { fill: true }
}
