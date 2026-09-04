/**
 * The solver's own solver-registry card: the v0 corridor card advertising the
 * send leg (deposit Arkade BTC, receive Lightning BTC), generated from the
 * SAME config the service runs with so the published listing can never drift
 * from what the deployment actually enforces.
 *
 * Exists because `solverd` cannot emit corridor cards yet
 * (arkade-os/solver-registry#13), so the registry's documented path for a corridor
 * solver is a hand-written card.
 *
 * Canonical form per docs/arkade-discovery-spec.md: serialize with `sig` removed, keys
 * sorted lexicographically and recursively, no whitespace, UTF-8; sha256; BIP340-sign
 * with the discovery key. That key is the wallet identity — the same x-only pubkey
 * makers address RFQs to — so the card's rendezvous data is signed by the key it
 * advertises.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { ASSET_ID_HEX_LENGTH, ASSETS } from './marketKey.js'
import { defaultPricePath } from './priceFeed.js'
import type { AssetMarketPricingView } from './assetMarketConfig.js'
import type { Corridor, Fee } from './corridorPolicy.js'
import type { Limits } from './limits.js'

/** Mirrors the registry card schema's `name` rule (must equal the filename). */
const NAME = /^[a-z0-9-]+$/
/** Mirrors the registry schemas' relay item rule and bound. */
const RELAY = /^wss:\/\/[^\s]+$/
const MAX_RELAYS = 8
/** § 2's identity rule for an Arkade asset id, which the schema's `asset.id` also admits. */
const ASSET_ID = new RegExp(`^[0-9a-f]{${ASSET_ID_HEX_LENGTH}}$`)
/** The registry's ceiling on an asset's `decimals` AND on `price_decimals`. */
const MAX_DECIMALS = 18
/** Label width. The schema demands a ticker the config has none of, and the
 * spec makes labels decoration — clients group and price by `id`. */
const LABEL_CHARS = 8

// From the shared § 2 vocabulary, so the card's ids cannot drift from the
// market key the relay subscription is derived with.
const BTC_ASSET = { id: ASSETS.BTC!.id, name: ASSETS.BTC!.name, ticker: 'BTC', decimals: ASSETS.BTC!.decimals }

export interface SolverCardInputs {
  /** Registry listing name; becomes `solvers/<network>/<name>.json`. */
  name: string
  /** x-only hex pubkey makers address RFQs to — the wallet identity. */
  discoveryPubkey: string
  /** Relay URLs the service actually listens on (outbound subscriptions). */
  relays: string[]
  /**
   * Which corridors this deployment actually serves, and each one's bounds.
   *
   * The card used to hardcode a single Lightning market, so a deployment
   * serving onchain — or serving Lightning in the other direction — published
   * a card describing something else. Discovery is the one place a solver
   * makes a claim nobody can check against its config, so the claim has to
   * come FROM the config.
   */
  corridors: Readonly<Partial<Record<Corridor, { limits: Limits; fee: Fee }>>>
  /**
   * The Arkade asset markets this deployment serves. Separate from `corridors`
   * because an asset corridor names a 68-hex asset id, which that record cannot
   * express. OPTIONAL, so a deployment with none publishes the card it did before.
   */
  assetMarkets?: readonly AssetCardMarket[]
}

/** As `assetMarketPolicy` produces it. Both legs are on the unmarked arkade corridor. */
export interface AssetCardMarket {
  base: string | null
  quote: string | null
  baseDecimals: number
  quoteDecimals: number
  feedUrl: string
  /** RFC 6901 pointer, ALREADY resolved: `''` reads as the whole document to a client. */
  pricePath: string
  feeBps: number
  /** Maker sells base, so it RECEIVES quote — this bounds the QUOTE side. */
  sellBase?: { min: bigint; max: bigint } | null
  /** Maker buys base, so it RECEIVES base — this bounds the BASE side. */
  buyBase?: { min: bigint; max: bigint } | null
}

/**
 * The card's v0 transport map: rendezvous keyed by PROTOCOL, not a bare list
 * of URLs. `nostr` is the only key the schema admits today, and it is required
 * within the map — a second transport becomes a second key rather than a
 * reinterpretation of the same strings.
 *
 * It replaced a top-level `relays: string[]`, and the schema is
 * `additionalProperties: false`, so a card still carrying the old field is rejected
 * outright rather than merged. It is also the extension point: adding a non-Nostr
 * bus is a new key here plus a codec, and nothing above the codec moves.
 */
export interface SolverCardTransports {
  nostr: { relays: string[] }
}

export interface SolverCard {
  version: 0
  name: string
  discovery_pubkey: string
  transports: SolverCardTransports
  markets: Array<Record<string, unknown>>
  sig?: string
}

/**
 * The markets a card can advertise, and the two corridors each is made of.
 *
 * A registry market is NON-DIRECTIONAL — it names a pair, not a trade
 * direction — so the four corridors collapse into two markets. Direction is
 * carried by the bounds instead: they describe what the maker RECEIVES on a
 * side, so the arkade-receiving corridor sets the BASE bounds and the
 * arkade-sending one sets the QUOTE bounds. A side the deployment does not
 * serve is published as the schema's `"0"`/`"0"` rather than omitted.
 */
const MARKETS = [
  {
    quoteCorridor: 'lightning',
    pair: 'BTC/lightning:BTC',
    /** Maker receives on the quote side. */
    quoteFrom: 'arkade:BTC->lightning:BTC',
    /** Maker receives on the base (arkade) side. */
    baseFrom: 'lightning:BTC->arkade:BTC',
  },
  {
    quoteCorridor: 'onchain',
    pair: 'BTC/onchain:BTC',
    quoteFrom: 'arkade:BTC->onchain:BTC',
    baseFrom: 'onchain:BTC->arkade:BTC',
  },
] as const satisfies readonly { quoteCorridor: string; pair: string; quoteFrom: Corridor; baseFrom: Corridor }[]

const cardAsset = (leg: string | null, decimals: number): Record<string, unknown> => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new Error(`an asset leg's decimals must be an integer in 0..${MAX_DECIMALS} to publish, got ${decimals}`)
  }
  if (leg === null) {
    // Bounds are atomic units of the declared precision: a BTC leg that is not
    // in sats publishes bounds an order of magnitude off.
    if (decimals !== BTC_ASSET.decimals) {
      throw new Error(`the BTC leg is ${BTC_ASSET.decimals} decimals (sats), got ${decimals}`)
    }
    return { ...BTC_ASSET }
  }
  if (!ASSET_ID.test(leg)) {
    throw new Error(
      `an asset leg must be null for BTC or a lowercase ${ASSET_ID_HEX_LENGTH}-character asset id, ` +
        `got ${JSON.stringify(leg)}`,
    )
  }
  const label = leg.slice(0, LABEL_CHARS)
  return { id: leg, name: `Arkade asset ${label}`, ticker: label, decimals }
}

/** A side's bounds. Absent or zeroed is the schema's disabled `"0"`/`"0"`. */
const cardAmounts = (label: string, bound?: { min: bigint; max: bigint } | null): { min: string; max: string } => {
  if (!bound || bound.max === 0n) return { min: '0', max: '0' }
  if (bound.min <= 0n) throw new Error(`${label} min must be at least 1 on an enabled side, got ${bound.min}`)
  if (bound.min > bound.max) throw new Error(`${label} min ${bound.min} must not exceed its max ${bound.max}`)
  return { min: String(bound.min), max: String(bound.max) }
}

/** Order-free, so one pair cannot be published twice with its legs swapped. */
const legPairKey = (market: AssetCardMarket): string => [market.base ?? 'btc', market.quote ?? 'btc'].sort().join('/')

const assetMarketEntries = (markets: readonly AssetCardMarket[]): Array<Record<string, unknown>> => {
  const seen = new Set<string>()
  return markets.map((market) => {
    if (market.base === market.quote) {
      throw new Error(`an asset market names ${market.base ?? 'BTC'} on both legs; the two legs must differ`)
    }
    const baseAsset = cardAsset(market.base, market.baseDecimals)
    const quoteAsset = cardAsset(market.quote, market.quoteDecimals)
    // Refused at `assetRfq.ts` for want of a covenant, so naming one is a lie.
    if (market.base !== null && market.quote !== null) {
      throw new Error(`an asset market where neither leg is BTC cannot be served, so it is not advertised`)
    }
    const pair = `${baseAsset.ticker}/${quoteAsset.ticker}`
    const key = legPairKey(market)
    if (seen.has(key)) throw new Error(`${pair} is configured twice; one pair may publish only one price`)
    seen.add(key)

    if (!Number.isInteger(market.feeBps) || market.feeBps < 0 || market.feeBps > 10000) {
      throw new Error(`${pair} fee_bps must be an integer in [0, 10000], got ${market.feeBps}`)
    }
    if (!market.feedUrl.trim()) {
      throw new Error(`${pair} carries different assets, so it must publish a price_feed`)
    }
    if (!market.pricePath) {
      throw new Error(`${pair} price_path must be resolved before publishing; "" reads as the whole feed document`)
    }
    // Feed is quote-DISPLAY per base-DISPLAY; the registry wants atomic per atomic.
    const priceDecimals = market.baseDecimals - market.quoteDecimals
    if (priceDecimals < 0 || priceDecimals > MAX_DECIMALS) {
      throw new Error(
        `${pair} needs price_decimals ${priceDecimals}, outside the registry's 0..${MAX_DECIMALS}: a feed ` +
          `quoting a finer asset per a coarser one cannot be published until arkade-os/solver-registry#26 lands`,
      )
    }
    const base = cardAmounts(`${pair} buyBase`, market.buyBase)
    const quote = cardAmounts(`${pair} sellBase`, market.sellBase)
    if (base.max === '0' && quote.max === '0') {
      throw new Error(`${pair} enables neither side, and the registry requires at least one`)
    }
    return {
      pair,
      base_asset: baseAsset,
      quote_asset: quoteAsset,
      fee_bps: market.feeBps,
      price_feed: market.feedUrl,
      price_feed_schema: { type: 'json', price_path: market.pricePath },
      price_decimals: priceDecimals,
      min_base_amount: base.min,
      max_base_amount: base.max,
      min_quote_amount: quote.min,
      max_quote_amount: quote.max,
    }
  })
}

/**
 * Resolves the two things the store leaves open — the price pointer and an
 * inherited bound. Shared: `cli card` and `/api/card` must print one card.
 */
export const assetCardMarkets = (
  markets: readonly AssetMarketPricingView[],
  inherited: { min: bigint; max: bigint },
): AssetCardMarket[] =>
  markets.map((market) => ({
    base: market.base,
    quote: market.quote,
    baseDecimals: market.baseDecimals,
    quoteDecimals: market.quoteDecimals,
    feedUrl: market.feedUrl,
    pricePath: market.pricePath || (defaultPricePath(market.feedUrl) ?? ''),
    feeBps: market.feeBps,
    // `undefined` inherits the deployment-wide pair — NOT an unserved direction.
    sellBase: market.sellBase ?? inherited,
    buyBase: market.buyBase ?? inherited,
  }))

/**
 * Served corridors no card can name, so an unadvertisable market is legible as
 * one. An ERC20 fits neither the schema's `asset.id` nor its corridor enum, and
 * a card validates WHOLE — one unrecognised market drops the Lightning and
 * onchain ones too. Hence omitted, and reported rather than hidden.
 */
export const unpublishableCorridors = (corridors: readonly string[]): string[] =>
  corridors.map(
    (corridor) =>
      `${corridor} is served but cannot be advertised: the registry card schema admits no ERC20 asset id and ` +
      `no ethereum corridor, and a card carrying one is rejected whole rather than per market. ` +
      `Tracked in arkade-os/solver-registry#23.`,
  )

/**
 * The unsigned card, describing the corridors this deployment actually serves.
 *
 * Bounds apply to what the maker RECEIVES on a side, so an unserved direction
 * is disabled with the schema's `"0"`/`"0"` rather than dropped — the market is
 * still real, one way round. A market with neither direction served is omitted
 * entirely, and a card with no markets at all is refused: there is nothing
 * honest to publish.
 *
 * Same asset on both sides of every market here, so the feed fields are
 * forbidden rather than optional.
 */
export const buildSolverCard = (inputs: SolverCardInputs): SolverCard => {
  if (!NAME.test(inputs.name)) {
    throw new Error(`card name must match ${NAME}, got ${JSON.stringify(inputs.name)}`)
  }
  if (!/^[0-9a-f]{64}$/.test(inputs.discoveryPubkey)) {
    throw new Error('discovery pubkey must be 64 lowercase hex chars (x-only)')
  }
  const relays = [...new Set(inputs.relays)]
  if (relays.length === 0) {
    throw new Error('a corridor card needs at least one wss:// relay — set RELAY_URL (or SOLVER_CARD_RELAYS)')
  }
  if (relays.length > MAX_RELAYS) {
    throw new Error(`at most ${MAX_RELAYS} relays, got ${relays.length}`)
  }
  for (const relay of relays) {
    if (!RELAY.test(relay)) throw new Error(`relays must be wss:// URLs, got ${relay}`)
  }
  // Per corridor, not once: each publishes its own bounds, and a single bad one must
  // not ride along inside a card the rest of which validates. Failing here beats
  // printing a card the operator files and the registry bounces at CI.
  for (const [corridor, entry] of Object.entries(inputs.corridors)) {
    if (!entry) continue
    const { limits, fee } = entry
    if (!Number.isInteger(fee.bps) || fee.bps < 0 || fee.bps > 10000) {
      throw new Error(`${corridor} fee_bps must be an integer in [0, 10000], got ${fee.bps}`)
    }
    if (!Number.isInteger(fee.flatSats) || fee.flatSats < 0) {
      throw new Error(`${corridor} fee_flat must be a non-negative integer, got ${fee.flatSats}`)
    }
    for (const [label, value] of [
      ['minSats', limits.minSats],
      ['maxSats', limits.maxSats],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${corridor} limits.${label} must be a positive integer to publish, got ${value}`)
      }
    }
    if (limits.minSats > limits.maxSats) {
      throw new Error(`${corridor} limits.minSats (${limits.minSats}) must be <= maxSats (${limits.maxSats})`)
    }
  }
  const assetMarkets = assetMarketEntries(inputs.assetMarkets ?? [])
  const markets = MARKETS.flatMap((market) => {
    const base = inputs.corridors[market.baseFrom]
    const quote = inputs.corridors[market.quoteFrom]
    if (!base && !quote) return []
    // A market's fee is the HIGHER of its two directions, because one card entry
    // stands for both and overstating is the safe direction. Taken per market rather
    // than once for the card: an onchain corridor typically carries a flat charge for
    // miner fees that Lightning does not, and publishing Lightning's fee on the
    // onchain market would describe a quote the taker will not receive.
    const fees = [base?.fee, quote?.fee].filter((fee): fee is Fee => fee !== undefined)
    const feeBps = Math.max(...fees.map((fee) => fee.bps))
    const feeFlat = Math.max(...fees.map((fee) => fee.flatSats))
    return [
      {
        pair: market.pair,
        base_asset: { ...BTC_ASSET },
        quote_asset: { ...BTC_ASSET },
        quote_corridor: market.quoteCorridor,
        fee_bps: feeBps,
        // Optional in the registry schema, absent meaning none — so a
        // deployment charging no flat fee publishes a card byte-identical to
        // the one it published before the field existed.
        ...(feeFlat > 0 ? { fee_flat: String(feeFlat) } : {}),
        min_base_amount: base ? String(base.limits.minSats) : '0',
        max_base_amount: base ? String(base.limits.maxSats) : '0',
        min_quote_amount: quote ? String(quote.limits.minSats) : '0',
        max_quote_amount: quote ? String(quote.limits.maxSats) : '0',
      },
    ]
  })
  if (markets.length === 0 && assetMarkets.length === 0) {
    throw new Error('no corridor is enabled, so there is no honest card to publish')
  }

  return {
    version: 0,
    name: inputs.name,
    discovery_pubkey: inputs.discoveryPubkey,
    transports: { nostr: { relays } },
    // Corridor markets first: adding one must not reorder, and so resign, the rest.
    markets: [...markets, ...assetMarkets],
  }
}

/** Recursively key-sort so the serialization is byte-deterministic. */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export const canonicalCardJson = (card: object): string => {
  const { sig: _sig, ...rest } = card as Record<string, unknown>
  return JSON.stringify(canonicalize(rest))
}

export const cardDigest = (card: object): Uint8Array => sha256(new TextEncoder().encode(canonicalCardJson(card)))

/** BIP340-signs a 32-byte digest. The identity's `signMessage(d, 'schnorr')` fits. */
export type DigestSigner = (digest: Uint8Array) => Promise<Uint8Array>

/**
 * Sign the card with the discovery key and return a new card carrying `sig`.
 * Verifies the result against the card's own `discovery_pubkey` before
 * returning: if that pubkey was derived any other way than BIP340
 * x-only-of-the-signing-key (a tweak, a different path), the mismatch
 * surfaces here as an error instead of as a registry-rejected — or worse,
 * merged-but-dead — listing.
 */
export const signSolverCard = async (card: SolverCard, sign: DigestSigner): Promise<SolverCard> => {
  const signed = { ...card, sig: bytesToHex(await sign(cardDigest(card))) }
  if (!verifyCardSig(signed)) {
    throw new Error('card signature does not verify against discovery_pubkey — is the pubkey derived from this key?')
  }
  return signed
}

export const verifyCardSig = (card: SolverCard): boolean => {
  if (!card.sig) return false
  try {
    return schnorr.verify(hexToBytes(card.sig), cardDigest(card), hexToBytes(card.discovery_pubkey))
  } catch {
    return false
  }
}
