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

export interface SummaryReader {
  readonly descriptor: { readonly pair: string }
  economics?(window: LedgerWindow): Promise<CorridorLedger>
}

interface CorridorCount {
  corridor: string
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

const count = (ledger: CorridorLedger): CorridorCount => {
  const c: CorridorCount = {
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
      const reason = r.failureReason ?? r.state
      c.reasons.set(reason, (c.reasons.get(reason) ?? 0) + 1)
    }
  }
  return c
}

export const readSwapSummary = async (
  readers: Iterable<SummaryReader>,
  window: { since: number; until: number },
): Promise<SwapSummary> => {
  const summary: SwapSummary = { ...window, corridors: [], unreadable: [], unmeasured: [] }
  const ledgerWindow = { ...window, limit: DEFAULT_LEDGER_LIMIT }
  for (const reader of readers) {
    const corridor = reader.descriptor.pair
    if (!reader.economics) {
      summary.unmeasured.push(corridor)
      continue
    }
    try {
      summary.corridors.push(count(await reader.economics(ledgerWindow)))
    } catch (error) {
      summary.unreadable.push({ corridor, error: messageOf(error) })
    }
  }
  return summary
}

const shorten = (text: string): string =>
  text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text

const stamp = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')

export const formatSwapSummary = (s: SwapSummary): string[] => {
  const from = stamp(s.since)
  const to = stamp(s.until)
  const header = `Swaps ${from} to ${to.slice(0, 10) === from.slice(0, 10) ? to.slice(11) : to} UTC`
  const lines: string[] = []
  for (const c of s.corridors) {
    const parts = [
      c.fulfilled > 0 ? `${c.fulfilled} fulfilled` : null,
      c.failed > 0 ? `${c.failed} failed` : null,
      c.unfunded > 0 ? `${c.unfunded} never funded` : null,
    ].filter((p) => p !== null)
    if (parts.length === 0) continue
    lines.push(`${c.corridor}: ${parts.join(' · ')}${c.truncated ? ' (partial: row cap reached)' : ''}`)
    if (c.failed === 0) continue
    const ranked = [...c.reasons].sort((a, b) => b[1] - a[1])
    const shown = ranked.slice(0, MAX_REASONS).map(([reason, n]) => `${n}× ${shorten(reason)}`)
    if (ranked.length > MAX_REASONS) shown.push(`+${ranked.length - MAX_REASONS} more`)
    lines.push(`  failed: ${shown.join(' · ')}`)
  }
  for (const u of s.unreadable) lines.push(`${u.corridor}: unreadable (${u.error})`)
  if (s.unmeasured.length > 0) lines.push(`not counted (no ledger): ${s.unmeasured.join(', ')}`)
  return lines.length === 0 ? [`${header}: none finished`] : [header, ...lines]
}
