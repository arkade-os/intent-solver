/**
 * Where the time actually goes, from swaps that already happened.
 *
 * "Detection feels slow, and we cannot tell whether it is nostr, the indexer
 * subscription, or the claim" is a question the database can already answer.
 * Every state transition is written to a `*_swap_event` row with a timestamp,
 * so the duration of each phase of every swap this deployment has ever served
 * is on disk. Nothing here is new instrumentation; it is arithmetic on data
 * nobody has looked at as durations.
 *
 * That matters because instrumenting first is the expensive way round: it needs
 * a code change, a deploy, and then a wait for traffic — and it measures only
 * the spans someone guessed at. This runs against history, covers every phase
 * at once, and says which one to instrument properly.
 *
 * RESOLUTION IS ONE SECOND, and that is the honest limit of it. Event
 * timestamps come from `nowSeconds`, so a phase that takes 40ms and one that
 * takes 900ms are both "0s". This localises a slow phase; it cannot profile a
 * fast one. If every phase here reads 0s and the swap still feels slow, the
 * latency is inside a phase rather than between them, and THAT is when
 * millisecond instrumentation earns its cost.
 *
 * Run:
 *   node --env-file=.env scripts/latency-report.mjs
 *   node --env-file=.env scripts/latency-report.mjs --since 2026-08-01 --corridor ln-ark
 */

import { existsSync } from 'node:fs'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { resolveDbLayout } from '@arkade-os/solver-corridors/db/layout.js'
import { swapDbPath } from '../packages/solver-app/dist/config.js'
import { summariseLatency } from '../packages/solver-app/dist/ops/latency.js'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1]
}

/** `--since 2026-08-01`, `--since 1787328000`, or nothing. */
const sinceArg = arg('since')
const since = sinceArg === null ? 0 : /^\d+$/.test(sinceArg) ? Number(sinceArg) : Math.floor(Date.parse(sinceArg) / 1000)
if (Number.isNaN(since)) {
  console.error(`--since ${sinceArg} is neither a unix timestamp nor a date`)
  process.exit(2)
}

const CORRIDORS = [
  { key: 'ark-ln', corridor: 'arkade:BTC->lightning:BTC', store: 'send', table: 'send_swap_event' },
  { key: 'ln-ark', corridor: 'lightning:BTC->arkade:BTC', store: 'receive', table: 'receive_swap_event' },
  { key: 'ark-l1', corridor: 'arkade:BTC->onchain:BTC', store: 'onchainSend', table: 'send_onchain_swap_event' },
  { key: 'l1-ark', corridor: 'onchain:BTC->arkade:BTC', store: 'onchainReceive', table: 'receive_onchain_swap_event' },
]

const only = arg('corridor')
const wanted = only ? CORRIDORS.filter((c) => c.key === only || c.corridor === only) : CORRIDORS
if (wanted.length === 0) {
  console.error(`--corridor ${only} is not one of: ${CORRIDORS.map((c) => c.key).join(', ')}`)
  process.exit(2)
}

const layout = resolveDbLayout(swapDbPath())

const secs = (n) => (n >= 60 ? `${Math.floor(n / 60)}m${String(n % 60).padStart(2, '0')}s` : `${n}s`)

let anyData = false

for (const { corridor, store, table } of wanted) {
  const path = layout[store]
  if (!path || !existsSync(path)) {
    console.log(`${corridor}\n  no database at ${path}\n`)
    continue
  }
  const driver = betterSqliteDriver(path)

  // Ordered by `id`, not `at`: a second holds many events and the insertion
  // order is the only faithful record of which came first.
  const rows = await driver.all(
    `SELECT swap_id, at, from_state, to_state, detail FROM ${table} WHERE at >= ? ORDER BY swap_id, id`,
    [since],
  )
  if (rows.length === 0) {
    console.log(`${corridor}\n  no events since ${since}\n`)
    continue
  }
  anyData = true

  // Ordering is preserved all the way through: `summariseLatency` relies on the
  // rowid order above and deliberately does not re-sort by `at`.
  const summary = summariseLatency(
    rows.map((r) => ({ swapId: r.swap_id, at: Number(r.at), from: r.from_state, to: r.to_state, detail: r.detail })),
  )

  console.log(`${corridor}  (${summary.swaps} swaps, ${rows.length} events)`)
  const width = Math.max(...summary.steps.map((m) => m.label.length), 22)
  const line = (m, flag = '') =>
    console.log(
      `  ${m.label.padEnd(width)}  n=${String(m.n).padStart(4)}` +
        `  p50 ${secs(m.p50).padStart(6)}  p95 ${secs(m.p95).padStart(6)}  max ${secs(m.max).padStart(6)}${flag}`,
    )
  for (const [i, m] of summary.steps.entries()) {
    line(m, i === 0 && summary.steps.length > 1 && m.p50 > 0 ? '   <-- slowest by p50' : '')
  }
  if (summary.endToEnd) line(summary.endToEnd)
  console.log()
}

if (!anyData) {
  console.log('Nothing to report. Check DB_DIR / SWAP_DB_PATH point at the deployment volume.')
  process.exit(1)
}

console.log('Resolution is 1s: event timestamps are whole seconds.')
console.log('Every phase reading 0s means the latency is INSIDE a phase, not between them —')
console.log('that is the case where millisecond instrumentation is worth adding, and where.')
