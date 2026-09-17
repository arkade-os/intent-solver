/**
 * What one swap DID to the book, normalised across corridors.
 *
 * Core defines the shape; a corridor produces it, exactly as `core/swapView.ts`
 * defines `AdminSwap` and `corridors/projections.ts` fills it in. Only the
 * corridor knows which of its own columns the solver received and which it
 * paid out, and that asymmetry is the whole difficulty: on a send leg the
 * inbound number is the client's lockup, on a receive leg it is the invoice.
 *
 * TWO HONESTY RULES drive every nullable field below, and both exist because
 * the alternative is a dashboard that reports a number the solver cannot
 * actually stand behind:
 *
 * 1. **GROSS AND NET ARE SEPARATE FIELDS, and net exists only where a rail said
 *    what execution actually cost.** Lightning send is the only one that can
 *    today — `PaymentResult.feePaidSats`, off the settled payment — so
 *    {@link SwapEconomics.realizedCostSats} is null on every other corridor and
 *    {@link SwapEconomics.netSats} is null with it. Null rather than a fallback
 *    to the gross: a net figure derived from a missing cost is the gross wearing
 *    a different label, and that is the one misreading here that costs money.
 *    The quote-time BUDGET is a third thing again — Lightning-send persists
 *    `quoted_routing_fee_sats` and spends against it as `maxFeeSats` — and it is
 *    a ceiling, not a cost. It rides along as
 *    {@link SwapEconomics.quotedCostSats} and is NEVER subtracted, because
 *    netting an upper bound out of a spread understates profit by an unknown
 *    amount while looking exactly like the real net figure. The admin route
 *    states how much of the book is netted in its own payload
 *    (`coverage.basis`) rather than only in a comment.
 * 2. **An unknown number is null, never a zero.** A `quoted` row has no inbound
 *    amount because nothing was funded; a cross-asset fill has no sats spread
 *    because its two legs are different units. Both would sum into a headline
 *    total as a silent zero, which reads as "this swap made nothing" rather
 *    than "nobody knows yet".
 */
import type { CorridorPhase } from '../core/corridor.js'

/**
 * One side of a swap, in that leg's own unit.
 *
 * `amount` is a decimal STRING in atomic units, never a number: an Arkade asset
 * amount is a bigint (§ 2.1) and overflows a double, and the same rule the swap
 * stores follow for their TEXT amount columns has to survive the projection or
 * the overflow simply moves one layer out.
 */
export interface EconomicsLeg {
  /** The Arkade asset id, or null for BTC — matching how an offer packet omits the field. */
  readonly assetId: string | null
  /** Atomic units, decimal string. Null when nothing has been funded yet. */
  readonly amount: string | null
  /** Where the amount's decimal point sits, when this leg's market declared one. */
  readonly decimals: number | null
}

/** A swap's economics, in the vocabulary an operator's P&L question is asked in. */
export interface SwapEconomics {
  readonly id: string
  /** The corridor's registry pair — `arkade:BTC->lightning:BTC`. */
  readonly corridor: string
  /** The corridor's own state word, carried through verbatim. */
  readonly state: string
  readonly phase: CorridorPhase
  /** Unix seconds the quote was written. */
  readonly quotedAt: number
  /** Unix seconds the row last moved — settlement time, on a terminal row. */
  readonly settledAt: number
  /**
   * Quote to last movement, seconds. THE FX DECAY AXIS.
   *
   * A cross-asset quote commits this solver to a price for `valid_until` while
   * the market keeps moving, so a fill that took an hour was priced against an
   * hour-old view. The spread can be textbook and the trade still a loss, and
   * this is the only column that can say so.
   */
  readonly durationSeconds: number
  /** What the solver RECEIVED. */
  readonly inbound: EconomicsLeg
  /** What the solver DELIVERED. */
  readonly outbound: EconomicsLeg
  /**
   * WHAT THE SOLVER KEPT, in sats. The one headline number, and the only field
   * anything on the P&L screen sums.
   *
   * Derived two ways, because corridors book a spread two ways, and a single
   * subtraction cannot serve both:
   *
   *  - **Both legs in sats** — `inbound - outbound`, which is the spread by
   *    construction. Every BTC corridor.
   *  - **A cross-asset leg with a sats-denominated payout notional** — the
   *    corridor supplies the figure itself. `packages/solver-corridors-evm`'s
   *    send leg is the case: it takes sats, delivers an ERC20, and persists
   *    `payout_sats` as the sats it undertook to deliver in token form, so its
   *    spread is `amount_sats - payout_sats` even though its two LEGS cannot be
   *    subtracted from one another.
   *
   * Null when neither holds — a genuine asset-to-asset fill, where the margin
   * lives inside the rate and there is no sats figure to report. Read those
   * through {@link SwapEconomics.rate}. Null rather than zero, because summing
   * a zero here would report a stablecoin book as having made nothing.
   */
  readonly grossSats: number | null
  /** {@link SwapEconomics.grossSats} as basis points of the inbound notional. */
  readonly grossBps: number | null
  /**
   * The EXECUTED rate, as an exact ratio of atomic units — `outbound` per
   * `inbound`. Kept as two strings rather than divided, for the reason
   * `assetOfferPrice.ts` gives: at 6-decimal stablecoin amounts against a sats
   * leg, float rounding decides money.
   *
   * Null when either leg is unfunded.
   */
  readonly rate: { readonly numerator: string; readonly denominator: string } | null
  /** True when money actually moved and the swap delivered. */
  readonly realized: boolean
  /**
   * Sats the solver paid out and was not made whole for — the loss, where one
   * is known to exist.
   *
   * Non-null only on a row that is TERMINAL and was EXPOSED: `stuck`, on every
   * corridor that has it. A refunded row is not a loss (the capital came back,
   * minus an unmeasured chain fee) and a live exposed row is not one either
   * (it may still claim), so both are null rather than zero — the distinction
   * an operator acts on is "is this money gone", and a zero answers a different
   * question.
   */
  readonly atRiskSats: number | null
  /**
   * What the quote BUDGETED for execution, in sats, where the corridor recorded
   * a figure. NEVER subtracted from {@link SwapEconomics.grossSats}.
   *
   * Lightning-send persists `quoted_routing_fee_sats` and spends against it as
   * `maxFeeSats`, so it is a CEILING set before the payment rather than the fee
   * that was actually paid — the real one is still unrecorded anywhere. Netting
   * an upper bound out of a spread would understate profit by an unknown amount
   * and dress the result up as the net figure this screen explicitly does not
   * have. Reported alongside instead, so an operator can see the budget they
   * were quoting against and how much of their spread it could consume.
   *
   * Null on every corridor that records no such figure.
   */
  readonly quotedCostSats: number | null
  /**
   * What executing this swap ACTUALLY cost, in sats, where the rail reported it.
   *
   * The figure this whole screen was missing. `quotedCostSats` beside it is the
   * budget; this is the bill. Today only the Lightning send leg can source one
   * — `PaymentResult.feePaidSats`, from the backend, on a settled payment — and
   * every other rail reports null because no port in this service returns a
   * realized fee: `OnchainTxOutcome` is a status word and `fund()` answers
   * `{txid, vout}`.
   *
   * NULL IS UNMEASURED, NEVER FREE, and the distinction decides whether
   * {@link SwapEconomics.netSats} exists at all. A swap whose cost nobody
   * recorded must not be netted to look like one that cost nothing.
   */
  readonly realizedCostSats: number | null
  /**
   * `grossSats - realizedCostSats` — WHAT THE SOLVER ACTUALLY KEPT.
   *
   * The bottom line, and null unless BOTH halves are known. A net figure
   * derived from a missing cost is just the gross wearing a different label,
   * which is the single most misleading thing this screen could publish: the
   * whole reason the gross caveat is stated three times is that someone will
   * otherwise read gross AS net. So the field is absent rather than
   * approximated, and the aggregate counts how much of the book it covers.
   */
  readonly netSats: number | null
  /**
   * HOW FAR THE MARKET MOVED between this quote being issued and its fill
   * landing, in basis points, SIGNED so that positive is in the solver's favour.
   *
   * The question peer drift structurally cannot answer. That one benchmarks a
   * fill against this solver's OTHER fills, so a market that ran against every
   * quote in a window leaves them all looking flawless beside each other. This
   * one compares two observations taken at two different TIMES — which is the
   * whole point, and what the first attempt at this got wrong by comparing the
   * quote to the very feed instant it was derived from.
   *
   * Null unless both halves exist: every corridor but the asset RFQ leg, rows
   * quoted before the columns shipped, fills whose feed read failed, and
   * anything that never filled. Unmeasured, never zero.
   */
  readonly marketDriftBps: number | null
  /** @see the note where this is assigned — a loss that cannot be priced in sats. */
  readonly atRiskUnknown: boolean
  /**
   * True when this corridor's `atRiskSats` is an UPPER BOUND rather than a
   * measurement.
   *
   * Both ERC20 stores' `fail()` transitions to `stuck` whatever the row's
   * exposure, unlike the four BTC stores which route a failure by it — so a row
   * that failed before locking anything is filed beside one that failed after.
   * The corridor declares that about itself here.
   *
   * On the RECORD rather than only in prose, because a caller reading this API
   * programmatically never sees `docs/pnl.md`. A bare number they cannot tell is
   * a ceiling is exactly the kind of figure this feature exists not to publish.
   */
  readonly atRiskUpperBound: boolean
}

/** Which part of the ledger a caller wants. Seconds, half-open `[since, until)`. */
export interface LedgerWindow {
  readonly since: number
  readonly until: number
  /**
   * Rows to read at most, per corridor.
   *
   * A cap rather than a page: this is a scan for aggregation, and a partial
   * answer presented as a total is the one failure mode a P&L screen must not
   * have. The caller is told when it bit — see {@link CorridorLedger.truncated}
   * — so the console can say "narrow the window" instead of quietly
   * under-reporting the book.
   */
  readonly limit: number
}

/** One corridor's answer to a {@link LedgerWindow}. */
export interface CorridorLedger {
  readonly corridor: string
  readonly records: readonly SwapEconomics[]
  /** True when {@link LedgerWindow.limit} bit and rows in the window were left unread. */
  readonly truncated: boolean
}

export const DEFAULT_LEDGER_LIMIT = 5_000
export const MAX_LEDGER_LIMIT = 50_000

/**
 * A caller's row cap, bounded. Rejects a non-positive limit rather than
 * clamping it, exactly as `core/page.ts`'s `clampLimit` does and for the same
 * reason: `limit=0` is a caller bug, and answering it with the default hides
 * the bug behind a screen that looks fine.
 */
export const clampLedgerLimit = (limit: number | undefined): number => {
  if (limit === undefined) return DEFAULT_LEDGER_LIMIT
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`ledger limit must be a positive integer, got ${limit}`)
  return Math.min(limit, MAX_LEDGER_LIMIT)
}

/**
 * Basis points of `notional`, rounded toward zero.
 *
 * Toward zero rather than to nearest so a spread never rounds UP into looking
 * better than it was; a loss keeps its sign for the same reason.
 */
export const bpsOf = (amount: number, notional: number): number | null => {
  if (!Number.isFinite(amount) || !Number.isFinite(notional) || notional <= 0) return null
  return Math.trunc((amount / notional) * 10_000)
}

/**
 * The market's move between quote and fill, in basis points, positive in the
 * solver's favour.
 *
 * CROSS-MULTIPLIED rather than rescaled. The two observations are separate feed
 * reads and need not share a scale, and normalising one to the other would
 * either divide (losing precision in the figure being measured) or multiply into
 * a comparison that no longer matches its denominator. Exact bigint throughout;
 * the single division is the last step, into basis points.
 *
 * The direction bit is why `givesBase` is stored. The ratio is quote-per-base
 * either way, but the solver sits on opposite sides of it:
 *
 *  - `givesBase` — the client hands over base, so the solver BUYS base at
 *    `implied`. A market above that means it bought below the market: good.
 *  - otherwise — the client hands over quote, so the solver SELLS base at
 *    `implied`. A market below that means it sold above the market: good.
 */
const marketDriftBpsOf = (
  quote: { impliedMantissa: string; scale: number; givesBase: boolean } | null,
  fill: { mantissa: string; scale: number } | null,
): number | null => {
  if (quote === null || fill === null) return null
  const implied = BigInt(quote.impliedMantissa)
  const market = BigInt(fill.mantissa)
  if (implied <= 0n || market <= 0n || quote.scale < 0 || fill.scale < 0) return null
  // Both sides raised to the other's scale, so they are directly comparable.
  const impliedAt = implied * 10n ** BigInt(fill.scale)
  const marketAt = market * 10n ** BigInt(quote.scale)
  const favourable = quote.givesBase ? marketAt - impliedAt : impliedAt - marketAt
  return Number((favourable * 10_000n) / impliedAt)
}

/**
 * Assemble a {@link SwapEconomics} from the parts a corridor knows, deriving
 * the three fields that are pure arithmetic over them.
 *
 * Shared rather than written once per corridor because `grossSats` is where a
 * sign error hides: every corridor computes inbound-minus-outbound, and one
 * that wrote it backwards would report its losses as profit on a screen built
 * to be trusted.
 */
export const economicsOf = (parts: {
  id: string
  corridor: string
  state: string
  phase: CorridorPhase
  quotedAt: number
  settledAt: number
  inbound: EconomicsLeg
  outbound: EconomicsLeg
  /**
   * The corridor's OWN sats spread, where it books one that the two legs cannot
   * express — see {@link SwapEconomics.grossSats}. Supplying it on a corridor
   * whose legs are both sats would be a second, competing definition of the
   * same number, so it is ignored there rather than allowed to disagree.
   */
  quotedSpreadSats?: number | null
  /**
   * Sats this row put at stake, where the outbound leg is not itself sats.
   *
   * Defaults to the outbound amount, which is the right answer on every
   * sats-to-sats corridor. A corridor delivering a token supplies its own
   * sats-denominated notional instead — without it a lost ERC20 fill would
   * report no loss at all, which is the one number on this screen that must
   * never be quietly zero.
   */
  exposureSats?: number | null
  /** @see SwapEconomics.quotedCostSats */
  quotedCostSats?: number | null
  /** @see SwapEconomics.realizedCostSats */
  realizedCostSats?: number | null
  /** The price these terms fixed, and which way round the trade ran. */
  quotePrice?: { impliedMantissa: string; scale: number; givesBase: boolean } | null
  /** What the feed said as the fill landed. */
  fillPrice?: { mantissa: string; scale: number } | null
  /** @see SwapEconomics.atRiskUpperBound */
  atRiskUpperBound?: boolean
  /** True only for a TERMINAL row that was exposed — see {@link SwapEconomics.atRiskSats}. */
  lost?: boolean
}): SwapEconomics => {
  const { inbound, outbound } = parts
  const sats = inbound.assetId === null && outbound.assetId === null
  const inboundAmount = inbound.amount === null ? null : Number(inbound.amount)
  const outboundAmount = outbound.amount === null ? null : Number(outbound.amount)
  const grossSats = sats
    ? inboundAmount !== null && outboundAmount !== null
      ? inboundAmount - outboundAmount
      : null
    : (parts.quotedSpreadSats ?? null)

  const atRisk =
    parts.lost === true ? (parts.exposureSats ?? (outbound.assetId === null ? outboundAmount : null)) : null

  // Kept whatever the phase. A rail reports a fee only on a CONFIRMED payment,
  // so a value here is already evidence the money left — including on a swap
  // whose CLAIM then failed, where gating on `done` hid a fee that was really
  // paid and understated the loss by exactly that much. No total can be
  // disturbed by this: `costed()` gates on `realized`, which is `phase ===
  // 'done'`, so an unfinished swap still reaches no sum.
  const realizedCostSats = parts.realizedCostSats ?? null

  return {
    id: parts.id,
    corridor: parts.corridor,
    state: parts.state,
    phase: parts.phase,
    quotedAt: parts.quotedAt,
    settledAt: parts.settledAt,
    // Clamped at zero: `updated_at` is a second-resolution clock and the two
    // timestamps can legitimately be equal, but they must never read as a swap
    // that settled before it was quoted.
    durationSeconds: Math.max(0, parts.settledAt - parts.quotedAt),
    inbound,
    outbound,
    grossSats,
    // Only against a SATS intake. A spread in sats over an intake denominated
    // in token units is not a basis point of anything.
    grossBps:
      grossSats === null || inboundAmount === null || inbound.assetId !== null ? null : bpsOf(grossSats, inboundAmount),
    rate:
      inbound.amount === null || outbound.amount === null
        ? null
        : { numerator: outbound.amount, denominator: inbound.amount },
    realized: parts.phase === 'done',
    atRiskSats: atRisk,
    /**
     * True when this row IS a loss whose size cannot be said in sats — a token
     * payout on a corridor that supplied no sats notional.
     *
     * Carried rather than inferred from `atRiskSats === null`, which is also
     * what a perfectly healthy swap reports. Without it the aggregate's `?? 0`
     * folds an unmeasurable loss into the total as zero, so "nothing is
     * outstanding" and "something is outstanding and nobody can price it"
     * render identically — the same failure `unpricedCount` prevents on the
     * profit side.
     */
    atRiskUnknown: parts.lost === true && atRisk === null,
    // Only meaningful where there IS an at-risk figure to qualify.
    atRiskUpperBound: parts.atRiskUpperBound === true && atRisk !== null,
    quotedCostSats: parts.quotedCostSats ?? null,
    realizedCostSats,
    // Both halves or nothing. A realized cost on a swap with no priceable
    // spread nets to nothing meaningful, and a spread with no cost is the gross
    // figure this field exists to be distinguishable from.
    netSats: grossSats === null || realizedCostSats === null ? null : grossSats - realizedCostSats,
    marketDriftBps: marketDriftBpsOf(parts.quotePrice ?? null, parts.fillPrice ?? null),
  }
}
