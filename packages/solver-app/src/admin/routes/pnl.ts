/**
 * The book: what this solver made, where, and where it went wrong.
 *
 * ONE ROUTE FOR THE WHOLE SCREEN, and that is a deliberate departure from the
 * one-endpoint-per-panel shape the rest of `admin/routes/` uses. Every panel
 * here is a different aggregation of the SAME scan — split across five
 * endpoints, a single console refresh would re-read every swap table five
 * times, and over a tunnel on a two-second tick that is the difference between
 * a dashboard and a load generator. The drill-down list is separate because it
 * is the one view that does not need the aggregate.
 *
 * READ-ONLY, like every route here but `actions.ts`. Nothing on this path can
 * change a swap.
 *
 * WHAT THIS SCREEN DOES NOT KNOW, stated here because it is the first thing a
 * reader should learn and the last thing they should have to discover:
 *
 *  - **Every figure is GROSS.** `ports/lightning.ts`'s `PaymentResult` carries
 *    no routing fee, so what a payment actually cost is written down nowhere —
 *    chain and routing costs are missing from every total here, not netted out
 *    of it. A corridor quoting 30bps against a fee market that took 40 shows a
 *    profit on this screen and lost money in fact. A quote-time BUDGET does
 *    exist on some rows and rides along as `quotedCostSats`; it is a ceiling,
 *    never a cost, and nothing here deducts it.
 *  - **A corridor with no `economics` is UNMEASURED, never zero.** It is named
 *    in `unmeasured` so the console can say so rather than silently averaging
 *    it in at nothing.
 *  - **A window that overflows its row cap says so.** `truncated` means the
 *    totals cover part of the book; they are not presented as all of it.
 */

import type { Hono } from 'hono'
import type { AdminDeps } from '../server.js'
import {
  DEFAULT_LEDGER_LIMIT,
  MAX_LEDGER_LIMIT,
  type LedgerWindow,
  type SwapEconomics,
} from '@arkade-os/solver-core/analytics/economics.js'
import {
  BUCKETS,
  MAX_SERIES_BUCKETS,
  bucketCount,
  byCorridor,
  byDuration,
  byFxLeg,
  series,
  summarise,
  type BucketName,
} from '@arkade-os/solver-core/analytics/aggregate.js'

/** Window presets, in seconds. A caller may also name `since`/`until` outright. */
const WINDOWS: Record<string, number> = {
  '1h': 3_600,
  '6h': 21_600,
  '24h': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
  '90d': 7_776_000,
}

const DEFAULT_WINDOW = '7d'

/**
 * The most records `/api/pnl/swaps` will serialise into one body.
 *
 * A separate bound from the per-corridor row cap, because they bound different
 * things: that one limits each SCAN, this one limits their CONCATENATION, and
 * on a deployment with one corridor per market per direction the second grows
 * with the market list however modest the first is. The true match count rides
 * alongside, so a capped list is never mistaken for the whole set.
 */
const MAX_RECORDS = 2_000

/**
 * A bucket width narrow enough to show shape and wide enough to stay readable.
 *
 * Chosen from the window rather than fixed, because one setting cannot serve
 * both: 5-minute buckets over 90 days is sixteen thousand points down a wire
 * to draw a line two hundred pixels wide, and daily buckets over an hour is one
 * point. The caller can still override it.
 */
const defaultBucketFor = (windowSeconds: number): BucketName =>
  windowSeconds <= 21_600 ? '5m' : windowSeconds <= 172_800 ? '1h' : windowSeconds <= 1_209_600 ? '6h' : '1d'

class BadRequest extends Error {}

/**
 * A non-negative integer, parsed from the STRING rather than coerced.
 *
 * `Number()` alone is too generous in three ways that all reach this route:
 * `Number('')` is 0, so `?since=` silently means the epoch; `Number('0x10')` is
 * 16; and `Number('1e18')` is an integer as far as `Number.isInteger` is
 * concerned, which is how a window nobody could mean gets through validation.
 * A digits-only test rejects all three, and rejects them as the caller
 * mistakes they are rather than answering a different question.
 */
const positiveInt = (raw: string | undefined, label: string): number | undefined => {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) throw new BadRequest(`${label} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new BadRequest(`${label} is too large to be a unix timestamp: ${raw}`)
  return value
}

/**
 * The window a request asked for, half-open `[since, until)`.
 *
 * Explicit `since`/`until` win over a preset, because a caller that named both
 * a preset and a boundary has expressed the boundary more precisely and
 * silently discarding it would answer a question they did not ask.
 */
const windowFrom = (query: Record<string, string>, now: number): LedgerWindow & { label: string } => {
  const limit = positiveInt(query.limit, 'limit') ?? DEFAULT_LEDGER_LIMIT
  if (limit === 0 || limit > MAX_LEDGER_LIMIT) {
    throw new BadRequest(`limit must be between 1 and ${MAX_LEDGER_LIMIT}, got ${limit}`)
  }

  const until = positiveInt(query.until, 'until') ?? now
  const explicitSince = positiveInt(query.since, 'since')
  if (explicitSince !== undefined) {
    if (explicitSince >= until) throw new BadRequest(`since ${explicitSince} is not before until ${until}`)
    return { since: explicitSince, until, limit, label: 'custom' }
  }

  const label = query.window ?? DEFAULT_WINDOW
  const span = WINDOWS[label]
  if (span === undefined)
    throw new BadRequest(`unknown window '${label}'; try one of ${Object.keys(WINDOWS).join(', ')}`)
  return { since: Math.max(0, until - span), until, limit, label }
}

const bucketFrom = (raw: string | undefined, windowSeconds: number): { name: BucketName; seconds: number } => {
  const name = (raw ?? defaultBucketFor(windowSeconds)) as BucketName
  const seconds = BUCKETS[name]
  if (seconds === undefined)
    throw new BadRequest(`unknown bucket '${raw}'; try one of ${Object.keys(BUCKETS).join(', ')}`)
  return { name, seconds }
}

interface Scan {
  records: SwapEconomics[]
  /** Corridors that answered. */
  measured: string[]
  /** Corridors with no `economics` capability — reported, never counted as zero. */
  unmeasured: string[]
  /**
   * Corridors that HAVE the capability and threw.
   *
   * Split from {@link Scan.unmeasured} because the two mean different things to
   * whoever is reading: a corridor that never claimed to answer is a gap in
   * coverage, and one that claimed to and failed is a FAULT — a broken store, a
   * corridor that cannot attribute its own rows — and someone should go and
   * look. Folding them together made a live incident indistinguishable from a
   * corridor nobody has got round to instrumenting.
   */
  failed: { corridor: string; reason: string }[]
  /** Corridors whose window overflowed the row cap. */
  truncated: string[]
}

/**
 * Ask every reader for its window, in parallel.
 *
 * `Promise.all` over the readers rather than a loop: the four-plus stores are
 * independent files and the scans do not contend, so serialising them would
 * multiply the screen's latency by the number of corridors served — which on an
 * asset deployment is one per market per direction.
 *
 * A corridor that THROWS is not silently dropped. It would otherwise vanish
 * from `unmeasured` too and the total would read as complete, so a fault lands
 * as an unmeasured corridor: the honest report of "this one is not in the
 * number you are looking at".
 */
const scan = async (deps: AdminDeps, window: LedgerWindow, corridor?: string): Promise<Scan> => {
  // Narrowed BEFORE the scan, not after it. A request for one corridor used to
  // read and sort every other corridor's rows up to their caps and then discard
  // them — and a slow unrelated store delayed the answer. Asking only the named
  // corridor is the point of the filter, which is the same reasoning
  // `routes/swaps.ts` states for its own.
  const all = [...deps.services.readers]
  const readers = corridor === undefined ? all : all.filter((r) => r.descriptor.pair === corridor)
  const results = await Promise.all(
    readers.map(async (reader) => {
      const pair = reader.descriptor.pair
      if (!reader.economics) return { pair, ledger: null, reason: null }
      try {
        return { pair, ledger: await reader.economics(window), reason: null }
      } catch (error) {
        // The message only — never the error object, which is the rule
        // `cli.ts` states for the same reason config objects carry mnemonics.
        return { pair, ledger: null, reason: error instanceof Error ? error.message : String(error) }
      }
    }),
  )

  const scanned: Scan = { records: [], measured: [], unmeasured: [], failed: [], truncated: [] }
  for (const { pair, ledger, reason } of results) {
    if (!ledger) {
      if (reason === null) scanned.unmeasured.push(pair)
      else scanned.failed.push({ corridor: pair, reason })
      continue
    }
    scanned.measured.push(pair)
    if (ledger.truncated) scanned.truncated.push(pair)
    scanned.records.push(...ledger.records)
  }
  return scanned
}

export const registerPnlRoutes = (app: Hono, deps: AdminDeps): void => {
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000))

  app.get('/api/pnl', async (c) => {
    let window: LedgerWindow & { label: string }
    let bucket: { name: BucketName; seconds: number }
    try {
      window = windowFrom(c.req.query(), now())
      bucket = bucketFrom(c.req.query().bucket, window.until - window.since)
      // BEFORE the scan, and before `series` allocates anything. `since` and
      // `bucket` are both caller-supplied and their quotient is the allocation:
      // `since=0&bucket=5m` spans from the epoch and asks for roughly six
      // million bucket objects. Refused with the fix named rather than clamped,
      // because a chart labelled "90 days" that silently shows six hours
      // answers a question nobody asked. @see MAX_SERIES_BUCKETS
      const wanted = bucketCount(window.since, window.until, bucket.seconds)
      if (wanted > MAX_SERIES_BUCKETS) {
        throw new BadRequest(
          `that window at bucket=${bucket.name} is ${wanted} buckets, over the ${MAX_SERIES_BUCKETS} limit — ` +
            'use a wider bucket or a shorter window',
        )
      }
    } catch (error) {
      if (!(error instanceof BadRequest)) throw error
      return c.json({ error: 'bad_request', message: error.message }, 400)
    }

    const scanned = await scan(deps, window)
    return c.json({
      window: { since: window.since, until: window.until, label: window.label, bucketSeconds: bucket.seconds },
      summary: summarise(scanned.records, window.since, window.until),
      series: series(scanned.records, { since: window.since, until: window.until, bucketSeconds: bucket.seconds }),
      corridors: byCorridor(scanned.records),
      durationBands: byDuration(scanned.records),
      fx: byFxLeg(scanned.records),
      coverage: {
        measured: scanned.measured,
        unmeasured: scanned.unmeasured,
        failed: scanned.failed,
        truncated: scanned.truncated,
        // Restated in the payload, not only in this file's comments: anything
        // reading the admin API programmatically deserves the caveat that
        // decides whether these numbers mean what they appear to.
        basis: 'gross',
        note:
          'Realized execution cost (chain and routing fees) is recorded by no corridor and is NOT deducted here. ' +
          'Where a row carries a quote-time fee BUDGET it rides along as quotedCostSats — a ceiling, never a cost.',
      },
      buckets: Object.keys(BUCKETS),
      windows: Object.keys(WINDOWS),
    })
  })

  /**
   * The rows behind the charts, newest settlement first.
   *
   * Separate from the aggregate because it is the only view that does not need
   * one — an operator following a point on the scatter back to the swap that
   * made it wants this and nothing else.
   */
  app.get('/api/pnl/swaps', async (c) => {
    const query = c.req.query()
    let window: LedgerWindow & { label: string }
    try {
      window = windowFrom(query, now())
    } catch (error) {
      if (!(error instanceof BadRequest)) throw error
      return c.json({ error: 'bad_request', message: error.message }, 400)
    }
    if (query.corridor !== undefined && !deps.services.readers.get(query.corridor)) {
      return c.json({ error: 'unknown_corridor', corridor: query.corridor }, 400)
    }

    const scanned = await scan(deps, window, query.corridor)
    const matched = [...scanned.records].sort((a, b) => b.settledAt - a.settledAt || a.id.localeCompare(b.id))
    // The per-corridor cap bounds each SCAN; it does not bound this BODY, which
    // is their concatenation. At the ceiling — `MAX_LEDGER_LIMIT` rows across
    // one corridor per market per direction — that is six figures of records in
    // a single response, tens of megabytes, on a route an operator reaches from
    // a laptop over a tunnel. Capped here, with the true match count reported
    // beside it so a truncated list can never read as the whole set.
    const records = matched.slice(0, MAX_RECORDS)

    return c.json({
      window: { since: window.since, until: window.until, label: window.label },
      records,
      matchedCount: matched.length,
      returnedCount: records.length,
      recordLimit: MAX_RECORDS,
      coverage: {
        measured: scanned.measured,
        unmeasured: scanned.unmeasured,
        failed: scanned.failed,
        truncated: scanned.truncated,
      },
    })
  })
}
