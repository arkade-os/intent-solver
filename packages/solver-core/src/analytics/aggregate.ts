/**
 * Turning a ledger into the handful of shapes a P&L screen actually draws.
 *
 * Pure: in go {@link SwapEconomics} records, out come series, breakdowns and
 * bands. Nothing here reads a store, a clock or a config, which is what makes
 * every number on the console assertable from a fixture — and this is the layer
 * where an arithmetic mistake would be least visible and most expensive, since
 * a wrong total still renders as a perfectly convincing chart.
 *
 * THE ONE RULE, restated from `analytics/economics.ts` because it is what
 * shapes every signature: a null is not a zero. A record with no `grossSats` is
 * EXCLUDED from a total rather than added as nothing, and every bucket reports
 * the count it was actually able to price alongside the count it saw. A screen
 * that cannot tell "we made nothing" from "we could not tell" is worse than no
 * screen.
 */
import type { SwapEconomics } from './economics.js'

/** Bucket widths the series endpoint accepts, in seconds. */
export const BUCKETS = { '5m': 300, '1h': 3_600, '6h': 21_600, '1d': 86_400 } as const
export type BucketName = keyof typeof BUCKETS

/**
 * The most buckets {@link series} will build, and the reason it is a HARD
 * REFUSAL rather than a clamp.
 *
 * `series` allocates one object per bucket across the whole window, whether or
 * not a swap landed in it — that is what makes a quiet period draw as a gap.
 * The cost is linear in `(until - since) / bucketSeconds`, and BOTH of those
 * come from a request: `since=0&bucket=5m` spans from the epoch and asks for
 * roughly six million objects. On a port with no authentication in front of it
 * that is a memory exhaustion, not a slow chart.
 *
 * Clamping the count silently would answer a different question from the one
 * asked — a chart labelled "90 days" showing six hours — so the caller is told
 * to widen the bucket instead. The bound is generous against any real reading:
 * 7 days at 5 minutes is 2,016, 90 days at an hour is 2,160, and no chart this
 * console draws is more than a thousand pixels wide.
 */
export const MAX_SERIES_BUCKETS = 5_000

/** How many buckets a window would produce. Exported so a caller can refuse BEFORE allocating. */
export const bucketCount = (since: number, until: number, bucketSeconds: number): number =>
  until <= since || bucketSeconds <= 0
    ? 0
    : Math.ceil((until - Math.floor(since / bucketSeconds) * bucketSeconds) / bucketSeconds)

/**
 * How long a swap took, banded — the axis the FX question is asked on.
 *
 * Bands rather than a raw scatter because the question is comparative: does
 * margin hold up as a fill drags? A quote commits to a price for `valid_until`
 * while the market moves underneath it, so the answer is read by comparing one
 * band's realized margin against the fastest band's, and a band needs enough
 * rows in it to mean anything.
 *
 * Open-ended at the top: the last band's `untilSeconds` is null because the
 * swaps that most ruin a book are exactly the ones with no upper bound.
 */
export const DURATION_BANDS: readonly { label: string; untilSeconds: number | null }[] = [
  { label: '<1m', untilSeconds: 60 },
  { label: '1–5m', untilSeconds: 300 },
  { label: '5–30m', untilSeconds: 1_800 },
  { label: '30m–2h', untilSeconds: 7_200 },
  { label: '>2h', untilSeconds: null },
]

export interface SeriesPoint {
  /** Bucket start, unix seconds. */
  at: number
  /** Rows whose last movement fell in this bucket, whatever their phase. */
  count: number
  realizedCount: number
  failedCount: number
  /** Rows that were realized AND priceable — the denominator behind `grossSats`. */
  pricedCount: number
  /** Sum of gross spread over the priced rows. */
  grossSats: number
  /** Running total of `grossSats` from the start of the window. */
  cumulativeGrossSats: number
  /** Inbound notional of the priced rows — the volume the margin is a margin OF. */
  volumeSats: number
  /** Sats known to be gone: the payout of a terminal exposed row. */
  atRiskSats: number
}

export interface CorridorBreakdown {
  corridor: string
  count: number
  realizedCount: number
  failedCount: number
  pricedCount: number
  grossSats: number
  volumeSats: number
  /** Volume-weighted margin, basis points. Null when nothing priceable settled. */
  marginBps: number | null
  atRiskSats: number
  medianDurationSeconds: number | null
  p90DurationSeconds: number | null
  /**
   * True when this corridor's legs are different assets, so its economics are a
   * RATE and not a sats spread. The console reads it to decide whether a
   * `grossSats` of zero means "flat" or "not expressible here".
   */
  crossAsset: boolean
}

export interface DurationBand {
  label: string
  untilSeconds: number | null
  count: number
  pricedCount: number
  grossSats: number
  volumeSats: number
  marginBps: number | null
  /** Median of the per-swap `grossBps`, which a volume-weighted figure hides. */
  medianBps: number | null
}

export interface FxPoint {
  id: string
  at: number
  durationSeconds: number
  /**
   * Outbound per inbound, in ATOMIC UNITS, as a float.
   *
   * The exact ratio is on the record; this is the plotted value and is
   * documented as display-only for that reason. Charting is the one place a
   * float is the right answer — an SVG coordinate is a float regardless — and
   * no decision is taken on it.
   */
  rate: number
  /**
   * How far this fill's rate sat from the window's volume-weighted mean for the
   * same directional leg, in basis points, SIGNED so that POSITIVE IS IN THE
   * SOLVER'S FAVOUR.
   *
   * The sign is inverted relative to the raw rate, and that inversion is the
   * whole reason this is not just a subtraction at the call site. `rate` is
   * outbound PER inbound — what the solver hands over for each unit it takes —
   * so a rate ABOVE the mean means this fill paid out more than its peers for
   * the same intake, which is the worse trade. Reported so that every
   * favourable number on the screen is positive, whatever it measures.
   *
   * The benchmark is the solver's OWN book rather than a price feed, and the
   * limitation is the point: it answers "was this fill worse than the ones
   * around it", not "was it worse than the market". A feed-relative mark needs
   * the feed price at quote time, which nothing records today.
   */
  driftBps: number | null
}

export interface FxLeg {
  /** `<inbound asset>-><outbound asset>`, with `btc` for the BTC leg. */
  leg: string
  corridor: string
  count: number
  /** Volume-weighted mean rate over the window — the benchmark `driftBps` is measured against. */
  meanRate: number | null
  points: FxPoint[]
}

export interface LedgerSummary {
  since: number
  until: number
  count: number
  realizedCount: number
  failedCount: number
  pricedCount: number
  grossSats: number
  volumeSats: number
  marginBps: number | null
  atRiskSats: number
  /** Rows in the window this layer could not price, and therefore left out of every total. */
  unpricedCount: number
  /**
   * Rows that ARE a loss whose size cannot be said in sats — a token payout on
   * a corridor with no sats notional.
   *
   * The at-risk side's answer to `unpricedCount`. `atRiskSats` sums with a
   * `?? 0`, so without this counter an unmeasurable loss and no loss at all
   * render as the same zero, on the one figure an operator most needs to be
   * able to trust.
   */
  atRiskUnknownCount: number
  /** Rows still open at the end of the window — money committed, outcome unknown. */
  openCount: number
}

const ASSET_LABEL = (assetId: string | null): string => assetId ?? 'btc'

const sortedNumbers = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b)

/**
 * Nearest-rank percentile over an already-sorted list.
 *
 * Nearest-rank rather than interpolated: every input here is a count of
 * seconds or basis points from a real swap, and an interpolated p90 is a
 * duration no swap actually took.
 */
export const percentile = (sorted: readonly number[], fraction: number): number | null => {
  if (sorted.length === 0) return null
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[rank] ?? null
}

export const median = (values: readonly number[]): number | null => percentile(sortedNumbers(values), 0.5)

/** Volume-weighted margin in bps, or null when no volume was priced. */
const marginBpsOf = (grossSats: number, volumeSats: number): number | null =>
  volumeSats > 0 ? Math.trunc((grossSats / volumeSats) * 10_000) : null

/** A record counts toward a total only when it both delivered and has a sats spread. */
const priced = (record: SwapEconomics): boolean => record.realized && record.grossSats !== null

/**
 * The sats size of a trade — THE DENOMINATOR every margin is a margin of.
 *
 * Takes whichever leg is actually sats, not the inbound one. Reading the
 * inbound leg alone was a unit error with a visible consequence: on the ERC20
 * RECEIVE direction the intake is a token and the payout is sats, so its spread
 * entered the numerator while its notional contributed nothing to the
 * denominator. One 500-sat spread on a 50,000-sat trade then moved a blended
 * `marginBps` by fifty basis points while adding no volume at all — and the
 * mirror direction, whose intake IS sats, behaved correctly, so the error was
 * asymmetric and looked like a real difference between the two legs.
 *
 * Intake and payout differ by exactly the spread, which is immaterial as a
 * denominator and is why either leg will do as "the size of the trade".
 * Zero only when NEITHER leg is sats — a genuine asset-to-asset fill, which has
 * no `grossSats` either and so never reaches a total.
 */
const notionalSats = (record: SwapEconomics): number => {
  if (record.inbound.assetId === null && record.inbound.amount !== null) return Number(record.inbound.amount)
  if (record.outbound.assetId === null && record.outbound.amount !== null) return Number(record.outbound.amount)
  return 0
}

export const summarise = (records: readonly SwapEconomics[], since: number, until: number): LedgerSummary => {
  let grossSats = 0
  let volumeSats = 0
  let atRiskSats = 0
  let realizedCount = 0
  let failedCount = 0
  let pricedCount = 0
  let openCount = 0
  let atRiskUnknownCount = 0

  for (const record of records) {
    if (record.realized) realizedCount += 1
    if (record.phase === 'failed') failedCount += 1
    if (record.phase === 'open' || record.phase === 'exposed') openCount += 1
    atRiskSats += record.atRiskSats ?? 0
    if (record.atRiskUnknown) atRiskUnknownCount += 1
    if (!priced(record)) continue
    pricedCount += 1
    grossSats += record.grossSats ?? 0
    volumeSats += notionalSats(record)
  }

  return {
    since,
    until,
    count: records.length,
    realizedCount,
    failedCount,
    pricedCount,
    grossSats,
    volumeSats,
    marginBps: marginBpsOf(grossSats, volumeSats),
    atRiskSats,
    // Realized but unpriceable — a cross-asset fill, mostly. Reported so the
    // headline total can be read as covering part of the book rather than all
    // of it.
    unpricedCount: realizedCount - pricedCount,
    atRiskUnknownCount,
    openCount,
  }
}

/**
 * Bucket by SETTLEMENT time, not by quote time.
 *
 * A swap quoted on Monday and filled on Tuesday belongs to Tuesday's P&L: the
 * money moved then, and an operator reconciling a day against a wallet is
 * reading the day it moved. Quote time stays on every record for the cohort
 * question, which is a different chart.
 *
 * Empty buckets are EMITTED rather than skipped, so a gap in trading draws as a
 * flat line instead of a straight segment between two distant points — which
 * reads as steady activity across a period when nothing happened at all.
 */
export const series = (
  records: readonly SwapEconomics[],
  options: { since: number; until: number; bucketSeconds: number },
): SeriesPoint[] => {
  const { since, until, bucketSeconds } = options
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0) throw new Error('bucketSeconds must be positive')
  if (until <= since) return []
  // The backstop, not the gate: the admin route refuses this with a 400 and a
  // sentence naming the fix. Here so that a caller reaching this function
  // directly — a future CLI, an embedder — cannot exhaust memory by forgetting
  // to check. @see MAX_SERIES_BUCKETS
  const wanted = bucketCount(since, until, bucketSeconds)
  if (wanted > MAX_SERIES_BUCKETS) {
    throw new Error(`series would build ${wanted} buckets, over the ${MAX_SERIES_BUCKETS} cap; widen bucketSeconds`)
  }

  const start = Math.floor(since / bucketSeconds) * bucketSeconds
  const points = new Map<number, SeriesPoint>()
  for (let at = start; at < until; at += bucketSeconds) {
    points.set(at, {
      at,
      count: 0,
      realizedCount: 0,
      failedCount: 0,
      pricedCount: 0,
      grossSats: 0,
      cumulativeGrossSats: 0,
      volumeSats: 0,
      atRiskSats: 0,
    })
  }

  for (const record of records) {
    // The window, enforced HERE and not only by the caller. The first bucket
    // starts at `floor(since / bucketSeconds)`, which can precede `since` — so
    // a record settled in the minutes before the window opened lands in a
    // bucket that exists and is counted. The admin route never shows it,
    // because its stores filter on `updated_at` first; a direct caller of this
    // exported function has no such protection.
    if (record.settledAt < since || record.settledAt >= until) continue
    const bucket = points.get(Math.floor(record.settledAt / bucketSeconds) * bucketSeconds)
    if (!bucket) continue
    bucket.count += 1
    if (record.realized) bucket.realizedCount += 1
    if (record.phase === 'failed') bucket.failedCount += 1
    bucket.atRiskSats += record.atRiskSats ?? 0
    if (!priced(record)) continue
    bucket.pricedCount += 1
    bucket.grossSats += record.grossSats ?? 0
    bucket.volumeSats += notionalSats(record)
  }

  let running = 0
  const ordered = [...points.values()].sort((a, b) => a.at - b.at)
  for (const point of ordered) {
    running += point.grossSats
    point.cumulativeGrossSats = running
  }
  return ordered
}

export const byCorridor = (records: readonly SwapEconomics[]): CorridorBreakdown[] => {
  const groups = new Map<string, SwapEconomics[]>()
  for (const record of records) {
    const group = groups.get(record.corridor)
    if (group) group.push(record)
    else groups.set(record.corridor, [record])
  }

  return [...groups.entries()]
    .map(([corridor, group]) => {
      const pricedRows = group.filter(priced)
      const grossSats = pricedRows.reduce((total, record) => total + (record.grossSats ?? 0), 0)
      const volumeSats = pricedRows.reduce((total, record) => total + notionalSats(record), 0)
      const durations = sortedNumbers(group.filter((r) => r.realized).map((r) => r.durationSeconds))
      return {
        corridor,
        count: group.length,
        realizedCount: group.filter((r) => r.realized).length,
        failedCount: group.filter((r) => r.phase === 'failed').length,
        pricedCount: pricedRows.length,
        grossSats,
        volumeSats,
        marginBps: marginBpsOf(grossSats, volumeSats),
        atRiskSats: group.reduce((total, record) => total + (record.atRiskSats ?? 0), 0),
        medianDurationSeconds: percentile(durations, 0.5),
        p90DurationSeconds: percentile(durations, 0.9),
        crossAsset: group.some((r) => r.inbound.assetId !== r.outbound.assetId),
      }
    })
    .sort((a, b) => b.grossSats - a.grossSats || a.corridor.localeCompare(b.corridor))
}

/**
 * Margin against how long the fill took — the chart the FX question is asked of.
 *
 * Realized rows only. A refused quote has no duration worth banding: it ended
 * because it lapsed, so its "duration" is the validity window rather than
 * anything about execution, and including it would put a spike in the slowest
 * band that has nothing to do with a fill.
 */
export const byDuration = (records: readonly SwapEconomics[]): DurationBand[] => {
  const realized = records.filter((record) => record.realized)
  const bandOf = (seconds: number): number => {
    const index = DURATION_BANDS.findIndex((band) => band.untilSeconds !== null && seconds < band.untilSeconds)
    return index === -1 ? DURATION_BANDS.length - 1 : index
  }

  return DURATION_BANDS.map((band, index) => {
    const group = realized.filter((record) => bandOf(record.durationSeconds) === index)
    const pricedRows = group.filter(priced)
    const grossSats = pricedRows.reduce((total, record) => total + (record.grossSats ?? 0), 0)
    const volumeSats = pricedRows.reduce((total, record) => total + notionalSats(record), 0)
    return {
      label: band.label,
      untilSeconds: band.untilSeconds,
      count: group.length,
      pricedCount: pricedRows.length,
      grossSats,
      volumeSats,
      marginBps: marginBpsOf(grossSats, volumeSats),
      medianBps: median(pricedRows.map((record) => record.grossBps).filter((bps): bps is number => bps !== null)),
    }
  })
}

/**
 * Executed rates, grouped by DIRECTIONAL leg.
 *
 * Directional because `A->B` and `B->A` are reciprocals: pooling them would
 * average a rate against its own inverse and produce a benchmark no fill was
 * ever near. Every cross-asset record with both legs funded is a point.
 */
export const byFxLeg = (records: readonly SwapEconomics[]): FxLeg[] => {
  // Keyed by corridor AND leg. Two corridors can quote the same pair of assets
  // over different rails at genuinely different prices, and pooling them would
  // benchmark each against the other's execution cost.
  const groups = new Map<string, { corridor: string; leg: string; rows: SwapEconomics[] }>()
  for (const record of records) {
    if (record.inbound.assetId === record.outbound.assetId) continue
    if (record.rate === null || !record.realized) continue
    const leg = `${ASSET_LABEL(record.inbound.assetId)}->${ASSET_LABEL(record.outbound.assetId)}`
    const key = `${record.corridor}|${leg}`
    const group = groups.get(key)
    if (group) group.rows.push(record)
    else groups.set(key, { corridor: record.corridor, leg, rows: [record] })
  }

  return [...groups.values()]
    .map(({ corridor, leg, rows }) => {
      // Weighted by the inbound leg so a large fill moves the benchmark more
      // than a dust one — an unweighted mean lets a handful of tiny swaps set
      // the line every real trade is then judged against.
      let weight = 0
      let weighted = 0
      const rated = rows.map((record) => {
        const denominator = Number(record.rate?.denominator ?? '0')
        const numerator = Number(record.rate?.numerator ?? '0')
        const rate = denominator > 0 ? numerator / denominator : Number.NaN
        if (Number.isFinite(rate) && denominator > 0) {
          weight += denominator
          weighted += rate * denominator
        }
        return { record, rate }
      })
      const meanRate = weight > 0 ? weighted / weight : null

      return {
        leg,
        corridor,
        count: rows.length,
        meanRate,
        points: rated
          .filter(({ rate }) => Number.isFinite(rate))
          .map(({ record, rate }) => ({
            id: record.id,
            at: record.settledAt,
            durationSeconds: record.durationSeconds,
            rate,
            driftBps: meanRate !== null && meanRate > 0 ? Math.trunc(((meanRate - rate) / meanRate) * 10_000) : null,
          }))
          .sort((a, b) => a.at - b.at),
      }
    })
    .sort((a, b) => b.count - a.count || a.leg.localeCompare(b.leg))
}
