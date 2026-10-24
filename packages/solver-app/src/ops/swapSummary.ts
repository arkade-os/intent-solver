/**
 * What finished in a window, per corridor: fulfilled, failed with reasons, and
 * quotes nobody funded. Read from each corridor's own ledger, so a corridor a
 * consumer registers is counted the same way. @see balanceReport.ts
 */

import {
  DEFAULT_LEDGER_LIMIT,
  type CorridorLedger,
  type LedgerWindow,
} from '@arkade-os/solver-core/analytics/economics.js'
import { messageOf } from '@arkade-os/solver-core/util/poll.js'
import { createJoin, within } from './guardedRead.js'

export interface SummaryReader {
  readonly descriptor: { readonly pair: string }
  economics?(window: LedgerWindow): Promise<CorridorLedger>
}

export interface CorridorCount {
  corridor: string
  since: number
  fulfilled: number
  failed: number
  unfunded: number
  reasons: Map<string, number>
  truncated: boolean
}

export interface SwapSummary {
  since: number
  until: number
  corridors: CorridorCount[]
  unreadable: Array<{ corridor: string; error: string }>
  unmeasured: string[]
}

const MAX_REASONS = 5
const MAX_REASON_CHARS = 80

const count = (ledger: CorridorLedger): Omit<CorridorCount, 'since'> => {
  const c: Omit<CorridorCount, 'since'> = {
    corridor: ledger.corridor,
    fulfilled: 0,
    failed: 0,
    unfunded: 0,
    reasons: new Map(),
    truncated: ledger.truncated,
  }
  for (const r of ledger.records) {
    if (r.phase === 'done') c.fulfilled += 1
    else if (r.phase !== 'failed') continue
    // The ledger's own rule: an inbound amount appears only once the client's money arrived.
    else if (r.inbound.amount === null) c.unfunded += 1
    else {
      c.failed += 1
      // A reason's JSON detail is for the log; grouping on it would count each swap apart.
      const reason = r.failureReason?.split(' — {')[0] ?? r.state
      c.reasons.set(reason, (c.reasons.get(reason) ?? 0) + 1)
    }
  }
  return c
}

export interface SwapSummaryReaderOptions {
  now(): number
  /** Where every corridor's first window starts. */
  firstSince: number
  /** Per corridor; under the balance report's own 60s so a late read can never advance a window. */
  deadlineMs?: number
}

const CORRIDOR_DEADLINE_MS = 30_000

/**
 * Each corridor keeps its OWN window start, advanced only by a read that answered.
 * A failed or timed-out corridor is re-read from the same start next report, so its
 * swaps are late rather than lost.
 */
export const createSwapSummaryReader = (options: SwapSummaryReaderOptions) => {
  const since = new Map<string, number>()
  const joined = createJoin()
  const ms = options.deadlineMs ?? CORRIDOR_DEADLINE_MS

  return async (readers: Iterable<SummaryReader>): Promise<SwapSummary> => {
    const until = options.now()
    const outcomes = await Promise.all(
      [...readers].map(async (reader) => {
        const corridor = reader.descriptor.pair
        const { economics } = reader
        if (!economics) return { kind: 'unmeasured' as const, corridor }
        const from = since.get(corridor) ?? options.firstSince
        // A joined read answers for the window it was started with, so the start advances to ITS end.
        const read = joined(corridor, async () => ({
          ledger: await economics.call(reader, { since: from, until, limit: DEFAULT_LEDGER_LIMIT }),
          from,
          until,
        }))
        try {
          const done = await within(read, ms)()
          since.set(corridor, done.until)
          return { kind: 'counted' as const, count: { ...count(done.ledger), since: done.from } }
        } catch (error) {
          return { kind: 'unreadable' as const, corridor, error: messageOf(error) }
        }
      }),
    )
    const summary: SwapSummary = { since: options.firstSince, until, corridors: [], unreadable: [], unmeasured: [] }
    for (const o of outcomes) {
      if (o.kind === 'unmeasured') summary.unmeasured.push(o.corridor)
      else if (o.kind === 'unreadable') summary.unreadable.push({ corridor: o.corridor, error: o.error })
      else summary.corridors.push(o.count)
    }
    const starts = summary.corridors.map((c) => c.since)
    if (starts.length > 0) summary.since = Math.min(...starts)
    return summary
  }
}

// Code points, not UTF-16 units, so a cut never splits a surrogate pair.
const shorten = (text: string): string => {
  const chars = Array.from(text)
  return chars.length > MAX_REASON_CHARS ? `${chars.slice(0, MAX_REASON_CHARS - 1).join('')}…` : text
}

const stamp = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')

export const stampSpan = (since: number, until: number): string => {
  const from = stamp(since)
  const to = stamp(until)
  return `${from} to ${to.slice(0, 10) === from.slice(0, 10) ? to.slice(11) : to} UTC`
}

export const formatSwapSummary = (s: SwapSummary): string[] => {
  const header = `*Swaps* ${stampSpan(s.since, s.until)}`
  const lines: string[] = []
  for (const c of s.corridors) {
    const parts = [
      c.fulfilled > 0 ? `${c.fulfilled} fulfilled` : null,
      c.failed > 0 ? `${c.failed} failed` : null,
      c.unfunded > 0 ? `${c.unfunded} never funded` : null,
    ].filter((p) => p !== null)
    // A capped read with nothing counted is still partial: the unread rows may have finished.
    if (parts.length === 0 && !c.truncated) continue
    const window = c.since === s.since ? '' : ` (since ${stamp(c.since)})`
    const partial = c.truncated ? ' (partial: row cap reached)' : ''
    lines.push(`${c.corridor.replace('->', ' → ')}: ${parts.join(' · ') || 'none counted'}${window}${partial}`)
    if (c.failed === 0) continue
    const ranked = [...c.reasons].sort((a, b) => b[1] - a[1])
    const shown = ranked.slice(0, MAX_REASONS).map(([reason, n]) => `${n}× ${shorten(reason)}`)
    if (ranked.length > MAX_REASONS) shown.push(`+${ranked.length - MAX_REASONS} more`)
    lines.push(`  failed: ${shown.join(' · ')}`)
  }
  for (const u of s.unreadable) lines.push(`${u.corridor}: unreadable (${u.error}), retried next report`)
  if (s.unmeasured.length > 0) lines.push(`not counted (no ledger): ${s.unmeasured.join(', ')}`)
  return lines.length === 0 ? [`${header}: none finished`] : [header, ...lines]
}
