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
  type AssetLeg,
  type AssetQuoteMarket,
} from '@arkade-os/solver-core/core/assetRfq.js'
import type { Price } from '@arkade-os/solver-core/core/priceFeed.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { assetRfqPairFor } from '../wire/assetRfqPayloads.js'
import { AssetRfqSwapStore, type AssetRfqSwapRow, type AssetRfqSwapState } from '../db/assetRfqSwaps.js'

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

export interface AssetRfqDeps {
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
  onError?: (id: string, error: unknown) => void
  now?: () => number
  newId?: () => string
}

export type AssetRfqQuoteRefusal =
  | 'unsupported_pair'
  | 'exact_out_unsupported'
  | 'price_unavailable'
  | 'fee_consumes_swap'
  | 'amount_out_of_range'
  | 'insufficient_inventory'
  | 'duplicate_swap'

export type AssetRfqQuoteOutcome =
  { accepted: true; swap: AssetRfqSwapRow } | { accepted: false; reason: AssetRfqQuoteRefusal; detail?: string }

export interface AssetRfqQuoteRequest {
  rfqId: string
  pair: string
  amount: bigint
  amountSide: 'from' | 'to'
  makerPkScript: string
  makerPublicKey: string
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

export class AssetRfqSwapService {
  private readonly now: () => number
  private readonly newId: () => string

  constructor(private readonly deps: AssetRfqDeps) {
    this.now = deps.now ?? nowSeconds
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Issue or refuse terms for one request.
   *
   * Ordered so a refusal is the most specific true statement, and so the
   * expensive gate runs last: the pair and the market are answered without
   * touching the network, and only then is a price fetched.
   */
  async quote(request: AssetRfqQuoteRequest): Promise<AssetRfqQuoteOutcome> {
    const pair = parseAssetPair(request.pair)
    if (!pair) {
      return {
        accepted: false,
        reason: 'unsupported_pair',
        detail: `pair ${JSON.stringify(request.pair)} is not an arkade-to-arkade pair with exactly one asset leg`,
      }
    }

    const market = this.deps.markets.find(
      (m) => (pair.from === m.base && pair.to === m.quote) || (pair.from === m.quote && pair.to === m.base),
    )
    if (!market) return { accepted: false, reason: 'unsupported_pair', detail: 'no market configured for this pair' }

    // The bounds for THIS direction, in the units of the leg being paid out.
    // Resolved here rather than inside `resolveAssetQuote`, which by then has
    // one unambiguous payout leg and needs only one pair of numbers.
    const bounds = pair.from === market.base ? market.sellBase : market.buyBase
    const priced: AssetQuoteMarket = { ...market, minPayout: bounds.min, maxPayout: bounds.max }

    // § 4.5: an rfq_id already bound to a negotiation is a conflict, whatever
    // became of that one. Checked BEFORE the feed read so a retry storm on one
    // id cannot drive traffic to the price source.
    if (await this.deps.store.findByRfqId(request.rfqId)) {
      return { accepted: false, reason: 'duplicate_swap', detail: 'rfq_id already names a negotiation' }
    }

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
    })
    if (!resolved.ok) return { accepted: false, reason: resolved.reason }

    // § 9 permits a quote-time pre-check and does not accept it as sufficient —
    // `tick` runs the same gate again immediately before spending. Quoting a
    // payout the float already cannot cover would commit this solver to a price
    // it knows it cannot honour.
    const available = await this.deps.balance()
    if ((available.get(pair.to) ?? 0n) < resolved.toAmount) {
      return { accepted: false, reason: 'insufficient_inventory' }
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
        validUntil: this.now() + this.deps.quoteValiditySeconds,
      })
      return { accepted: true, swap }
    } catch (error) {
      // The unique indexes are the race-loser's answer: another worker quoted
      // this rfq_id, or already watches this offer address. Either way this
      // request must not proceed to a second row.
      this.deps.onError?.(request.rfqId, error)
      return { accepted: false, reason: 'duplicate_swap', detail: 'a negotiation already holds this id or address' }
    }
  }

  /**
   * Drive one negotiation one step. Re-entrant, and re-reads the row.
   *
   * Each arm ends at a compare-and-swap, so two ticks racing one row cannot
   * both act.
   */
  async tick(id: string): Promise<void> {
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
  async tickAll(): Promise<string[]> {
    const driven: string[] = []
    for (const row of await this.deps.store.listNonTerminal()) {
      try {
        await this.tick(row.id)
        driven.push(row.id)
      } catch (error) {
        this.deps.onError?.(row.id, error)
      }
    }
    return driven
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
    const deposit = await this.deps.depositAt(row.offerPkScript, row.fromAssetId)
    const decision = evaluateAssetFill({
      toAmount: row.toAmount,
      toAssetId: row.toAssetId,
      fromAmount: row.fromAmount,
      depositedAmount: deposit ? heldOf(deposit, row.fromAssetId) : 0n,
      available: await this.deps.balance(),
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
    if (!(await this.deps.store.transition(row.id, 'funded', 'filling'))) return
    try {
      const txid = await this.deps.settle(await this.deps.store.get(row.id))
      await this.deps.store.transition(row.id, 'filling', 'filled', { fill_txid: txid })
    } catch (error) {
      // `filling` fails to `stuck`, never to something retryable: the spend may
      // already have been submitted, and only a human can tell which.
      this.deps.onError?.(row.id, error)
      await this.deps.store.fail(row.id, 'filling', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * A row found still `filling` is one whose submission outcome is unknown —
   * this process restarted mid-fill.
   *
   * Escalated to `stuck` rather than resubmitted. Whether the earlier
   * `fulfill` landed is not answerable from here, and guessing "it did not"
   * pays the client twice out of this solver's float. § 8's stuck-over-silence
   * is exactly this case: exposure exists and progress needs a human.
   */
  private async whenFilling(row: AssetRfqSwapRow): Promise<void> {
    await this.deps.store.fail(row.id, 'filling', 'fill outcome unknown after restart; check the offer address')
  }
}

/** The states a park may leave a row in — `parkVia`'s `parked` list. */
export const ASSET_RFQ_PARKED: readonly AssetRfqSwapState[] = ['stuck', 'refused']
