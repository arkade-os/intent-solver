/**
 * Wiring for Arkade asset-swap offers: the pieces exist, this composes them.
 *
 * `evaluateOfferFill` (core), the packet/deposit/inventory adapters (arkade) and
 * `OfferFillStore` (corridors) each landed separately and had no caller in
 * `src/`. This is that caller.
 *
 * NOT a corridor. Both legs are on Arkade and the maker's covenant obliges the
 * fill to pay them, so there is no HTLC, no deadline and no refund — which is
 * why offers are absent from `CORRIDORS` rather than missing from it. The solver
 * is always the TAKER: publishing an offer would write a free option.
 *
 * Both ends are now built, and both stay INJECTED rather than reached for:
 *
 * - discovery — `consumeOfferTxs` feeds `consider()` from a stream of funding
 *   transactions. `streamOfferTxs` produces them and `offerFromFundingTx`
 *   decodes the packet (`OFFER_PACKET_TYPE = 3`); this module takes the
 *   iterable, so a test needs neither arkd nor a socket.
 * - settlement — `settle` spends the offer's deposit while paying the maker;
 *   `arkade/offerSettle.ts` is the implementation the CLI injects. Still
 *   optional, and absent it leaves every fillable offer recorded and
 *   `fillable`: a deployment that decides but cannot spend is a valid one.
 */
import type { Offer } from '@arkade-os/swap'
import { hex } from '@scure/base'
import {
  evaluateOfferFill,
  type OfferFillDecision,
  type OfferFillInput,
  type OfferFillPolicy,
} from '@arkade-os/solver-core/core/assetOffer.js'
import { offerDirectionOn, offerWithinTolerance } from '@arkade-os/solver-core/core/assetOfferPrice.js'
import type { FetchPrice } from '@arkade-os/solver-core/price/feed.js'
import { offerFillInputFrom } from '@arkade-os/solver-arkade/arkade/offerFill.js'
import { offerFromFundingTx } from '@arkade-os/solver-arkade/arkade/offerPacket.js'
import { offerDepositFrom, type OfferOutputView } from '@arkade-os/solver-arkade/arkade/offerDeposit.js'
import { offerInventoryFrom, type SpendableBalance } from '@arkade-os/solver-arkade/arkade/offerInventory.js'
import { offerIsConsistent } from '@arkade-os/solver-arkade/arkade/offerConsistency.js'
import { OfferFillStore, type OfferFillRow } from '@arkade-os/solver-corridors/db/offerFills.js'

/** An unordered market. `null` is BTC, matching how the packet omits the field. */
export interface AssetMarket {
  readonly a: string | null
  readonly b: string | null
}

/**
 * Pricing for one market, keyed by the same unordered pair.
 *
 * Without it an offer is taken at ANY price the maker names. The Arkade Swap
 * Protocol § 5.2 lists this gate third, and the reference solver applies it
 * before solvency. `base`/`quote` are directional here even though the market
 * is not: the feed quotes quote-per-base, so which leg is which decides the
 * comparison.
 */
export interface AssetMarketPricing {
  readonly base: string | null
  readonly quote: string | null
  readonly baseDecimals: number
  readonly quoteDecimals: number
  readonly feedUrl: string
  readonly pricePath: string
  /** Deviation from the feed this solver accepts. 10 bps matches the reference default. */
  readonly toleranceBps: number
  /** The solver's margin, folded against the maker. */
  readonly feeBps: number
  /**
   * Payout bounds in the WANT leg's units, per direction. A max of `0n`
   * DISABLES that direction, matching the reference — so a market can be
   * one-way without being two entries.
   *
   * Absent falls back to the deployment-wide `minFillAmount`/`maxFillAmount`.
   */
  readonly sellBase?: { readonly min: bigint; readonly max: bigint }
  readonly buyBase?: { readonly min: bigint; readonly max: bigint }
}

/** A discovered offer, funded at a known outpoint. */
export interface DiscoveredOffer {
  readonly offer: Offer
  /** The funded output this fill is about — the store's natural key. */
  readonly txid: string
  readonly vout: number
}

export interface AssetOfferDeps {
  store: OfferFillStore
  /** Markets served. An empty list serves none, which is the safe default. */
  markets: readonly AssetMarket[]
  /** Inclusive bounds on the payout, in the want leg's units. */
  minFillAmount: bigint
  maxFillAmount: bigint
  /** Spendable balance — `available`, never `total`. @see offerInventory.ts */
  balance: () => Promise<SpendableBalance>
  /** Outputs at the offer's script, via the contract manager's synced view. */
  outputsAt: (offerPkScript: string) => Promise<readonly OfferOutputView[]>
  /**
   * The Arkade signer key, for reconstructing an offer's script and checking it
   * against the terms the packet states. Omitted skips a protocol MUST.
   */
  serverPubkey?: Uint8Array
  /**
   * Pricing per market. A market with no entry is NOT priced and is refused —
   * failing closed, because the alternative is filling at whatever the maker
   * asked.
   */
  pricing?: readonly AssetMarketPricing[]
  /** The feed read. Omitted with `pricing` set refuses every offer. */
  fetchPrice?: FetchPrice
  /**
   * Spend the offer's deposit, paying the maker what the covenant obliges.
   * Returns the fill txid. Absent means this deployment decides but never fills.
   */
  settle?: (row: OfferFillRow) => Promise<string>
  onError?: (id: string, error: unknown) => void
  newId?: () => string
}

/** The decision, plus the row id when the intent was recorded. */
export type ConsiderOutcome = OfferFillDecision & { id?: string }

export class AssetOfferService {
  private readonly newId: () => string

  constructor(private readonly deps: AssetOfferDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Markets are static; inventory is read fresh every decision.
   *
   * Bounds come from the offer's own DIRECTION when the market states them, so
   * one market can be one-way (`max: 0n`) or asymmetric. Otherwise the
   * deployment-wide pair applies.
   */
  private async policy(input: OfferFillInput): Promise<OfferFillPolicy> {
    const bounds = this.boundsFor(input) ?? {
      min: this.deps.minFillAmount,
      max: this.deps.maxFillAmount,
    }
    return {
      markets: this.deps.markets,
      available: offerInventoryFrom(await this.deps.balance()),
      minFillAmount: bounds.min,
      maxFillAmount: bounds.max,
    }
  }

  /** The bounds this offer's direction states, when its market states any. */
  private boundsFor(input: OfferFillInput): { min: bigint; max: bigint } | null {
    for (const market of this.deps.pricing ?? []) {
      const direction = offerDirectionOn(market, input.offerAssetId, input.wantAssetId)
      if (direction === null) continue
      const bounds = direction === 'sell_base' ? market.sellBase : market.buyBase
      // `max: 0n` disables the direction rather than meaning "unbounded", so it
      // is returned as-is and refuses every amount.
      return bounds ?? null
    }
    return null
  }

  /**
   * Is the offer's implied price one we will take?
   *
   * True when no pricing is configured at all — a deployment that has not
   * opted into price gating is unchanged. But a market that IS priced and
   * cannot be read refuses: an unreadable feed must not become a free fill.
   */
  private async withinTolerance(input: OfferFillInput): Promise<boolean> {
    const pricing = this.deps.pricing
    if (!pricing || pricing.length === 0) return true

    const market = pricing.find((m) => offerDirectionOn(m, input.offerAssetId, input.wantAssetId) !== null)
    if (!market || !this.deps.fetchPrice) return false
    const direction = offerDirectionOn(market, input.offerAssetId, input.wantAssetId)
    if (direction === null) return false

    try {
      const feed = await this.deps.fetchPrice(market.feedUrl, market.pricePath)
      return offerWithinTolerance({
        depositAmount: input.offerAmount,
        wantAmount: input.wantAmount,
        direction,
        market,
        feed,
      })
    } catch (error) {
      this.deps.onError?.('price', error)
      return false
    }
  }

  /**
   * Decide one discovered offer, recording the intent when it is fillable.
   *
   * The deposit is OBSERVED at the offer's script, never read from the packet —
   * an offer can advertise a deposit it does not hold.
   */
  async consider({ offer, txid, vout }: DiscoveredOffer): Promise<ConsiderOutcome> {
    // Idempotent on the outpoint: rediscovering a funded offer must not open a
    // second intent against the same deposit.
    const existing = await this.deps.store.findLiveByOutpoint(txid, vout)
    if (existing) return { fill: true, id: existing.id }

    // FIRST, because everything after it reads fields off an attacker-supplied
    // packet. An offer whose script does not compile to the terms it states can
    // oblige a filler to something it never priced (Swap Protocol V1 § 5.1).
    if (this.deps.serverPubkey && !offerIsConsistent(offer, this.deps.serverPubkey)) {
      return { fill: false, reason: 'offer_inconsistent' }
    }

    // Hex, because that is the spelling the deposit adapter compares against
    // `OfferOutputView.script` and the store persists.
    const pkScript = hex.encode(offer.swapPkScript)
    const outputs = await this.deps.outputsAt(pkScript)
    const input = offerFillInputFrom(offer, offerDepositFrom(pkScript, outputs))
    const decision = evaluateOfferFill(input, await this.policy(input))
    if (!decision.fill) return decision

    // Price last among the refusals, and before anything is recorded: it is the
    // only gate that needs a network read, so the cheap structural refusals
    // above answer without one.
    const priced = await this.withinTolerance(input)
    if (!priced) return { fill: false, reason: 'price_out_of_tolerance' }

    const row = await this.deps.store.insertIntent({
      id: this.newId(),
      offerTxid: txid,
      offerVout: vout,
      offerPkScript: pkScript,
      wantAssetId: input.wantAssetId,
      wantAmount: input.wantAmount,
      offerAssetId: input.offerAssetId,
      offerAmount: input.offerAmount,
    })
    return { fill: true, id: row.id }
  }

  /**
   * Decide every offer a stream of funding transactions carries.
   *
   * The discovery half. `streamOfferTxs` says WHICH transactions carry an offer
   * packet — arkd evaluates that filter, so it proves presence and nothing more
   * — and `offerFromFundingTx` says what the packet is and which outpoint funds
   * it. Anything it cannot use is skipped rather than raised: a transaction with
   * no offer we can read is not an error, it is the filter being broader than
   * the decoder.
   *
   * ONE OFFER'S FAILURE MUST NOT END THE STREAM. Every input here arrives from
   * a public relay, so a packet that breaks `consider` is normal traffic — and a
   * loop that dies on it goes deaf to every offer after it, silently, for as
   * long as the process runs. Reported through `onError` and stepped over.
   *
   * Runs until the stream ends, which for `streamOfferTxs` means its signal
   * aborted: this is a long-lived consumer, not a pass.
   */
  async consumeOfferTxs(txs: AsyncIterable<{ txid: string; tx: string }>): Promise<void> {
    for await (const event of txs) {
      try {
        const found = offerFromFundingTx(event.tx)
        if (found === null) continue
        await this.consider(found)
      } catch (error) {
        this.deps.onError?.(event.txid, error)
      }
    }
  }

  /**
   * Submit every recorded intent. Returns how many were filled.
   *
   * A row moves to `filling` BEFORE `settle` runs, so a crash mid-submission
   * leaves a row that says something may be in flight rather than one that
   * still reads fillable. `transition` is compare-and-swap, so two ticks racing
   * one row cannot both submit.
   */
  async tickAll(): Promise<number> {
    if (!this.deps.settle) return 0
    let filled = 0
    for (const row of await this.deps.store.listNonTerminal()) {
      if (row.state !== 'fillable') continue
      if (!(await this.deps.store.transition(row.id, 'fillable', 'filling'))) continue
      try {
        const txid = await this.deps.settle(row)
        await this.deps.store.transition(row.id, 'filling', 'filled', { fill_txid: txid })
        filled += 1
      } catch (error) {
        // `filling` fails to `stuck`, not `refused`: something may have been
        // submitted, and only a human can tell which.
        this.deps.onError?.(row.id, error)
        await this.deps.store.fail(row.id, 'filling', error instanceof Error ? error.message : String(error))
      }
    }
    return filled
  }

  async close(): Promise<void> {
    await this.deps.store.close()
  }
}

/**
 * `OFFER_MARKETS` as `A/B` pairs, comma-separated, where `BTC` means the sats
 * leg: `BTC/<assetId>,<assetIdA>/<assetIdB>`. Unset serves no markets.
 */
export const parseAssetMarkets = (raw: string | undefined): readonly AssetMarket[] => {
  const legOf = (leg: string): string | null => (leg.toUpperCase() === 'BTC' ? null : leg)
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [a, b, ...rest] = entry.split('/')
      if (a === undefined || b === undefined || rest.length > 0) {
        throw new Error(`OFFER_MARKETS entry ${JSON.stringify(entry)} is not A/B`)
      }
      const market = { a: legOf(a), b: legOf(b) }
      if (market.a === market.b) throw new Error(`OFFER_MARKETS entry ${JSON.stringify(entry)} names one thing twice`)
      return market
    })
}

/**
 * Refuse a served market this deployment cannot price.
 *
 * {@link AssetOfferService.withinTolerance} returns TRUE when the pricing list
 * is empty — "a deployment that has not opted into price gating is unchanged".
 * That is right for a deployment serving nothing, and a fail-OPEN the moment one
 * market is served without one: the offer is then taken at any price the maker
 * names, which is what {@link AssetMarketPricing} warns about.
 *
 * It became reachable only when the two halves arrived by different routes —
 * `OFFER_MARKETS` names pairs from the environment, the console's market rows
 * carry the feed. `assetMarketConfig.ts`'s `assetMarketPolicy` derives both from
 * one filter precisely so they cannot separate; this is the same guarantee for
 * a market that came from anywhere else.
 *
 * ONE DIRECTION ONLY. Pricing without a market is fine — nothing is served, so
 * nothing is at risk. And pricing present but unreadable already refuses, since
 * `withinTolerance` returns false with no `fetchPrice`. Market-without-pricing
 * is the only combination that fills blind, so it is the only one refused.
 *
 * Thrown at STARTUP rather than per offer: an operator who configured a market
 * meant to trade it, and discovering at the first fill that it was never priced
 * is discovering it after the money moved.
 */
export const assertMarketsPriced = (markets: readonly AssetMarket[], pricing: readonly AssetMarketPricing[]): void => {
  const label = (id: string | null): string => id ?? 'BTC'
  for (const market of markets) {
    // The market is unordered and the feed is not, so either orientation counts.
    const covered = pricing.some(
      (p) => (p.base === market.a && p.quote === market.b) || (p.base === market.b && p.quote === market.a),
    )
    if (!covered) {
      throw new Error(
        `asset market ${label(market.a)}/${label(market.b)} is served but has no pricing: an offer on it ` +
          `would be filled at whatever price the maker named. Configure the market's price feed in the ` +
          `console, or stop serving the pair.`,
      )
    }
  }
}
