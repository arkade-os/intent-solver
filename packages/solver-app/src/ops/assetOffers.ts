/**
 * Wiring for Arkade asset-swap offers: the pieces exist, this composes them.
 *
 * @deprecated Packet-style offers remain for deployed clients. New asset-swap
 * integrations should use the RFQ path (`corridors/assetRfq.ts`).
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
import type { Offer } from '@arkade-os/swap/protocol'
import { hex } from '@scure/base'
import {
  evaluateOfferFill,
  type OfferFillDecision,
  type OfferFillInput,
  type OfferFillPolicy,
  type OfferFillRefusal,
} from '@arkade-os/solver-core/core/assetOffer.js'
import {
  offerDirectionOn,
  offerWithinTolerance,
  type OfferDirection,
} from '@arkade-os/solver-core/core/assetOfferPrice.js'
import { askApprovalFor, type ApprovalCheck } from '@arkade-os/solver-core/core/approvalGate.js'
import type { FetchPrice } from '@arkade-os/solver-core/price/feed.js'
import { createSerialiser, type Serialiser } from '@arkade-os/solver-core/util/serialise.js'
import { offerFillInputFrom } from '@arkade-os/solver-arkade/arkade/offerFill.js'
import { OfferNotSubmittedError, type FulfillOptions } from '@arkade-os/solver-arkade/arkade/offerFulfill.js'
import { offerFromFundingTx } from '@arkade-os/solver-arkade/arkade/offerPacket.js'
import { offerDepositFrom, type OfferOutputView } from '@arkade-os/solver-arkade/arkade/offerDeposit.js'
import { offerInventoryFrom, type SpendableBalance } from '@arkade-os/solver-arkade/arkade/offerInventory.js'
import { offerCovenantMatch } from '@arkade-os/solver-arkade/arkade/offerConsistency.js'
import {
  OFFER_COVENANT_VERSIONS,
  offerCovenantVersionOf,
  type OfferCovenantVersion,
} from '@arkade-os/solver-core/core/offerCovenant.js'
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
  /** Directional flat charges in the atomic units of the maker's deposit leg. */
  readonly sellBaseFeeFlat?: bigint
  readonly buyBaseFeeFlat?: bigint
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
  /** Covenant versions this deployment accepts. Defaults to every version. */
  covenantVersions?: ReadonlySet<OfferCovenantVersion>
  /**
   * Pricing per market. A market with no entry is NOT priced and is refused —
   * failing closed, because the alternative is filling at whatever the maker
   * asked.
   */
  pricing?: readonly AssetMarketPricing[]
  /** The feed read. Omitted with `pricing` set refuses every offer. */
  fetchPrice?: FetchPrice
  carrierSats: bigint
  chargesDeliveredCarrier?: boolean
  /**
   * Spend the offer's deposit, paying the maker what the covenant obliges.
   * Returns the fill txid. Absent means this deployment decides but never fills.
   * `options.markSubmitting` gates the submission. @see FulfillOptions
   */
  settle?: (row: OfferFillRow, options?: FulfillOptions) => Promise<string>
  /** The large-swap approval gate. Absent means no gate. @see ops/approvals.ts */
  approvalGate?: ApprovalCheck
  onError?: (id: string, error: unknown) => void
  /**
   * A fill put back for a later sweep because the float was pinned or short.
   * FIRST deferral of a row only: one line per 3 s sweep would bury the
   * escalation that follows if it never clears.
   */
  onDeferred?: (id: string, error: unknown) => void
  /**
   * Every offer this service DECLINES. `onError` reports a throw; a refusal is
   * not one, and used to leave no trace at all — `consider` returned the reason
   * and `consumeOfferTxs` discarded it. `detail` names the bounds in force and
   * WHICH source set them, since a market row silently overrides the
   * deployment-wide pair and the reason alone cannot say which refused.
   */
  onRefused?: (outpoint: string, reason: OfferFillRefusal, detail: string) => void
  newId?: () => string
}

/**
 * How many sweeps a fill may wait for the float before it needs a human — about
 * two minutes at `FULL_SWEEP_MS`, long enough to outlast the renewal or funding
 * that pinned the coins. Counted in memory, so this bound, and the event rows it
 * caps, hold per process: a restart starts the count again.
 */
export const MAX_FILL_DEFERRALS = 40

interface AppliedBounds {
  readonly min: bigint
  readonly max: bigint
  readonly source: 'market' | 'deployment'
}

const legName = (id: string | null): string => id ?? 'BTC'

const amountsOf = (input: OfferFillInput): string =>
  `wants ${input.wantAmount} ${legName(input.wantAssetId)} for ${input.offerAmount} ${legName(input.offerAssetId)}`

// The bounds clause ONLY where a bound refused. Elsewhere it sends the operator
// to re-check config that was never the problem.
const refusalDetail = (input: OfferFillInput, reason: OfferFillRefusal, bounds: AppliedBounds): string =>
  reason === 'amount_out_of_range'
    ? `${amountsOf(input)}; ${bounds.source} bounds ${bounds.min}..${bounds.max}`
    : amountsOf(input)

// What `consider` actually priced. Never re-derived from the chain: that would
// re-ask what the offer IS, the substitution `arkade/offerSettle.ts` guards.
const termsOf = (row: OfferFillRow): OfferFillInput => ({
  wantAssetId: row.wantAssetId,
  wantAmount: row.wantAmount,
  offerAssetId: row.offerAssetId,
  offerAmount: row.offerAmount,
})

/** The decision, plus the row id when the intent was recorded. */
export type ConsiderOutcome = OfferFillDecision & { id?: string }

export class AssetOfferService {
  private readonly newId: () => string
  private markets: readonly AssetMarket[]
  private pricing: readonly AssetMarketPricing[] | undefined
  private readonly serialise: Serialiser = createSerialiser()
  private readonly covenantVersions: ReadonlySet<OfferCovenantVersion>
  /** Deferrals per row, pruned to the live set each sweep so it cannot grow. */
  private readonly deferrals = new Map<string, number>()

  constructor(private readonly deps: AssetOfferDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID())
    this.markets = deps.markets
    this.pricing = deps.pricing
    this.covenantVersions = deps.covenantVersions ?? new Set(OFFER_COVENANT_VERSIONS)
  }

  /** Swap the live serve list. Recorded intents keep the amounts already stored. */
  replaceMarkets(args: { markets: readonly AssetMarket[]; pricing?: readonly AssetMarketPricing[] }): Promise<void> {
    return this.serialise(async () => {
      this.markets = args.markets
      this.pricing = args.pricing
    })
  }

  /** Markets are static; inventory is read fresh every decision. */
  private policy(bounds: AppliedBounds, available: SpendableBalance): OfferFillPolicy {
    return {
      markets: this.markets,
      available: offerInventoryFrom(available),
      minFillAmount: bounds.min,
      maxFillAmount: bounds.max,
    }
  }

  // The offer's own DIRECTION when its market states bounds — so a market can be
  // one-way (`max: 0n`) or asymmetric — otherwise the deployment-wide pair.
  private boundsIn(input: OfferFillInput): AppliedBounds {
    const market = this.boundsFor(input)
    return market === null
      ? { min: this.deps.minFillAmount, max: this.deps.maxFillAmount, source: 'deployment' }
      : { min: market.min, max: market.max, source: 'market' }
  }

  // A log line and not a stored row: `consumeOfferTxs` reads a PUBLIC relay, so
  // a row per refusal would let anyone grow the operator's database.
  private refuse(outpoint: string, reason: OfferFillRefusal, detail: string): ConsiderOutcome {
    this.deps.onRefused?.(outpoint, reason, detail)
    return { fill: false, reason }
  }

  /** The bounds this offer's direction states, when its market states any. */
  private boundsFor(input: OfferFillInput): { min: bigint; max: bigint } | null {
    const match = this.pricingFor(input)
    if (match === null) return null
    const { market, direction } = match
    const bounds = direction === 'sell_base' ? market.sellBase : market.buyBase
    // `max: 0n` disables the direction rather than meaning "unbounded", so it
    // is returned as-is and refuses every amount.
    return bounds ?? null
  }

  private pricingFor(input: OfferFillInput): { market: AssetMarketPricing; direction: OfferDirection } | null {
    for (const market of this.pricing ?? []) {
      const direction = offerDirectionOn(market, input.offerAssetId, input.wantAssetId)
      if (direction !== null) return { market, direction }
    }
    return null
  }

  /**
   * Is the offer's implied price one we will take?
   *
   * True only when pricing is omitted as an explicit opt-out. Once configured,
   * an empty list, missing market, or unreadable feed refuses. A feed failure
   * is reported under `id`, which defaults because `consider` has no row yet;
   * `tickAll` has one and passes it.
   */
  private async withinTolerance(input: OfferFillInput, id = 'price'): Promise<boolean> {
    if (this.pricing === undefined) return true
    const match = this.pricingFor(input)
    if (match === null || !this.deps.fetchPrice) return false
    const { market, direction } = match

    try {
      const feed = await this.deps.fetchPrice(market.feedUrl, market.pricePath)
      // An asset on BOTH legs: the maker fronts one, we deliver one, they cancel.
      const fronted = input.offerAssetId !== null
      const delivered = input.wantAssetId !== null
      return offerWithinTolerance({
        depositAmount: input.offerAmount,
        wantAmount: input.wantAmount,
        direction,
        market,
        feed,
        // The charge tightens an already-funded offer, so unlike the headroom it is opt-in.
        carrierCharged:
          delivered && !fronted && this.deps.chargesDeliveredCarrier === true ? this.deps.carrierSats : 0n,
        carrierReturned: fronted && !delivered ? this.deps.carrierSats : 0n,
      })
    } catch (error) {
      this.deps.onError?.(id, error)
      return false
    }
  }

  /**
   * Decide one discovered offer, recording the intent when it is fillable.
   *
   * The deposit is OBSERVED at the offer's script, never read from the packet —
   * an offer can advertise a deposit it does not hold.
   */
  consider({ offer, txid, vout }: DiscoveredOffer): Promise<ConsiderOutcome> {
    return this.serialise(() => this.considerInner({ offer, txid, vout }))
  }

  private async considerInner({ offer, txid, vout }: DiscoveredOffer): Promise<ConsiderOutcome> {
    const outpoint = `${txid}:${vout}`
    if (!this.deps.serverPubkey && this.covenantVersions.size < OFFER_COVENANT_VERSIONS.length) {
      return this.refuse(
        outpoint,
        'offer_version_unverified',
        'a narrowed offers.covenantVersions needs serverPubkey so the covenant version is verified from script',
      )
    }
    // Idempotent on the outpoint: rediscovering a funded offer must not open a
    // second intent against the same deposit.
    const existing = await this.deps.store.findLiveByOutpoint(txid, vout)
    if (existing) return { fill: true, id: existing.id }

    // FIRST, because everything after it reads fields off an attacker-supplied
    // packet. An offer whose script does not compile to the terms it states can
    // oblige a filler to something it never priced (Swap Protocol V1 § 5.1).
    const match = this.deps.serverPubkey
      ? offerCovenantMatch(offer, this.deps.serverPubkey)
      : { version: offerCovenantVersionOf(offer) }
    if (match === null) {
      return this.refuse(outpoint, 'offer_inconsistent', 'its script does not encode the terms the packet states')
    }
    if (!this.covenantVersions.has(match.version)) {
      return this.refuse(
        outpoint,
        'offer_version_disabled',
        `offer covenant ${match.version} is disabled by offers.covenantVersions`,
      )
    }

    // Hex, because that is the spelling the deposit adapter compares against
    // `OfferOutputView.script` and the store persists.
    const pkScript = hex.encode(offer.swapPkScript)
    const [outputs, available] = await Promise.all([this.deps.outputsAt(pkScript), this.deps.balance()])
    const input = offerFillInputFrom(offer, offerDepositFrom(pkScript, outputs))
    const bounds = this.boundsIn(input)
    const decision = evaluateOfferFill(input, this.policy(bounds, available))
    if (!decision.fill) return this.refuse(outpoint, decision.reason, refusalDetail(input, decision.reason, bounds))

    // Price last among the refusals, and before anything is recorded: it is the
    // only gate that needs a network read, so the cheap structural refusals
    // above answer without one.
    const priced = await this.withinTolerance(input)
    if (!priced) return this.refuse(outpoint, 'price_out_of_tolerance', amountsOf(input))

    const row = await this.deps.store.insertIntent({
      id: this.newId(),
      offerTxid: txid,
      offerVout: vout,
      offerPkScript: pkScript,
      covenantVersion: match.version,
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
   *
   * Price admission is re-run first; this loop reaches a row arbitrarily late.
   */
  tickAll(): Promise<number> {
    return this.serialise(() => this.tickAllInner())
  }

  private async tickAllInner(): Promise<number> {
    if (!this.deps.settle) return 0
    let filled = 0
    const rows = await this.deps.store.listNonTerminal()
    const live = new Set(rows.map((row) => row.id))
    for (const id of this.deferrals.keys()) if (!live.has(id)) this.deferrals.delete(id)
    // Serialised ticks, so a `filling` row here is no attempt of ours: a restart left it.
    for (const row of rows) if (row.state === 'filling') await this.recoverFilling(row)
    for (const row of rows) {
      if (row.state !== 'fillable') continue
      if (row.covenantVersion === null && this.covenantVersions.size < OFFER_COVENANT_VERSIONS.length) {
        this.deps.onRefused?.(
          `${row.offerTxid}:${row.offerVout}`,
          'offer_version_unverified',
          'an unversioned pre-migration offer cannot be admitted while offers.covenantVersions is narrowed',
        )
        await this.deps.store.fail(
          row.id,
          'fillable',
          'offer_version_unverified; an unversioned pre-migration offer cannot be admitted while offers.covenantVersions is narrowed',
        )
        continue
      }
      if (row.covenantVersion !== null && !this.covenantVersions.has(row.covenantVersion)) {
        this.deps.onRefused?.(
          `${row.offerTxid}:${row.offerVout}`,
          'offer_version_disabled',
          `offer covenant ${row.covenantVersion} is disabled by offers.covenantVersions`,
        )
        await this.deps.store.fail(
          row.id,
          'fillable',
          `offer_version_disabled; offer covenant ${row.covenantVersion} is disabled by offers.covenantVersions`,
        )
        continue
      }
      // BEFORE the CAS: `fillable` has an edge to `refused` and `filling` has
      // none, which is also the honest shape — nothing is submitted yet.
      const terms = termsOf(row)
      if (!(await this.withinTolerance(terms, row.id))) {
        this.deps.onRefused?.(`${row.offerTxid}:${row.offerVout}`, 'price_out_of_tolerance', amountsOf(terms))
        await this.deps.store.fail(row.id, 'fillable', `price_out_of_tolerance; ${amountsOf(terms)}`)
        continue
      }
      // AFTER the price decision, BEFORE the CAS. The solver pays the WANT leg.
      // A hold needs no deadline here: the row stays `fillable` and nothing is spent.
      if (!(await askApprovalFor(this.deps.approvalGate, row.id, { assetId: row.wantAssetId, amount: row.wantAmount })))
        continue
      // `selecting`: nothing is sent yet, which is what makes a walk-back sound.
      if (!(await this.deps.store.transition(row.id, 'fillable', 'filling', { fill_phase: 'selecting' }))) continue
      try {
        const txid = await this.deps.settle(row, { markSubmitting: () => this.deps.store.markSubmitting(row.id) })
        await this.deps.store.transition(row.id, 'filling', 'filled', { fill_txid: txid })
        filled += 1
      } catch (error) {
        // The ONE retryable shape, and only because `fulfillOffer` raises it
        // above the call that submits. A later sweep re-runs every gate and the CAS.
        const deferrals = (this.deferrals.get(row.id) ?? 0) + 1
        if (error instanceof OfferNotSubmittedError && deferrals <= MAX_FILL_DEFERRALS) {
          if (await this.deps.store.revertUnsubmitted(row.id)) {
            this.deferrals.set(row.id, deferrals)
            if (deferrals === 1) this.deps.onDeferred?.(row.id, error)
          }
          continue
        }
        // `filling` fails to `stuck`, not `refused`: something may have been
        // submitted, and only a human can tell which.
        this.deps.onError?.(row.id, error)
        const reason = error instanceof Error ? error.message : String(error)
        await this.deps.store.fail(
          row.id,
          'filling',
          error instanceof OfferNotSubmittedError ? `${reason}; ${MAX_FILL_DEFERRALS} retries exhausted` : reason,
        )
      }
    }
    return filled
  }

  /**
   * A row left `filling` by a process that is gone. Only `selecting` walks back;
   * `submitting` and NULL may both have reached arkd. @see FillPhase
   */
  private async recoverFilling(row: OfferFillRow): Promise<void> {
    if (row.fillPhase === 'selecting') {
      await this.deps.store.revertUnsubmitted(row.id)
      return
    }
    const error = new Error('fill outcome unknown after restart; check the offer address')
    this.deps.onError?.(row.id, error)
    await this.deps.store.fail(row.id, 'filling', error.message)
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
