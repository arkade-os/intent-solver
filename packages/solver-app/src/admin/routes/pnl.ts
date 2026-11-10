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
 *  - **Figures are GROSS unless a rail reported what execution cost.** Where one
 *    did, `netSats` sits beside `grossSats` and `costedCount` says over how many
 *    rows — today that is the Lightning send leg alone, whose backend reports
 *    the routing fee it actually paid. Every other rail reports no realized cost
 *    at all (`OnchainTxOutcome` is a status word; `fund()` answers a txid), so
 *    on those corridors chain fees are missing from the total rather than
 *    deducted from it, and a corridor quoting 30bps into a fee market that took
 *    40 still shows a profit here. `netSats` is null rather than falling back to
 *    the gross, because the one thing this screen must never do is let gross be
 *    read as net.
 *  - **A corridor with no `economics` is UNMEASURED, never zero.** It is named
 *    in `unmeasured` so the console can say so rather than silently averaging
 *    it in at nothing.
 *  - **A window that overflows its row cap says so.** `truncated` means the
 *    totals cover part of the book; they are not presented as all of it.
 */

import type { Hono } from 'hono'
import type { AdminDeps } from '../server.js'
import type { OperatorWithdrawal } from '../db.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { balanceCheckpointScope, type BalanceCheckpoint } from '../../ops/balanceCheckpoints.js'
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
const CHECKPOINT_LIMIT = 2_000
const CHECKPOINT_CADENCE_SECONDS = 60

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

const satsValue = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

const satsDelta = (before: number | null, after: number | null): number | null =>
  before === null || after === null ? null : after - before

const onchainSats = (checkpoint: BalanceCheckpoint): number | null => {
  if (!checkpoint.onchain) return null
  const confirmed = satsValue(checkpoint.onchain.confirmedSats)
  const unconfirmed = satsValue(checkpoint.onchain.unconfirmedSats)
  return confirmed === null || unconfirmed === null ? null : confirmed + unconfirmed
}

const checkpointRailSats = (checkpoint: BalanceCheckpoint) => ({
  arkadeSats: satsValue(checkpoint.arkade?.totalSats),
  lightningSats: satsValue(checkpoint.lightningSats),
  onchainSats: onchainSats(checkpoint),
})

const checkpointSummary = (checkpoint: BalanceCheckpoint, previous: BalanceCheckpoint | undefined) => {
  const totalSats = satsValue(checkpoint.totalSats)
  const previousTotalSats = satsValue(previous?.totalSats)
  const rails = checkpointRailSats(checkpoint)
  const previousRails = previous ? checkpointRailSats(previous) : null
  const gapSeconds = previous ? Math.max(0, checkpoint.startedAt - previous.finishedAt) : null
  return {
    id: checkpoint.id,
    at: checkpoint.startedAt,
    finishedAt: checkpoint.finishedAt,
    totalSats,
    complete: totalSats !== null,
    deltaSats: satsDelta(previousTotalSats, totalSats),
    arkadeSats: rails.arkadeSats,
    lightningSats: rails.lightningSats,
    onchainSats: rails.onchainSats,
    arkadeDeltaSats: satsDelta(previousRails?.arkadeSats ?? null, rails.arkadeSats),
    lightningDeltaSats: satsDelta(previousRails?.lightningSats ?? null, rails.lightningSats),
    onchainDeltaSats: satsDelta(previousRails?.onchainSats ?? null, rails.onchainSats),
    errors: checkpoint.errors,
    gapSeconds,
    gap: gapSeconds !== null && gapSeconds > CHECKPOINT_CADENCE_SECONDS * 2,
  }
}

type CheckpointLedger = {
  scope: string
  checkpoints: ReturnType<typeof checkpointSummary>[]
  gaps: { afterId: number; beforeId: number; from: number; to: number; seconds: number }[]
  windowCount: number
  observedFrom: number | null
  observedTo: number | null
  openingSats: number | null
  closingSats: number | null
  changeSats: number | null
  limited: boolean
  incompleteCount: number
}

const emptyCheckpointLedger = (scope: string): CheckpointLedger => ({
  scope,
  checkpoints: [],
  gaps: [],
  windowCount: 0,
  observedFrom: null,
  observedTo: null,
  openingSats: null,
  closingSats: null,
  changeSats: null,
  limited: false,
  incompleteCount: 0,
})

const checkpointLedger = async (
  deps: AdminDeps,
  window: LedgerWindow & { label: string },
): Promise<CheckpointLedger> => {
  const scope = balanceCheckpointScope(deps.services)
  const rows = await deps.services.adminStore.listBalanceCheckpoints(scope, CHECKPOINT_LIMIT)
  // The store returns newest first; reverse for chronological gap and delta math.
  const ascending = [...rows].reverse()
  let prior: BalanceCheckpoint | undefined
  for (const checkpoint of ascending) {
    if (checkpoint.startedAt >= window.since) break
    prior = checkpoint
  }
  const inWindow = ascending.filter(
    (checkpoint) => checkpoint.startedAt >= window.since && checkpoint.startedAt < window.until,
  )
  const selected = prior ? [prior, ...inWindow] : inWindow
  const checkpoints = selected.map((checkpoint, index) => checkpointSummary(checkpoint, selected[index - 1]))
  const gaps = checkpoints.flatMap((checkpoint, index) => {
    if (index === 0 || checkpoint.gapSeconds === null || !checkpoint.gap) return []
    const previous = checkpoints[index - 1]!
    return [
      {
        afterId: previous.id,
        beforeId: checkpoint.id,
        from: previous.finishedAt,
        to: checkpoint.at,
        seconds: checkpoint.gapSeconds,
      },
    ]
  })
  const opening = checkpoints[0]
  const closing = checkpoints.at(-1)
  return {
    scope,
    checkpoints,
    gaps,
    windowCount: inWindow.length,
    observedFrom: opening?.at ?? null,
    observedTo: closing?.finishedAt ?? null,
    openingSats: opening?.totalSats ?? null,
    closingSats: closing?.totalSats ?? null,
    changeSats: satsDelta(opening?.totalSats ?? null, closing?.totalSats ?? null),
    limited: rows.length >= CHECKPOINT_LIMIT && (ascending[0]?.startedAt ?? Number.POSITIVE_INFINITY) > window.since,
    incompleteCount: checkpoints.filter((checkpoint) => !checkpoint.complete).length,
  }
}

const withdrawalRow = (withdrawal: OperatorWithdrawal) => ({
  ...withdrawal,
  debitSats: withdrawal.feeSats === null ? null : withdrawal.amountSats + withdrawal.feeSats,
})

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

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
  const now = deps.now ?? nowSeconds

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
    const summary = summarise(scanned.records, window.since, window.until)
    return c.json({
      window: { since: window.since, until: window.until, label: window.label, bucketSeconds: bucket.seconds },
      summary,
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
        // `mixed` once any row in the window carried a realized cost: part of
        // the book is net and part is gross, and saying 'net' would claim the
        // deduction covers all of it.
        basis: summary.costedCount === 0 ? 'gross' : 'mixed',
        note:
          summary.costedCount === 0
            ? 'No rail in this window reported what execution cost, so nothing is deducted: every figure is gross.'
            : `netSats deducts the realized execution cost of ${summary.costedCount} of ${summary.pricedCount} ` +
              'priced swaps. The rest report no cost and are gross. grossSats never has anything deducted.',
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

  app.get('/api/reconciliation', async (c) => {
    let window: LedgerWindow & { label: string }
    try {
      window = windowFrom(c.req.query(), now())
    } catch (error) {
      if (!(error instanceof BadRequest)) throw error
      return c.json({ error: 'bad_request', message: error.message }, 400)
    }

    const scope = balanceCheckpointScope(deps.services)
    const [scannedResult, ledgerResult] = await Promise.allSettled([scan(deps, window), checkpointLedger(deps, window)])
    const scanned: Scan =
      scannedResult.status === 'fulfilled'
        ? scannedResult.value
        : { records: [], measured: [], unmeasured: [], failed: [], truncated: [] }
    const ledger = ledgerResult.status === 'fulfilled' ? ledgerResult.value : emptyCheckpointLedger(scope)
    const records = [...scanned.records].sort((a, b) => b.settledAt - a.settledAt || a.id.localeCompare(b.id))
    const summary = summarise(records, window.since, window.until)
    const [withdrawalResult, rebalanceResult] = await Promise.allSettled([
      deps.services.adminStore.listOperatorWithdrawals(ledger.scope, window.since),
      deps.services.rebalanceStore?.checkpointTransfers(window.since) ?? Promise.resolve([]),
    ])
    const withdrawals = withdrawalResult.status === 'fulfilled' ? withdrawalResult.value : []
    const rebalances = rebalanceResult.status === 'fulfilled' ? rebalanceResult.value : []
    const withdrawalRows = withdrawals.filter((withdrawal) => withdrawal.createdAt < window.until).map(withdrawalRow)
    const rebalanceRows = rebalances
      .filter((transfer) => (transfer.chargedAt ?? transfer.createdAt) < window.until)
      .map((transfer) => ({
        id: transfer.id,
        origin: transfer.origin,
        poolId: transfer.poolId,
        kind: transfer.deposit.kind,
        state: transfer.state,
        netSats: transfer.netSats,
        debitSats: transfer.debitSats,
        feeSats: transfer.feeSats,
        creditedSats: transfer.creditedSats ?? null,
        at: transfer.chargedAt ?? transfer.createdAt,
        updatedAt: transfer.updatedAt,
      }))

    const sentWithdrawals = withdrawalRows.filter((withdrawal) => withdrawal.state === 'sent')
    const completedRebalances = rebalanceRows.filter((transfer) => transfer.state === 'completed')
    return c.json({
      window: { since: window.since, until: window.until, label: window.label },
      balance: {
        ...ledger,
        limit: CHECKPOINT_LIMIT,
        cadenceSeconds: CHECKPOINT_CADENCE_SECONDS,
        incoming: ledger.checkpoints
          .filter((checkpoint) => (checkpoint.deltaSats ?? 0) > 0)
          .map((checkpoint) => ({
            id: checkpoint.id,
            at: checkpoint.at,
            amountSats: checkpoint.deltaSats,
            arkadeSats: checkpoint.arkadeDeltaSats,
            lightningSats: checkpoint.lightningDeltaSats,
            onchainSats: checkpoint.onchainDeltaSats,
          })),
      },
      swaps: {
        summary,
        records: records.slice(0, MAX_RECORDS),
        matchedCount: records.length,
        returnedCount: Math.min(records.length, MAX_RECORDS),
        recordLimit: MAX_RECORDS,
      },
      withdrawals: {
        records: withdrawalRows,
        sentCount: sentWithdrawals.length,
        amountSats: sentWithdrawals.reduce((total, withdrawal) => total + withdrawal.amountSats, 0),
        feeSats: sentWithdrawals.reduce((total, withdrawal) => total + (withdrawal.feeSats ?? 0), 0),
        debitSats: sentWithdrawals.reduce(
          (total, withdrawal) => total + (withdrawal.debitSats ?? withdrawal.amountSats),
          0,
        ),
        unreportedFeeCount: sentWithdrawals.filter((withdrawal) => withdrawal.feeSats === null).length,
        error: withdrawalResult.status === 'rejected' ? errorMessage(withdrawalResult.reason) : null,
      },
      rebalances: {
        records: rebalanceRows,
        completedCount: completedRebalances.length,
        feeSats: completedRebalances.reduce((total, transfer) => total + (transfer.feeSats ?? 0), 0),
        error: rebalanceResult.status === 'rejected' ? errorMessage(rebalanceResult.reason) : null,
      },
      coverage: {
        measured: scanned.measured,
        unmeasured: scanned.unmeasured,
        failed: scanned.failed,
        truncated: scanned.truncated,
        failedSections: [
          ...(scannedResult.status === 'rejected'
            ? [{ section: 'swaps', reason: errorMessage(scannedResult.reason) }]
            : []),
          ...(ledgerResult.status === 'rejected'
            ? [{ section: 'checkpoints', reason: errorMessage(ledgerResult.reason) }]
            : []),
          ...(withdrawalResult.status === 'rejected'
            ? [{ section: 'withdrawals', reason: errorMessage(withdrawalResult.reason) }]
            : []),
          ...(rebalanceResult.status === 'rejected'
            ? [{ section: 'rebalances', reason: errorMessage(rebalanceResult.reason) }]
            : []),
        ],
        basis: summary.costedCount === 0 ? 'gross' : 'mixed',
      },
    })
  })
}
