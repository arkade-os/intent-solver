/**
 * `arkade:<X>->arkade:<Y>` served over RFQ — the atomic class of
 * `docs/rfq-protocol.md` § 7.2, driven as a corridor.
 *
 * THE SOLVER IS STILL THE TAKER, and nothing here changes that. § 7.2: "The
 * offer IS the contract, and the CLIENT funds it." So this service quotes a
 * price, derives the covenant the client will deposit into, waits for that
 * deposit at an address BOTH SIDES compute independently, and fills it. It
 * never publishes an offer and never funds one.
 *
 * That distinction is the money constraint `ops/assetOffers.ts` names —
 * "publishing an offer would write a free option" — and it survives here for a
 * reason worth stating precisely, because "the solver names the price" sounds
 * like the opposite. An OFFER is a standing on-chain commitment with no
 * intrinsic expiry: it sits at an address while the market moves, and a
 * rational counterparty takes it only once it has turned against the writer. A
 * QUOTE is neither standing nor on chain. It expires at `valid_until` — tens of
 * seconds on a cross-asset pair — and until the client itself deposits, nothing
 * exists anywhere that anyone could take. Nobody can hold this open.
 *
 * WHAT MAKES IT SAFE WITHOUT AN HTLC. The covenant binds `wantAmount` to the
 * maker's own script, so any spend of the deposit pays the client; and the
 * covenant's ADDRESS is derived from those terms, so a deposit funded on terms
 * this solver did not quote lands at an address this solver is not watching.
 * Neither side has to trust the other's arithmetic, and there is no window in
 * which one has paid and the other has not — `fulfill` does both at once.
 *
 * THE REFUND IS NOT OURS TO PERFORM. § 7.2's `cancel` is a 2-of-2 of the FUNDER
 * and the Arkade Service. No solver signature is involved, so when a quote
 * lapses over a deposit this service refuses and stops; the client withdraws at
 * will. There is deliberately no refund sweep here, and its absence is a fact
 * about the covenant rather than a missing feature.
 *
 * Every Arkade seam is INJECTED rather than reached for, the same discipline
 * `ops/assetOffers.ts` follows: the derivation, the deposit read, the float and
 * the settle. The composition root supplies them.
 */

import {
  evaluateAssetFill,
  parseAssetPair,
  resolveAssetQuote,
  struckQuotePrice,
  type AssetLeg,
  type AssetQuoteMarket,
} from '@arkade-os/solver-core/core/assetRfq.js'
import type { Price } from '@arkade-os/solver-core/core/priceFeed.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { createSerialiser, type Serialiser } from '@arkade-os/solver-core/util/serialise.js'
import { QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS, RateLimiter } from '@arkade-os/solver-core/core/rateLimit.js'
import { UniqueConstraintError } from '@arkade-os/solver-core/core/driver.js'
import { assetRfqPairFor } from '../wire/assetRfqPayloads.js'
import { AssetRfqSwapStore, type AssetRfqSwapRow, type AssetRfqSwapState } from '../db/assetRfqSwaps.js'
import type { AssetRfqCarrierTerms } from '../db/assetRfqSwaps.js'
import type { AssetRfqCarrierChoice } from '../wire/assetRfqPayloads.js'

/**
 * A market this deployment serves, plus where its price comes from.
 *
 * BOUNDS ARE PER DIRECTION, and that is not symmetry for its own sake. § 4.6
 * evaluates `min`/`max` on the TO leg — what the solver pays out — and on a
 * cross-asset pair that leg FLIPS with direction: `1000` is a thousand atomic
 * units of an asset one way and a thousand sats the other. A single bound pair
 * would therefore refuse or admit entirely the wrong sizes on one of the two.
 * `ops/assetOffers.ts` already draws exactly this distinction with
 * `sellBase`/`buyBase`, and this is the same convention so a deployment
 * configuring both paths does not describe one market two ways.
 */
export interface AssetRfqMarket extends Omit<AssetQuoteMarket, 'minPayout' | 'maxPayout'> {
  /** Short name for the env stem and the console — `USDA`. */
  symbol: string
  /**
   * Client gives BASE and receives QUOTE; bounds in QUOTE's atomic units.
   * A `max` of `0n` DISABLES the direction rather than meaning unbounded,
   * matching the packet path, so a market can be one-way without being two.
   */
  sellBase: { min: bigint; max: bigint }
  /** Client gives QUOTE and receives BASE; bounds in BASE's atomic units. */
  buyBase: { min: bigint; max: bigint }
  feedUrl: string
  pricePath: string
  /** Sats netted into the quoted amounts for the carrier output. ON THE MARKET, not `deps`: it leaves on the
   * quote's own outcome, so the published `carrier_sats` is always what the amounts were netted against. */
  carrierSats: bigint
}

/** What the chain says is sitting at the offer's own script. */
export interface ObservedDeposit {
  /** The funded outpoint — what `fulfill` spends. */
  txid: string
  vout: number
  /** Sats across the offer's outputs. */
  sats: bigint
  /** Assets those outputs carry, canonical 68-hex ids. */
  assets: readonly { assetId: string; amount: bigint }[]
}

/** The covenant parameters a derivation needs, all of them already decided. */
export interface OfferTerms {
  /** What the covenant obliges any spend to deliver, and on which leg. */
  wantAmount: bigint
  wantAssetId: AssetLeg
  /** The leg the client deposits — `null` when it deposits sats. */
  offerAssetId: AssetLeg
  makerPkScript: string
  makerPublicKey: string
}

/** What the internal Taxi adapter answers for ONE recycle quote id. A TRUSTED
 * SERVICE ADAPTER, not caller JSON. */
export interface ReceiveCarrierQuote {
  quoteId: string
  makerPkScript: string
  makerPublicKey: string
  assetId: string
  physicalSats: bigint
  loanSats: bigint
  receiptSats: bigint
  serviceFareSats: bigint
  /** Immutable Bitcoin locktime domain and minimum expiry for eligible inputs. */
  inputExpiryFloor: Readonly<{ kind: 'height' | 'time'; value: bigint }>
  /** Unix seconds. Read against `now`, so a stale quote cannot be priced. */
  expiresAt: number
}

export interface ReceiveCarrierQuoteRequest {
  quoteId: string
  makerPkScript: string
  makerPublicKey: string
  assetId: string
  now: number
  /** Quote ADMISSION rather than a fill. The fill re-anchors on a later clock
   * or tip, so a floor admitted with no room to spare refuses the client that
   * funded it; only set here, never on the fill-time reads. */
  admission?: boolean
}

export type ReceiveCarrierReconcileOutcome =
  | { status: 'pending' }
  /** Unobservable: escalated rather than watched forever. */
  | { status: 'stuck'; reason: string }
  | { status: 'settled'; txid: string }

/** `submitted` is not a failure: the row stays `filling` until `reconcile` proves it. */
export type ReceiveCarrierSettleOutcome = { status: 'submitted' } | { status: 'settled'; txid: string }

export interface ReceiveCarrierQuotes {
  resolve: (request: ReceiveCarrierQuoteRequest) => Promise<ReceiveCarrierQuote>
  /** Rereads and verifies the named quote, then returns fresh synchronized
   * ContractManager spendable inventory with known same-domain expiry at least
   * its input floor, excluding reservations. Admission only: selection,
   * pinning, and rechecks belong to settlement. */
  available: (request: ReceiveCarrierQuoteRequest) => Promise<ReadonlyMap<AssetLeg, bigint>>
  settle: (row: AssetRfqSwapRow) => Promise<ReceiveCarrierSettleOutcome>
  /** Read-only observation. Settled requires independently verified transaction, deposit, and quote evidence. */
  reconcile: (row: AssetRfqSwapRow) => Promise<ReceiveCarrierReconcileOutcome>
}

const completeReceiveCarrierQuotes = (value: unknown): ReceiveCarrierQuotes | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  return typeof candidate.resolve === 'function' &&
    typeof candidate.available === 'function' &&
    typeof candidate.settle === 'function' &&
    typeof candidate.reconcile === 'function'
    ? (value as ReceiveCarrierQuotes)
    : null
}

const snapshotInputExpiryFloor = (value: unknown): Readonly<{ kind: 'height' | 'time'; value: bigint }> | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { kind?: unknown; value?: unknown }
  const kind = candidate.kind
  const floor = candidate.value
  if ((kind !== 'height' && kind !== 'time') || typeof floor !== 'bigint' || floor <= 0n) return null
  if (kind === 'height' && floor >= 500_000_000n) return null
  if (kind === 'time' && (floor < 500_000_000n || floor > 4_294_967_295n)) return null
  return { kind, value: floor }
}

const isCanonicalTxid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export interface AssetRfqDeps {
  quoteLimiter?: RateLimiter
  store: AssetRfqSwapStore
  /** Markets served. An empty list serves none, which is the safe default. */
  markets: readonly AssetRfqMarket[]
  /** This solver's settlement key, published as the quote's `solver_pubkey`. */
  solverPubkey: string
  /**
   * How long a quote binds.
   *
   * § 5 puts cross-asset windows "on the order of ~30 seconds", and every pair
   * this corridor serves is cross-asset by construction: the solver is short
   * the market for the whole window, so the window is the exposure.
   */
  quoteValiditySeconds: number
  /** The chain's dust floor. A rule, unlike the carrier, which is per market. */
  dustSats: bigint
  /**
   * The offer covenant this solver will watch, derived from terms it has
   * already fixed. `offerVtxoScript` in the composition root.
   */
  deriveOffer: (terms: OfferTerms) => { pkScript: string; address: string }
  /** What is funded at the offer's script, or null while nothing is. */
  depositAt: (offerPkScript: string, depositLeg: AssetLeg | null) => Promise<ObservedDeposit | null>
  /** Spendable balance per asset id — `available`, never `total`. */
  balance: () => Promise<ReadonlyMap<AssetLeg, bigint>>
  fetchPrice: (feedUrl: string, pricePath: string) => Promise<Price>
  /** Spend the deposit through `fulfill`, paying the client. Returns the txid. */
  settle: (row: AssetRfqSwapRow) => Promise<string>
  /** The internal Taxi adapter, reached only for an explicit `recycle`.
   * OPTIONAL, and its absence is a REFUSAL rather than a default. `Partial`
   * because the gate below refuses a half-built one on its own. */
  receiveCarrierQuotes?: Partial<ReceiveCarrierQuotes>
  onError?: (id: string, error: unknown) => void
  now?: () => number
  newId?: () => string
}

export type AssetRfqQuoteRefusal =
  | 'rate_limited'
  | 'unsupported_pair'
  | 'unsupported_payload'
  | 'exact_out_unsupported'
  | 'price_unavailable'
  | 'fee_consumes_swap'
  | 'amount_out_of_range'
  | 'insufficient_inventory'
  | 'duplicate_swap'

export type AssetRfqQuoteOutcome =
  | { accepted: true; swap: AssetRfqSwapRow; carrierSats: bigint }
  | { accepted: false; reason: AssetRfqQuoteRefusal; detail?: string }

export interface AssetRfqQuoteRequest {
  requesterKey?: string
  rfqId: string
  pair: string
  amount: bigint
  amountSide: 'from' | 'to'
  makerPkScript: string
  makerPublicKey: string
  /** Absent is the legacy request; explicit modes apply to an asset payout only. */
  carrier?: AssetRfqCarrierChoice
}

/** How much of one leg a deposit holds — sats when the leg is BTC. */
const heldOf = (deposit: ObservedDeposit, leg: AssetLeg): bigint => {
  if (leg === null) return deposit.sats
  // Summed rather than found, for the reason `offerFill.ts` gives: nothing says
  // one output holds the whole balance, and an offer funded by two payments is
  // still an offer.
  let held = 0n
  for (const entry of deposit.assets) if (entry.assetId === leg) held += entry.amount
  return held
}

/**
 * The half of a market mark the solver controls: the price these terms fixed,
 * and which way round the trade ran.
 *
 * Spread into the insert so a degenerate price records NO snapshot rather than
 * half of one — a price with no direction beside it cannot be signed.
 */
const quoteSnapshot = (args: {
  resolved: { fromAmount: bigint; toAmount: bigint }
  market: AssetQuoteMarket
  pair: { from: AssetLeg; to: AssetLeg }
  feed: Price
  carrierSats: bigint
}): { quotePrice?: { impliedMantissa: bigint; scale: number; givesBase: boolean } } => {
  const { resolved, market, pair, feed, carrierSats } = args
  const givesBase = pair.from === market.base && pair.to === market.quote
  const implied = struckQuotePrice({
    fromAmount: resolved.fromAmount,
    toAmount: resolved.toAmount,
    pair,
    market,
    carrierSats,
    givesBase,
    scale: feed.scale,
  })
  return implied === null ? {} : { quotePrice: { impliedMantissa: implied.mantissa, scale: implied.scale, givesBase } }
}

export class AssetRfqSwapService {
  private readonly now: () => number
  private readonly quoteLimiter: RateLimiter
  private readonly newId: () => string
  private markets: readonly AssetRfqMarket[]
  private readonly serialise: Serialiser = createSerialiser()

  constructor(private readonly deps: AssetRfqDeps) {
    this.now = deps.now ?? nowSeconds
    this.quoteLimiter = deps.quoteLimiter ?? new RateLimiter(QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS, this.now)
    this.newId = deps.newId ?? (() => crypto.randomUUID())
    this.markets = deps.markets
  }

  /** Swap the live serve list. In-flight rows keep the terms already recorded. */
  replaceMarkets(markets: readonly AssetRfqMarket[]): Promise<void> {
    return this.serialise(async () => {
      this.markets = markets
    })
  }

  /** `priceTerm` is what the arithmetic nets; `publishedSats` is the PHYSICAL
   * dust `carrier_sats` reports on an explicit mode. */
  private async resolveCarrier(args: {
    carrier: AssetRfqCarrierChoice | undefined
    market: AssetRfqMarket
    pair: { from: AssetLeg; to: AssetLeg }
    request: AssetRfqQuoteRequest
    now: number
  }): Promise<
    | {
        ok: true
        terms: AssetRfqCarrierTerms | undefined
        priceTerm: bigint
        publishedSats: bigint
      }
    | { ok: false; reason: AssetRfqQuoteRefusal; detail: string }
  > {
    const { carrier, market, pair, request, now } = args
    if (carrier === undefined) {
      return { ok: true, terms: undefined, priceTerm: market.carrierSats, publishedSats: market.carrierSats }
    }
    if (carrier.mode === 'purchase') {
      const physical = this.deps.dustSats
      return {
        ok: true,
        terms: {
          mode: 'purchase',
          physicalSats: physical,
          // Bought, not advanced: no returnable loan and no receipt reserve.
          loanSats: 0n,
          receiptSats: 0n,
          serviceFareSats: 0n,
          pricedSats: physical,
          expiresAt: now + this.deps.quoteValiditySeconds,
        },
        priceTerm: physical,
        publishedSats: physical,
      }
    }

    // Refused BEFORE anything is priced, so an unconfigured deployment cannot
    // quote the market's free carrier.
    const adapter = completeReceiveCarrierQuotes(this.deps.receiveCarrierQuotes)
    if (!adapter) {
      return {
        ok: false,
        reason: 'price_unavailable',
        detail: 'recycle requested but this deployment has no receive-carrier adapter configured',
      }
    }
    // `pair.to` is non-null here: a BTC payout was refused before we got here.
    const assetId = pair.to as string
    let quote: ReceiveCarrierQuote
    try {
      quote = await adapter.resolve({
        quoteId: carrier.quoteId,
        makerPkScript: request.makerPkScript,
        makerPublicKey: request.makerPublicKey,
        assetId,
        now,
        admission: true,
      })
    } catch (error) {
      // An adapter that threw is an unavailable quote, never a free carrier.
      this.deps.onError?.('carrier', error)
      return { ok: false, reason: 'price_unavailable', detail: 'the receive-carrier quote could not be read' }
    }

    const inputExpiryFloor = snapshotInputExpiryFloor(
      (quote as ReceiveCarrierQuote & { inputExpiryFloor?: unknown }).inputExpiryFloor,
    )
    if (inputExpiryFloor === null) {
      return { ok: false, reason: 'price_unavailable', detail: 'carrier quote input expiry floor is invalid' }
    }
    quote = { ...quote, inputExpiryFloor }

    const rejected = this.validateCarrierQuote({ quote, request, assetId, now })
    if (rejected) return rejected

    const priceTerm = quote.receiptSats + quote.serviceFareSats
    return {
      ok: true,
      terms: {
        mode: 'recycle',
        quoteId: quote.quoteId,
        physicalSats: quote.physicalSats,
        loanSats: quote.loanSats,
        receiptSats: quote.receiptSats,
        serviceFareSats: quote.serviceFareSats,
        pricedSats: priceTerm,
        expiresAt: quote.expiresAt,
      },
      priceTerm,
      publishedSats: quote.physicalSats,
    }
  }

  /** Each request-bound field matched independently, so a refusal names the
   * field that disagreed. */
  private validateCarrierQuote(args: {
    quote: ReceiveCarrierQuote
    request: AssetRfqQuoteRequest
    assetId: string
    now: number
  }): { ok: false; reason: AssetRfqQuoteRefusal; detail: string } | undefined {
    const { quote, request, assetId, now } = args
    // Only meaningful when a recycle actually named an id; `purchase` has none.
    const expectedQuoteId = request.carrier?.mode === 'recycle' ? request.carrier.quoteId : undefined
    if (expectedQuoteId === undefined || quote.quoteId !== expectedQuoteId) {
      return { ok: false, reason: 'price_unavailable', detail: 'carrier quote id does not match the request' }
    }
    if (quote.makerPkScript !== request.makerPkScript) {
      return { ok: false, reason: 'price_unavailable', detail: 'carrier quote is for a different payout script' }
    }
    if (quote.makerPublicKey !== request.makerPublicKey) {
      return { ok: false, reason: 'price_unavailable', detail: 'carrier quote is for a different signer key' }
    }
    if (quote.assetId !== assetId) {
      return { ok: false, reason: 'price_unavailable', detail: 'carrier quote is for a different asset' }
    }
    if (quote.physicalSats !== this.deps.dustSats) {
      return { ok: false, reason: 'price_unavailable', detail: 'carrier quote physical sats are not this dust floor' }
    }
    if (quote.receiptSats <= 0n) {
      return { ok: false, reason: 'price_unavailable', detail: 'carrier quote receipt sats must be positive' }
    }
    if (quote.loanSats <= 0n) {
      return { ok: false, reason: 'price_unavailable', detail: 'carrier quote loan sats must be positive' }
    }
    if (quote.loanSats + quote.receiptSats !== quote.physicalSats) {
      return { ok: false, reason: 'price_unavailable', detail: 'carrier quote split does not sum to physical sats' }
    }
    if (quote.serviceFareSats < 0n) {
      return { ok: false, reason: 'price_unavailable', detail: 'carrier quote service fare must not be negative' }
    }
    if (!Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= now) {
      return { ok: false, reason: 'price_unavailable', detail: 'carrier quote is already expired' }
    }
    return undefined
  }

  /**
   * Issue or refuse terms for one request.
   *
   * Ordered so a refusal is the most specific true statement, and so the
   * expensive gate runs last: the pair and the market are answered without
   * touching the network, and only then is a price fetched.
   */
  quote(request: AssetRfqQuoteRequest): Promise<AssetRfqQuoteOutcome> {
    return this.serialise(() => this.quoteInner(request))
  }

  private async quoteInner(request: AssetRfqQuoteRequest): Promise<AssetRfqQuoteOutcome> {
    const pair = parseAssetPair(request.pair)
    if (!pair) {
      return {
        accepted: false,
        reason: 'unsupported_pair',
        detail: `pair ${JSON.stringify(request.pair)} is not an arkade-to-arkade pair with exactly one asset leg`,
      }
    }

    const market = this.markets.find(
      (m) => (pair.from === m.base && pair.to === m.quote) || (pair.from === m.quote && pair.to === m.base),
    )
    if (!market) return { accepted: false, reason: 'unsupported_pair', detail: 'no market configured for this pair' }

    // The bounds for THIS direction, in the units of the leg being paid out.
    // Resolved here rather than inside `resolveAssetQuote`, which by then has
    // one unambiguous payout leg and needs only one pair of numbers.
    const bounds = pair.from === market.base ? market.sellBase : market.buyBase
    const priced: AssetQuoteMarket = { ...market, minPayout: bounds.min, maxPayout: bounds.max }

    // An inapplicable FIELD (§ 1), not a pricing refusal: a BTC payout has no
    // carrier to want, so this is answered before the network.
    const carrier = request.carrier
    if (carrier !== undefined && pair.to === null) {
      return {
        accepted: false,
        reason: 'unsupported_payload',
        detail: 'profile.carrier applies to an asset payout only',
      }
    }

    // § 4.5: an rfq_id already bound to a negotiation is a conflict, whatever
    // became of that one. Checked BEFORE the feed read so a retry storm on one
    // id cannot drive traffic to the price source.
    if (await this.deps.store.findByRfqId(request.rfqId)) {
      return { accepted: false, reason: 'duplicate_swap', detail: 'rfq_id already names a negotiation' }
    }
    if (request.requesterKey !== undefined && !this.quoteLimiter.take(request.requesterKey)) {
      return { accepted: false, reason: 'rate_limited' }
    }

    const now = this.now()
    // BEFORE the expensive feed read, so an unavailable adapter cannot fall
    // through to a free market carrier.
    const resolvedCarrier = await this.resolveCarrier({ carrier, market, pair, request, now })
    if (!resolvedCarrier.ok) return { accepted: false, reason: resolvedCarrier.reason, detail: resolvedCarrier.detail }
    const { terms, priceTerm, publishedSats } = resolvedCarrier

    let feed: Price
    try {
      feed = await this.deps.fetchPrice(market.feedUrl, market.pricePath)
    } catch (error) {
      // An unreadable feed must never become a free fill.
      this.deps.onError?.('price', error)
      return { accepted: false, reason: 'price_unavailable', detail: 'the market feed could not be read' }
    }

    const resolved = resolveAssetQuote({
      pair,
      amount: request.amount,
      amountSide: request.amountSide,
      market: priced,
      feed,
      carrierSats: priceTerm,
      dustSats: this.deps.dustSats,
    })
    if (!resolved.ok) return { accepted: false, reason: resolved.reason }

    // § 9 permits a quote-time pre-check and does not accept it as sufficient —
    // `tick` runs the same gate again immediately before spending. Quoting a
    // payout the float already cannot cover would commit this solver to a price
    // it knows it cannot honour.
    let available: ReadonlyMap<AssetLeg, bigint>
    // ONE clock for the admission read and the window it admits.
    const admittedAt = this.now()
    if (terms?.mode === 'recycle') {
      const adapter = completeReceiveCarrierQuotes(this.deps.receiveCarrierQuotes)
      if (adapter === null) {
        return {
          accepted: false,
          reason: 'price_unavailable',
          detail: 'recycle requested but the receive-carrier adapter became unavailable',
        }
      }
      try {
        available = await adapter.available({
          quoteId: terms.quoteId!,
          makerPkScript: request.makerPkScript,
          makerPublicKey: request.makerPublicKey,
          assetId: pair.to as string,
          now: admittedAt,
          admission: true,
        })
      } catch (error) {
        this.deps.onError?.('carrier', error)
        return { accepted: false, reason: 'price_unavailable', detail: 'carrier inventory could not be read' }
      }
    } else {
      available = await this.deps.balance()
    }
    if ((available.get(pair.to) ?? 0n) < resolved.toAmount) {
      return { accepted: false, reason: 'insufficient_inventory' }
    }

    // AFTER every await above: `now` predates them, so a quote that expired
    // during any must not insert a row already in the past.
    const nowAtInsert = this.now()
    const validUntil =
      terms === undefined
        ? nowAtInsert + this.deps.quoteValiditySeconds
        : Math.min(admittedAt + this.deps.quoteValiditySeconds, terms.expiresAt)
    if (terms !== undefined && validUntil <= nowAtInsert) {
      return {
        accepted: false,
        reason: 'price_unavailable',
        detail: 'the carrier quote expired before it was recorded',
      }
    }

    const offer = this.deps.deriveOffer({
      wantAmount: resolved.toAmount,
      wantAssetId: pair.to,
      offerAssetId: pair.from,
      makerPkScript: request.makerPkScript,
      makerPublicKey: request.makerPublicKey,
    })

    try {
      const swap = await this.deps.store.insertQuote({
        id: this.newId(),
        rfqId: request.rfqId,
        // Re-derived rather than echoed, so the row records the pair this
        // solver actually priced rather than the client's spelling of it.
        pair: assetRfqPairFor(pair.from, pair.to),
        fromAssetId: pair.from,
        fromAmount: resolved.fromAmount,
        toAssetId: pair.to,
        toAmount: resolved.toAmount,
        makerPkScript: request.makerPkScript,
        makerPublicKey: request.makerPublicKey,
        offerPkScript: offer.pkScript,
        offerAddress: offer.address,
        solverPubkey: this.deps.solverPubkey,
        validUntil,
        // The price this quote FIXED — not the feed it was derived from.
        // Against a feed read at fill time it measures how far the market moved
        // while the quote was outstanding; against its own feed it would measure
        // the configured spread and nothing else.
        // Struck against what the PRICE netted, so the mark matches the
        // amounts an explicit mode actually quoted.
        ...quoteSnapshot({ resolved, market: priced, pair, feed, carrierSats: priceTerm }),
        ...(terms === undefined ? {} : { carrierTerms: terms }),
      })
      return { accepted: true, swap, carrierSats: publishedSats }
    } catch (error) {
      // Only the unique indexes mean duplicate — both onchain orchestrators narrow it so.
      if (error instanceof UniqueConstraintError) {
        return { accepted: false, reason: 'duplicate_swap', detail: 'a negotiation already holds this id or address' }
      }
      // Below the check: `onError` logs a failure to act on, and a lost race is neither.
      this.deps.onError?.(request.rfqId, error)
      throw error
    }
  }

  /**
   * Drive one negotiation one step. Re-entrant, and re-reads the row.
   *
   * Each arm ends at a compare-and-swap, so two ticks racing one row cannot
   * both act.
   */
  tick(id: string): Promise<void> {
    return this.serialise(() => this.drive(id))
  }

  private async drive(id: string): Promise<void> {
    const row = await this.deps.store.findById(id)
    if (!row) return
    switch (row.state) {
      case 'quoted':
        return this.whenQuoted(row)
      case 'funded':
        return this.whenFunded(row)
      case 'filling':
        return this.whenFilling(row)
      default:
        return
    }
  }

  /**
   * Drive EVERY non-terminal row one step.
   *
   * REQUIRED, and genuinely not `findRecoverable` + `tick` in a loop: a row
   * waiting on a DEADLINE — a quote nobody funded — produces no script activity
   * for a watcher to fire on, so this periodic pass is the only thing that ever
   * expires it.
   *
   * One row's failure is isolated from the rest: an indexer blip on the first
   * negotiation must not stop the second from being driven.
   */
  tickAll(): Promise<string[]> {
    return this.serialise(async () => {
      const driven: string[] = []
      for (const row of await this.deps.store.listNonTerminal()) {
        try {
          await this.drive(row.id)
          driven.push(row.id)
        } catch (error) {
          this.deps.onError?.(row.id, error)
        }
      }
      return driven
    })
  }

  /** Awaiting the client's deposit, until `valid_until`. */
  private async whenQuoted(row: AssetRfqSwapRow): Promise<void> {
    // EXPIRY FIRST, and before the deposit is even read. § 5: a lockup "first
    // observed after `valid_until` MUST be refused... never silently filled,
    // never silently re-priced". Advancing a lapsed negotiation to `funded`
    // would be recording that this solver intends to act on it, when the
    // action-time gate has already decided it never will — and it would report
    // a swap as progressing at the moment it stopped.
    //
    // Nothing is owed to the client by this refusal: its deposit, if any, was
    // never this solver's, and § 7.2's `cancel` reclaims it as a 2-of-2 of the
    // funder and the Arkade Service, needing nothing from here.
    if (this.now() > row.validUntil) {
      await this.deps.store.fail(row.id, 'quoted', 'quote expired before the deposit was observed')
      return
    }

    const deposit = await this.deps.depositAt(row.offerPkScript, row.fromAssetId)
    if (!deposit || heldOf(deposit, row.fromAssetId) <= 0n) return
    await this.deps.store.transition(row.id, 'quoted', 'funded', {
      deposit_txid: deposit.txid,
      deposit_vout: deposit.vout,
    })
  }

  /**
   * A deposit is at the offer's script. Decide, at THIS instant, whether to
   * spend it — § 9's action-time gate.
   */
  private async whenFunded(row: AssetRfqSwapRow): Promise<void> {
    const carrierTerms = row.carrierTerms
    const receiveCarrier =
      carrierTerms?.mode === 'recycle' ? completeReceiveCarrierQuotes(this.deps.receiveCarrierQuotes) : null
    const deposit = await this.deps.depositAt(row.offerPkScript, row.fromAssetId)
    let available: ReadonlyMap<AssetLeg, bigint>
    if (carrierTerms?.mode === 'recycle') {
      if (receiveCarrier === null) {
        await this.deps.store.fail(row.id, 'funded', 'not filled: receive-carrier adapter unavailable')
        return
      }
      try {
        available = await receiveCarrier.available({
          quoteId: carrierTerms.quoteId!,
          makerPkScript: row.makerPkScript,
          makerPublicKey: row.makerPublicKey,
          assetId: row.toAssetId as string,
          now: this.now(),
        })
      } catch (error) {
        this.deps.onError?.(row.id, error)
        await this.deps.store.fail(row.id, 'funded', 'not filled: receive-carrier inventory unavailable')
        return
      }
    } else {
      available = await this.deps.balance()
    }
    const decision = evaluateAssetFill({
      toAmount: row.toAmount,
      toAssetId: row.toAssetId,
      fromAmount: row.fromAmount,
      depositedAmount: deposit ? heldOf(deposit, row.fromAssetId) : 0n,
      available,
      now: this.now(),
      validUntil: row.validUntil,
    })
    if (!decision.fill) {
      // Nothing has been submitted, so every refusal here is clean: the row
      // ends `refused` and the client's deposit — which was never ours —
      // remains its own to reclaim with `cancel`.
      await this.deps.store.fail(row.id, 'funded', `not filled: ${decision.reason}`)
      return
    }

    // Intent BEFORE the irreversible step. A crash between this CAS and the
    // submission leaves a row that says something may be in flight, rather than
    // one that still reads fillable and would be submitted twice.
    // Carrying the outpoint the decision was made ABOUT: the settle spends the RECORDED one.
    const seen = deposit ? { deposit_txid: deposit.txid, deposit_vout: deposit.vout } : undefined
    if (!(await this.deps.store.transition(row.id, 'funded', 'filling', seen))) return
    if (receiveCarrier !== null) {
      try {
        const filling = await this.deps.store.get(row.id)
        const outcome: unknown = await receiveCarrier.settle(filling)
        const { status, txid } = (typeof outcome === 'object' && outcome !== null ? outcome : {}) as {
          status?: unknown
          txid?: unknown
        }
        if (status === 'submitted') return
        if (status !== 'settled') throw new Error('receive-carrier settlement returned a malformed outcome')
        if (!isCanonicalTxid(txid)) {
          throw new Error(`receive-carrier settlement returned invalid txid '${String(txid)}'`)
        }
        await this.completeReceiveCarrierFill(filling, txid)
      } catch (error) {
        this.deps.onError?.(row.id, error)
      }
      return
    }

    try {
      const txid = await this.deps.settle(await this.deps.store.get(row.id))
      const filled = await this.deps.store.transition(row.id, 'filling', 'filled', { fill_txid: txid })
      // AFTER the transition, never before. A feed read between `settle` and
      // this CAS would widen the window in which a crash leaves a submitted fill
      // reading `filling` — which `recoverFilling` escalates to `stuck`, needing
      // a human. The money is already moved by the time this runs, so the worst
      // a slow or broken feed can cost is the mark itself.
      //
      // Only on a row THIS call moved. A lost CAS means another worker already
      // escalated it, and marking a `stuck` row prices a fill that is under
      // investigation.
      if (filled) await this.recordFillMark(row)
    } catch (error) {
      // `filling` fails to `stuck`, never to something retryable: the spend may
      // already have been submitted, and only a human can tell which.
      this.deps.onError?.(row.id, error)
      await this.deps.store.fail(row.id, 'filling', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * What the market said as the fill landed — the other half of the mark.
   *
   * PURE OBSERVATION, and every failure path is a silent no-op: no market for
   * the pair, an unreadable feed, a non-positive price. The fill has already
   * settled by the time this runs, and a swap that succeeded must never be
   * reported as anything else over a number used only for reporting. That is the
   * same rule the Lightning rail follows for a realized routing fee, and the
   * opposite of the quote path's, where an unreadable feed must stop a quote.
   */
  private async recordFillMark(row: AssetRfqSwapRow): Promise<void> {
    try {
      const market = this.markets.find(
        (m) =>
          (row.fromAssetId === m.base && row.toAssetId === m.quote) ||
          (row.fromAssetId === m.quote && row.toAssetId === m.base),
      )
      // Reported, not swallowed. A pair quoted under an earlier configuration
      // goes unmarked FOREVER, and silence reads on the screen as "the feature
      // is not deployed" rather than "this market is misconfigured".
      if (!market) {
        this.deps.onError?.('price', new Error(`no market configured for ${row.pair}; fill ${row.id} goes unmarked`))
        return
      }
      const feed = await this.deps.fetchPrice(market.feedUrl, market.pricePath)
      if (feed.mantissa <= 0n || feed.scale < 0) {
        this.deps.onError?.('price', new Error(`unusable price for ${row.pair}: ${feed.mantissa}e-${feed.scale}`))
        return
      }
      await this.deps.store.recordFillMark(row.id, { mantissa: feed.mantissa, scale: feed.scale })
    } catch (error) {
      this.deps.onError?.('price', error)
    }
  }

  private async completeReceiveCarrierFill(row: AssetRfqSwapRow, txid: string): Promise<void> {
    const filled = await this.deps.store.transition(row.id, 'filling', 'filled', { fill_txid: txid })
    if (filled) await this.recordFillMark(row)
  }

  /** A recovered `filling` row is never resubmitted. Recycles have a dedicated
   * observer; legacy rows retain the existing stuck-over-silence policy. */
  private async whenFilling(row: AssetRfqSwapRow): Promise<void> {
    if (row.carrierTerms?.mode === 'recycle') {
      const adapter = completeReceiveCarrierQuotes(this.deps.receiveCarrierQuotes)
      if (adapter === null) {
        this.deps.onError?.(row.id, new Error('receive-carrier adapter unavailable while fill outcome is unknown'))
        return
      }
      try {
        const outcome: unknown = await adapter.reconcile(row)
        if (typeof outcome === 'object' && outcome !== null && (outcome as { status?: unknown }).status === 'pending') {
          return
        }
        if (typeof outcome === 'object' && outcome !== null && (outcome as { status?: unknown }).status === 'stuck') {
          // `fail` from `filling` is `stuck`: unobservable is not never-sent.
          const reason = (outcome as { reason?: unknown }).reason
          await this.deps.store.fail(
            row.id,
            'filling',
            typeof reason === 'string' && reason.length > 0 ? reason : 'receive-carrier fill outcome is unobservable',
          )
          return
        }
        if (
          typeof outcome !== 'object' ||
          outcome === null ||
          (outcome as { status?: unknown }).status !== 'settled' ||
          !isCanonicalTxid((outcome as { txid?: unknown }).txid)
        ) {
          throw new Error('receive-carrier reconciliation returned a malformed outcome')
        }
        await this.completeReceiveCarrierFill(row, (outcome as { txid: string }).txid)
      } catch (error) {
        this.deps.onError?.(row.id, error)
      }
      return
    }
    await this.deps.store.fail(row.id, 'filling', 'fill outcome unknown after restart; check the offer address')
  }
}

/** The states a park may leave a row in — `parkVia`'s `parked` list. */
export const ASSET_RFQ_PARKED: readonly AssetRfqSwapState[] = ['stuck', 'refused']
