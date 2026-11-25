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
  struckQuotePrice,
  type AssetLeg,
  type AssetQuoteMarket,
} from '@arkade-os/solver-core/core/assetRfq.js'
import { decomposeAssetQuote } from '@arkade-os/solver-core/core/pricingPreview.js'
import type { Price } from '@arkade-os/solver-core/core/priceFeed.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { askApprovalFor, type ApprovalCheck } from '@arkade-os/solver-core/core/approvalGate.js'
import { capture, unwrap } from '@arkade-os/solver-core/util/capture.js'
import { createSerialiser, type Serialiser } from '@arkade-os/solver-core/util/serialise.js'
import { QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS, RateLimiter } from '@arkade-os/solver-core/core/rateLimit.js'
import { UniqueConstraintError } from '@arkade-os/solver-core/core/driver.js'
import {
  DEPOSIT_SPENT_REASON,
  OfferNotSubmittedError,
  OfferSubmitRejectedError,
  type FulfillOptions,
} from '@arkade-os/solver-arkade/arkade/offerFulfill.js'
import { assetRfqPairFor, type AssetRfqCarrierChoice } from '../wire/assetRfqPayloads.js'
import { AssetRfqSwapStore, type AssetRfqCarrierTerms, type AssetRfqSwapRow } from '../db/assetRfqSwaps.js'
import type { DirectFillParentProof } from '../db/offerFills.js'

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
  rfqId: string
}

/** What the Taxi adapter answers for ONE recycle quote id: a trusted service adapter, never caller JSON. */
export interface ReceiveCarrierQuote {
  quoteId: string
  makerPkScript: string
  makerPublicKey: string
  assetId: string
  physicalSats: bigint
  loanSats: bigint
  receiptSats: bigint
  serviceFareSats: bigint
  /** `recycle_receiver` only: which Taxi answered, re-checked against the request's `taxi_key`. */
  taxiKey?: string
  /** Receiver-paid only: what the payee pays its Taxi at claim; an asset fare comes out of the delivery. */
  receiverFare?: Readonly<{ currency: 'sats' | 'asset'; units: bigint }>
  /** Unix seconds, read against `now` so a stale quote cannot be priced. */
  expiresAt: number
}

export interface ReceiveCarrierQuoteRequest {
  quoteId: string
  makerPkScript: string
  makerPublicKey: string
  assetId: string
  now: number
  /** Admission rather than a fill: a fill re-anchors on a later clock, so admission keeps room to spare. */
  admission: boolean
  /** Absent resolves against the configured Taxi. */
  taxi?: { url: string; operatorKey: string }
  receiverPaid?: boolean
}

export interface ReceiveCarrierQuotes {
  resolve: (request: ReceiveCarrierQuoteRequest) => Promise<ReceiveCarrierQuote>
  /** Re-reads the named quote and answers the inventory a carrier fill could spend, net of reservations. */
  available: (request: ReceiveCarrierQuoteRequest) => Promise<ReadonlyMap<AssetLeg, bigint>>
}

/** Fill time kept between `valid_until` and the Taxi quote's expiry, which the Taxi enforces at submit:
 * four 5 s round trips (settle's read, the fill request, the post-sign read, the submit) and 10 s of skew. */
export const CARRIER_FILL_MARGIN_SECONDS = 30

/** The longest a carrier quote may bind this solver's fill inputs. */
export const MAX_ASSET_QUOTE_VALIDITY_SECONDS = 900

/** Settled through the carrier adapter rather than the generic spend. */
export const carrierSettled = (terms: AssetRfqCarrierTerms | null | undefined): terms is AssetRfqCarrierTerms =>
  terms?.mode === 'recycle' || terms?.mode === 'recycle_receiver'

/** What every read of a persisted row must carry, so it verifies the Taxi and payer its quote did. */
export const receiveCarrierTaxiOf = (
  terms: AssetRfqCarrierTerms | null | undefined,
): Pick<ReceiveCarrierQuoteRequest, 'taxi' | 'receiverPaid'> => {
  if (terms?.mode !== 'recycle_receiver') return {}
  if (terms.taxiUrl === undefined || terms.taxiKey === undefined) {
    throw new Error('a recycle_receiver carrier names no Taxi to resolve against')
  }
  return { taxi: { url: terms.taxiUrl, operatorKey: terms.taxiKey }, receiverPaid: true }
}

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
  /** arkd's smallest fundable output, `max(dust, vtxoMin)`. Floors a sats payout only. */
  minOutputSats?: bigint
  /**
   * The offer covenant this solver will watch, derived from terms it has
   * already fixed. `offerVtxoScript` in the composition root.
   */
  deriveOffer: (terms: OfferTerms, contractVersion?: string) => { pkScript: string; address: string }
  /** What is funded at the offer's script, or null while nothing is. */
  depositAt: (offerPkScript: string, depositLeg: AssetLeg | null) => Promise<ObservedDeposit | null>
  /** Spendable balance per asset id — `available`, never `total`. */
  balance: () => Promise<ReadonlyMap<AssetLeg, bigint>>
  fetchPrice: (feedUrl: string, pricePath: string) => Promise<Price>
  /** Spend the deposit through `fulfill`, paying the client. Returns the txid.
   * `options.markSubmitting` gates the submission. @see FulfillOptions */
  settle: (row: AssetRfqSwapRow, options?: FulfillOptions) => Promise<string>
  /** The Taxi adapter, reached only for an explicit recycle. Absent is a REFUSAL, never a default. */
  receiveCarrierQuotes?: ReceiveCarrierQuotes
  /** The large-swap approval gate. Absent means no gate. @see ops/approvals.ts */
  approvalGate?: ApprovalCheck
  onError?: (id: string, error: unknown) => void
  /**
   * A fill put back to `funded` because the float was pinned or short. EVERY
   * deferral, not only the first: `validUntil` bounds the count.
   */
  onDeferred?: (id: string, error: unknown) => void
  now?: () => number
  newId?: () => string
}

export type AssetRfqQuoteRefusal =
  | 'rate_limited'
  | 'unsupported_pair'
  | 'unsupported_payload'
  | 'price_unavailable'
  | 'fee_consumes_swap'
  | 'amount_out_of_range'
  | 'payout_below_dust'
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
  /** Absent is the request as it was before the field existed; a mode applies to an asset payout only. */
  carrier?: AssetRfqCarrierChoice
  /** The negotiated contract version, if any. Absent derives the corridor's baseline. */
  contractVersion?: string
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

    // An inapplicable field (§ 1): a BTC payout has no carrier to want, so this is answered before the network.
    if (request.carrier !== undefined && pair.to === null) {
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

    // BEFORE the feed read, so an unavailable adapter cannot fall through to the market's free carrier.
    const carrier = await this.resolveCarrier(request, market, pair.to)
    if (!carrier.ok) return { accepted: false, reason: 'price_unavailable', detail: carrier.detail }
    const terms = carrier.terms

    const inventoryP = carrierSettled(terms) ? undefined : capture(this.deps.balance())
    let feed: Price
    try {
      feed = await this.deps.fetchPrice(market.feedUrl, market.pricePath)
    } catch (error) {
      // An unreadable feed must never become a free fill.
      this.deps.onError?.('price', error)
      return { accepted: false, reason: 'price_unavailable', detail: 'the market feed could not be read' }
    }

    const resolved = decomposeAssetQuote({
      pair,
      amount: request.amount,
      amountSide: request.amountSide,
      market: priced,
      feed,
      carrierSats: carrier.priceTerm,
      dustSats: this.deps.dustSats,
    })
    if (!resolved.ok) return { accepted: false, reason: resolved.reason }
    // The Taxi's own rule (`fare_exceeds_delivery`), refused before a payer funds what it would refuse.
    if (carrier.receiverFare?.currency === 'asset' && carrier.receiverFare.units >= resolved.toAmount) {
      return {
        accepted: false,
        reason: 'price_unavailable',
        detail: `the receiver fare of ${carrier.receiverFare.units} asset units is not below the ${resolved.toAmount} delivered`,
      }
    }
    if (pair.to === null && resolved.toAmount < (this.deps.minOutputSats ?? 0n)) {
      return { accepted: false, reason: 'payout_below_dust' }
    }

    // § 9 permits a quote-time pre-check and does not accept it as sufficient —
    // `tick` runs the same gate again immediately before spending. Quoting a
    // payout the float already cannot cover would commit this solver to a price
    // it knows it cannot honour.
    const available = carrierSettled(terms)
      ? await this.carrierInventory(request, terms, pair.to)
      : unwrap(await inventoryP!)
    if (available === null) {
      return { accepted: false, reason: 'price_unavailable', detail: 'carrier inventory could not be read' }
    }
    if ((available.get(pair.to) ?? 0n) < resolved.toAmount) {
      return { accepted: false, reason: 'insufficient_inventory' }
    }

    // A carrier quote binds no longer than its Taxi quote, less the time a fill needs after funding.
    const carrierUntil =
      terms === undefined
        ? undefined
        : Math.min(
            this.now() + this.deps.quoteValiditySeconds,
            terms.expiresAt - (carrierSettled(terms) ? CARRIER_FILL_MARGIN_SECONDS : 0),
          )
    if (carrierUntil !== undefined && carrierUntil <= this.now()) {
      return {
        accepted: false,
        reason: 'price_unavailable',
        detail: 'the carrier quote expires too soon to fill after funding',
      }
    }

    const offer = this.deps.deriveOffer(
      {
        wantAmount: resolved.toAmount,
        wantAssetId: pair.to,
        offerAssetId: pair.from,
        makerPkScript: request.makerPkScript,
        makerPublicKey: request.makerPublicKey,
        rfqId: request.rfqId,
      },
      request.contractVersion,
    )

    try {
      const swap = await this.deps.store.insertQuote({
        id: this.newId(),
        rfqId: request.rfqId,
        // Re-derived rather than echoed, so the row records the pair this
        // solver actually priced rather than the client's spelling of it.
        pair: assetRfqPairFor(pair.from, pair.to),
        fromAssetId: pair.from,
        fromAmount: resolved.fromAmount,
        fromDecimals: pair.from === priced.base ? priced.baseDecimals : priced.quoteDecimals,
        fromFlatFee: resolved.flatFee,
        toAssetId: pair.to,
        toAmount: resolved.toAmount,
        toDecimals: pair.to === priced.base ? priced.baseDecimals : priced.quoteDecimals,
        toSpread: resolved.spreadFee,
        makerPkScript: request.makerPkScript,
        makerPublicKey: request.makerPublicKey,
        offerPkScript: offer.pkScript,
        offerAddress: offer.address,
        solverPubkey: this.deps.solverPubkey,
        validUntil: this.now() + this.deps.quoteValiditySeconds,
        // The price this quote FIXED — not the feed it was derived from.
        // Against a feed read at fill time it measures how far the market moved
        // while the quote was outstanding; against its own feed it would measure
        // the configured spread and nothing else.
        ...quoteSnapshot({ resolved, market: priced, pair, feed, carrierSats: carrier.priceTerm }),
        ...(terms === undefined ? {} : { validUntil: carrierUntil!, carrierTerms: terms }),
        ...(request.contractVersion === undefined ? {} : { contractVersion: request.contractVersion }),
      })
      return { accepted: true, swap, carrierSats: carrier.publishedSats }
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
    const [deposit, available] = await Promise.all([
      this.deps.depositAt(row.offerPkScript, row.fromAssetId),
      this.deps.balance(),
    ])
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

    // AFTER the fill decision, BEFORE the CAS. The TO leg is what the solver pays,
    // and `decision.fill` is false past `validUntil`, so a hold still terminates.
    if (!(await askApprovalFor(this.deps.approvalGate, row.id, { assetId: row.toAssetId, amount: row.toAmount })))
      return
    // Intent BEFORE the irreversible step. A crash between this CAS and the
    // submission leaves a row that says something may be in flight, rather than
    // one that still reads fillable and would be submitted twice.
    // Carrying the outpoint the decision was made ABOUT: the settle spends the RECORDED one.
    // `selecting`: nothing is sent yet, which is what makes a walk-back sound.
    const seen = deposit ? { deposit_txid: deposit.txid, deposit_vout: deposit.vout } : {}
    if (!(await this.deps.store.transition(row.id, 'funded', 'filling', { ...seen, fill_phase: 'selecting' }))) return
    try {
      const txid = await this.deps.settle(await this.deps.store.get(row.id), {
        markSubmitting: () => this.deps.store.markSubmitting(row.id),
      })
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
      // The first of the two shapes that are NOT ambiguous: raised above the call
      // that submits, so the row goes back to `funded` for a later tick. No counter —
      // `validUntil` already bounds the retrying — and no fill mark, nothing filled.
      if (error instanceof OfferNotSubmittedError) {
        if (await this.deps.store.revertUnsubmitted(row.id)) this.deps.onDeferred?.(row.id, error)
        return
      }
      // Nothing was submitted, so neither exit leaves exposure: a spent DEPOSIT needs nobody, and
      // anything else re-selects next tick. A lost CAS means another writer moved the row and reports it.
      if (error instanceof OfferSubmitRejectedError) {
        if (error.depositSpent) await this.deps.store.refuseRejectedSubmit(row.id, DEPOSIT_SPENT_REASON)
        else if (await this.deps.store.revertRejectedSubmit(row.id)) this.deps.onDeferred?.(row.id, error)
        return
      }
      // `filling` fails to `stuck`, never to something retryable: the spend may
      // already have been submitted, and only a human can tell which. The alert follows the
      // WRITE, so a tick that lost the CAS says nothing: the writer that parked it reports it.
      const reason = error instanceof Error ? error.message : String(error)
      if (await this.deps.store.fail(row.id, 'filling', reason)) this.deps.onError?.(row.id, error)
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

  /**
   * A row found still `filling` is one this process restarted mid-fill: ticks
   * are serialised, so no attempt of this process is in flight here.
   *
   * `selecting` walks back to `funded`; the next tick re-runs § 9's gate over it.
   * Anything else is escalated to `stuck` rather than resubmitted. Whether the earlier
   * `fulfill` landed is not answerable from here, and guessing "it did not"
   * pays the client twice out of this solver's float. § 8's stuck-over-silence
   * is exactly this case: exposure exists and progress needs a human.
   */
  private async whenFilling(row: AssetRfqSwapRow): Promise<void> {
    if (row.fillPhase === 'selecting') {
      await this.deps.store.revertUnsubmitted(row.id)
      return
    }
    await this.deps.store.fail(row.id, 'filling', 'fill outcome unknown after restart; check the offer address')
  }

  /** The journal's proof that a fill landed, recorded in the queue the fills run in, with the mark a lost reply skipped. */
  recoverDirectFill(proof: DirectFillParentProof, fillTxid: string): Promise<boolean> {
    return this.serialise(async () => {
      const before = await this.deps.store.findById(proof.id)
      const recovered = await this.deps.store.recoverDirectFill(proof, fillTxid)
      if (recovered && before?.state !== 'filled' && before?.fillPriceMantissa === null)
        await this.recordFillMark(before)
      return recovered
    })
  }

  /** `priceTerm` is what the amounts net; `publishedSats` is the physical dust `carrier_sats` reports. */
  private async resolveCarrier(
    request: AssetRfqQuoteRequest,
    market: AssetRfqMarket,
    payout: AssetLeg,
  ): Promise<
    | {
        ok: true
        terms?: AssetRfqCarrierTerms
        priceTerm: bigint
        publishedSats: bigint
        receiverFare?: ReceiveCarrierQuote['receiverFare']
      }
    | { ok: false; detail: string }
  > {
    const carrier = request.carrier
    if (carrier === undefined) return { ok: true, priceTerm: market.carrierSats, publishedSats: market.carrierSats }
    const dust = this.deps.dustSats
    if (carrier.mode === 'purchase') {
      // Bought outright: no loan to return and no receipt to reserve.
      const expiresAt = this.now() + this.deps.quoteValiditySeconds
      const terms = { mode: 'purchase' as const, physicalSats: dust, loanSats: 0n, receiptSats: 0n }
      return {
        ok: true,
        terms: { ...terms, serviceFareSats: 0n, pricedSats: dust, expiresAt },
        priceTerm: dust,
        publishedSats: dust,
      }
    }
    const adapter = this.deps.receiveCarrierQuotes
    if (!adapter) return { ok: false, detail: `${carrier.mode} requested but no receive-carrier adapter is configured` }
    const now = this.now()
    let quote: ReceiveCarrierQuote
    try {
      quote = await adapter.resolve({
        quoteId: carrier.quoteId,
        makerPkScript: request.makerPkScript,
        makerPublicKey: request.makerPublicKey,
        assetId: payout as string,
        now,
        admission: true,
        ...(carrier.mode === 'recycle_receiver'
          ? { taxi: { url: carrier.taxiUrl, operatorKey: carrier.taxiKey }, receiverPaid: true }
          : {}),
      })
    } catch (error) {
      // An adapter that threw is an unavailable quote, never a free carrier.
      this.deps.onError?.('carrier', error)
      return { ok: false, detail: 'the receive-carrier quote could not be read' }
    }
    const refused = this.carrierQuoteRefusal(quote, request, payout as string, now)
    if (refused) return { ok: false, detail: refused }
    // `physicalSats` and `loanSats` are this solver's own dust here, never a Taxi-supplied figure.
    if (carrier.mode === 'recycle_receiver') {
      const loan = { physicalSats: dust, loanSats: dust, receiptSats: 0n, serviceFareSats: 0n, pricedSats: 0n }
      return {
        ok: true,
        terms: {
          mode: 'recycle_receiver',
          quoteId: quote.quoteId,
          ...loan,
          expiresAt: quote.expiresAt,
          taxiUrl: carrier.taxiUrl,
          taxiKey: carrier.taxiKey,
        },
        priceTerm: 0n,
        publishedSats: 0n,
        receiverFare: quote.receiverFare,
      }
    }
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

  /** Each request-bound field is matched on its own, so a refusal names the one that disagreed. */
  private carrierQuoteRefusal(
    quote: ReceiveCarrierQuote,
    request: AssetRfqQuoteRequest,
    assetId: string,
    now: number,
  ): string | undefined {
    const carrier = request.carrier
    if (carrier?.mode !== 'recycle' && carrier?.mode !== 'recycle_receiver') return 'carrier quote named by no recycle'
    if (quote.quoteId !== carrier.quoteId) return 'carrier quote id does not match the request'
    if (quote.makerPkScript !== request.makerPkScript) return 'carrier quote is for a different payout script'
    if (quote.makerPublicKey !== request.makerPublicKey) return 'carrier quote is for a different signer key'
    if (quote.assetId !== assetId) return 'carrier quote is for a different asset'
    if (quote.physicalSats !== this.deps.dustSats) return 'carrier quote physical sats are not this dust floor'
    if (carrier.mode === 'recycle_receiver') {
      // The payee's Taxi fronts the whole dust, so the split a recycle needs is exactly what fails here.
      if (quote.receiptSats !== 0n) return 'carrier quote receipt sats must be zero on recycle_receiver'
      if (quote.serviceFareSats !== 0n) return 'carrier quote service fare must be zero on recycle_receiver'
      if (quote.loanSats !== quote.physicalSats) return 'carrier quote loan must be the whole dust on recycle_receiver'
      if (quote.taxiKey !== carrier.taxiKey) return 'carrier quote taxi key differs from the one the request named'
    } else {
      if (quote.receiptSats <= 0n) return 'carrier quote receipt sats must be positive'
      if (quote.loanSats <= 0n) return 'carrier quote loan sats must be positive'
      if (quote.loanSats + quote.receiptSats !== quote.physicalSats)
        return 'carrier quote split does not sum to physical sats'
      if (quote.serviceFareSats < 0n) return 'carrier quote service fare must not be negative'
    }
    if (!Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= now) return 'carrier quote is already expired'
    if (quote.expiresAt - now > MAX_ASSET_QUOTE_VALIDITY_SECONDS)
      return 'carrier quote binds for longer than this solver will'
    return undefined
  }

  /** The adapter's inventory for a carrier fill; null when it could not be read. */
  private async carrierInventory(
    request: AssetRfqQuoteRequest,
    terms: AssetRfqCarrierTerms,
    payout: AssetLeg,
  ): Promise<ReadonlyMap<AssetLeg, bigint> | null> {
    try {
      return await this.deps.receiveCarrierQuotes!.available({
        quoteId: terms.quoteId!,
        makerPkScript: request.makerPkScript,
        makerPublicKey: request.makerPublicKey,
        assetId: payout as string,
        now: this.now(),
        admission: true,
        ...receiveCarrierTaxiOf(terms),
      })
    } catch (error) {
      this.deps.onError?.('carrier', error)
      return null
    }
  }
}
