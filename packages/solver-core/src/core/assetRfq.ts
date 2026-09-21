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
import { assetExactInPayout, assetExactOutInput } from './assetExactInPrice.js'

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
  sellBaseFeeBps?: number
  buyBaseFeeBps?: number
  /** Atomic units of the base input, charged when the client sells base. */
  sellBaseFeeFlat?: bigint
  /** Atomic units of the quote input, charged when the client buys base. */
  buyBaseFeeFlat?: bigint
  /** Inclusive bounds on the PAYOUT — the `to` leg — in its atomic units. */
  minPayout: bigint
  maxPayout: bigint
}

export type AssetQuoteRefusal = 'unsupported_pair' | 'price_unavailable' | 'fee_consumes_swap' | 'amount_out_of_range'

/** True if `pair`'s FROM leg is `market`'s base, false if the reverse, null if `pair` is not on `market` at all. */
export const assetQuoteGivesBase = (pair: AssetPair, market: AssetQuoteMarket): boolean | null => {
  if (pair.from === market.base && pair.to === market.quote) return true
  if (pair.from === market.quote && pair.to === market.base) return false
  return null
}

/** The direction's flat fee, atomic units of the FROM leg. Shared so a caller never restates the ternary. */
export const assetFlatFeeFor = (givesBase: boolean, market: AssetQuoteMarket): bigint =>
  (givesBase ? market.sellBaseFeeFlat : market.buyBaseFeeFlat) ?? 0n

/** The direction's spread, basis points. Shared for the same reason {@link assetFlatFeeFor} is. */
export const assetFeeBpsFor = (givesBase: boolean, market: AssetQuoteMarket): number =>
  (givesBase ? market.sellBaseFeeBps : market.buyBaseFeeBps) ?? market.feeBps

export type AssetQuoteOutcome =
  { ok: true; fromAmount: bigint; toAmount: bigint } | { ok: false; reason: AssetQuoteRefusal }

export interface CarrierLegs {
  /** Netted OFF the deposit, when the solver delivers the asset. */
  charged: bigint
  /** Added TO the payout, when the client fronted it. */
  returned: bigint
}

// BOTH legs counted: an asset deposit carries one, an asset payout needs one.
export const carrierLegs = (pair: AssetPair, carrierSats: bigint): CarrierLegs => {
  const clientFronts = pair.from !== null
  const solverDelivers = pair.to !== null
  return {
    charged: solverDelivers && !clientFronts ? carrierSats : 0n,
    returned: clientFronts && !solverDelivers ? carrierSats : 0n,
  }
}

/** What the PRICE put on neither leg: `struckQuotePrice` takes these back off. */
const flatPartsOf = (args: {
  pair: AssetPair
  market: AssetQuoteMarket
  givesBase: boolean
  carrierSats: bigint
}): { flatFee: bigint; from: bigint; to: bigint } => {
  const { pair, market, givesBase, carrierSats } = args
  const flatFee = assetFlatFeeFor(givesBase, market)
  const legs = carrierLegs(pair, carrierSats)
  return { flatFee, from: flatFee + legs.charged, to: legs.returned }
}

/**
 * The two amounts a quote resolves, exactly — § 4.2's "the solver's fee lives
 * in the spread between them; there is no separate fee field".
 *
 * EXACT INTEGER ARITHMETIC, never a float, for the reason `assetOfferPrice.ts`
 * gives about the same comparison: at 6-decimal amounts against a sats leg the
 * float64 rounding is real and it decides money. Here it would decide it in a
 * direction nobody chose.
 *
 * BOTH SIDES: `assetExactOutInput` searches the forward function, so one rounding
 * convention decides each (§ 7.1.5's objection).
 */
export const resolveAssetQuote = (args: {
  pair: AssetPair
  amount: bigint
  amountSide: 'from' | 'to'
  market: AssetQuoteMarket
  feed: Price
  /** Sats to NET as a pass-through. Zero quotes exactly as before it was priced. */
  carrierSats: bigint
  /** The Service's dust: a CHAIN constraint, equal in value to the carrier and unrelated in meaning. */
  dustSats: bigint
}): AssetQuoteOutcome => {
  const { pair, amount, amountSide, market, feed, carrierSats, dustSats } = args

  // Which way round the client is trading across this market's two legs.
  const givesBase = assetQuoteGivesBase(pair, market)
  if (givesBase === null) return { ok: false, reason: 'unsupported_pair' }

  // A non-positive price is not a cheap swap, it is an unusable feed — left
  // unchecked, either direction divides by zero or prices everything free.
  if (feed.mantissa <= 0n) return { ok: false, reason: 'price_unavailable' }
  if (market.feeBps < 0 || market.feeBps >= 10_000) return { ok: false, reason: 'price_unavailable' }
  if (amount <= 0n) return { ok: false, reason: 'amount_out_of_range' }

  if (carrierSats < 0n || dustSats < 0n) return { ok: false, reason: 'price_unavailable' }

  const flat = flatPartsOf({ pair, market, givesBase, carrierSats })
  if (flat.flatFee < 0n) return { ok: false, reason: 'price_unavailable' }
  const feeBps = assetFeeBpsFor(givesBase, market)
  if (feeBps < 0 || feeBps >= 10_000) return { ok: false, reason: 'price_unavailable' }
  const solverDelivers = pair.to !== null

  if (amountSide === 'to') {
    // The named amount already holds whatever comes back to them.
    const wanted = amount - flat.to
    if (wanted <= 0n) return { ok: false, reason: 'fee_consumes_swap' }
    if (wanted < market.minPayout || wanted > market.maxPayout) {
      return { ok: false, reason: 'amount_out_of_range' }
    }
    const netInput = assetExactOutInput({
      payout: wanted,
      givesBase,
      baseDecimals: market.baseDecimals,
      quoteDecimals: market.quoteDecimals,
      feeBps,
      feed,
    })
    if (netInput === null) return { ok: false, reason: 'price_unavailable' }
    if (!solverDelivers && amount < dustSats) return { ok: false, reason: 'amount_out_of_range' }
    return { ok: true, fromAmount: netInput + flat.from, toAmount: amount }
  }

  const netAmount = amount - flat.from
  if (netAmount <= 0n) return { ok: false, reason: 'fee_consumes_swap' }

  const payout = assetExactInPayout({
    netInput: netAmount,
    givesBase,
    baseDecimals: market.baseDecimals,
    quoteDecimals: market.quoteDecimals,
    feeBps,
    feed,
  })

  // Not clamped to zero, for the reason `payoutSatsFor` states: "the fee ate
  // the swap" and "the amount is below the minimum" want different refusals,
  // and a clamp would silently turn the first into a payout of nothing.
  if (payout <= 0n) return { ok: false, reason: 'fee_consumes_swap' }

  // Bounds are evaluated on the TO leg — what the solver pays out — which is
  // § 4.6's rule for `min`/`max` and the registry card's own convention. The
  // carrier is a pass-through rather than payout, so it lands after them.
  if (payout < market.minPayout || payout > market.maxPayout) {
    return { ok: false, reason: 'amount_out_of_range' }
  }

  const toAmount = payout + flat.to

  // arkd rejects a sub-dust output 0, priced carrier or not.
  if (!solverDelivers && toAmount < dustSats) {
    return { ok: false, reason: 'amount_out_of_range' }
  }

  return { ok: true, fromAmount: amount, toAmount }
}

/**
 * Extra decimal places the implied price carries beyond the feed's own.
 *
 * The implied price is a DIVISION, and at the feed's scale it quantises: a feed
 * reporting `1.5` parses to `scale: 1`, so an implied price of 1.4955 truncates
 * to `14` and the drift derived from it reads +714bp on a flat market and
 * +607bp on a fill 70bp under water. CoinGecko returns unquoted JSON numbers and
 * is a first-class provider here, so that is a real input, not a contrived one.
 *
 * Headroom is RELATIVE so the implied price can never be coarser than the feed
 * that produced it, whatever scale that feed uses. Twelve places puts the
 * quantisation floor (`10_000 / mantissa` bps) far below the basis point the
 * figure is reported in.
 */
export const IMPLIED_PRICE_HEADROOM = 12

/**
 * This quote's OWN price — quote-asset per base-asset, as an exact integer
 * mantissa at `scale + IMPLIED_PRICE_HEADROOM`.
 *
 * The half of a market mark that the solver controls. Compared against a feed
 * read LATER, at fill time, it says how far the market moved while the quote was
 * outstanding. Compared against the feed it was derived from it says nothing at
 * all, which is the trap the first attempt at this fell into: `resolveAssetQuote`
 * computes the payout FROM that feed, so the two cannot disagree by more than
 * the configured spread.
 *
 * Both directions produce the same ratio, so a drift derived from it is
 * comparable across them. Which direction is FAVOURABLE is not — see
 * `marketDriftBps`.
 *
 * Null rather than zero on a degenerate result. A feed reporting `1.0` parses to
 * `scale: 0`, and the division then truncates a real price to `0n`; storing that
 * as valid reported a fill as +10000bp in the solver's favour.
 */
export const impliedQuotePrice = (args: {
  fromAmount: bigint
  toAmount: bigint
  givesBase: boolean
  baseDecimals: number
  quoteDecimals: number
  scale: number
}): { mantissa: bigint; scale: number } | null => {
  const { fromAmount, toAmount, givesBase, baseDecimals, quoteDecimals } = args
  const baseAtomic = givesBase ? fromAmount : toAmount
  const quoteAtomic = givesBase ? toAmount : fromAmount
  if (baseAtomic <= 0n || quoteAtomic <= 0n || args.scale < 0) return null
  const scale = args.scale + IMPLIED_PRICE_HEADROOM
  const mantissa =
    (quoteAtomic * 10n ** BigInt(baseDecimals) * 10n ** BigInt(scale)) / (baseAtomic * 10n ** BigInt(quoteDecimals))
  return mantissa > 0n ? { mantissa, scale } : null
}

/**
 * The rate this swap was STRUCK at — {@link impliedQuotePrice} net of the flat
 * parts, which folded in bias the ratio by a term that GROWS as the swap
 * shrinks. The bps spread stays: proportional, it shifts the ratio by the
 * constant `marketDriftBps` already pins as the flat-market baseline.
 */
export const struckQuotePrice = (args: {
  fromAmount: bigint
  toAmount: bigint
  pair: AssetPair
  market: AssetQuoteMarket
  carrierSats: bigint
  givesBase: boolean
  scale: number
}): { mantissa: bigint; scale: number } | null => {
  const { pair, market, givesBase, carrierSats } = args
  const flat = flatPartsOf({ pair, market, givesBase, carrierSats })
  return impliedQuotePrice({
    fromAmount: args.fromAmount - flat.from,
    toAmount: args.toAmount - flat.to,
    givesBase,
    baseDecimals: market.baseDecimals,
    quoteDecimals: market.quoteDecimals,
    scale: args.scale,
  })
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
  if (held < args.toAmount) return { fill: false, reason: 'insufficient_inventory' }

  return { fill: true }
}
