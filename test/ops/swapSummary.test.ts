import { describe, it, expect, vi } from 'vitest'
import {
  createSwapSummaryReader,
  formatSwapSummary,
  type SummaryReader,
} from '@arkade-os/solver-app/ops/swapSummary.js'
import type { LedgerWindow, SwapEconomics } from '@arkade-os/solver-core/analytics/economics.js'

const leg = (amount: string | null) => ({ assetId: null, amount, decimals: 8 })

const record = (phase: SwapEconomics['phase'], over: Partial<SwapEconomics> = {}): SwapEconomics =>
  ({
    id: 'x',
    corridor: 'arkade:BTC->lightning:BTC',
    state: phase === 'done' ? 'claimed' : 'refused',
    phase,
    failureReason: null,
    inbound: leg('1000'),
    outbound: leg('990'),
    ...over,
  }) as SwapEconomics

const reader = (pair: string, records: SwapEconomics[] | Error, truncated = false): SummaryReader => ({
  descriptor: { pair },
  economics: async () => {
    if (records instanceof Error) throw records
    return { corridor: pair, records, truncated }
  },
})

const SINCE = 1_760_421_600
const UNTIL = 1_760_443_200

const summarise = (readers: SummaryReader[], deadlineMs?: number) =>
  createSwapSummaryReader({ now: () => UNTIL, firstSince: SINCE, deadlineMs })(readers)

describe('swap summary', () => {
  it('counts fulfilled, funded failures and never-funded quotes per corridor, with reasons', async () => {
    const summary = await summarise([
      reader('arkade:BTC->lightning:BTC', [
        record('done'),
        record('done'),
        record('failed', { failureReason: 'no route' }),
        record('failed', { failureReason: 'no route' }),
        record('failed', { state: 'stuck', failureReason: null }),
        record('failed', { inbound: leg(null), failureReason: 'lockup timeout' }),
        record('open', { state: 'funded' }),
      ]),
      reader('lightning:BTC->arkade:BTC', []),
    ])
    expect(formatSwapSummary(summary)).toEqual([
      'Swaps 2025-10-14 06:00 to 12:00 UTC',
      'arkade:BTC->lightning:BTC: 2 fulfilled · 3 failed · 1 never funded',
      '  failed: 2× no route · 1× stuck',
    ])
  })

  it('says so when nothing finished', async () => {
    expect(formatSwapSummary(await summarise([reader('a', [record('open')])]))).toEqual([
      'Swaps 2025-10-14 06:00 to 12:00 UTC: none finished',
    ])
  })

  it('names a corridor it could not read or measure instead of counting it as zero', async () => {
    const summary = await summarise([
      reader('a', new Error('db locked')),
      { descriptor: { pair: 'b' } },
      reader('c', [record('done')], true),
    ])
    expect(formatSwapSummary(summary)).toEqual([
      'Swaps 2025-10-14 06:00 to 12:00 UTC',
      'c: 1 fulfilled (partial: row cap reached)',
      'a: unreadable (db locked), retried next report',
      'not counted (no ledger): b',
    ])
  })

  it('flags a capped read as partial even when nothing in it was counted', async () => {
    const [, line] = formatSwapSummary(await summarise([reader('c', [record('open')], true)]))
    expect(line).toBe('c: none counted (partial: row cap reached)')
  })

  it('reads corridors concurrently, so one that never answers does not blank the rest', async () => {
    const hung: SummaryReader = { descriptor: { pair: 'hung' }, economics: () => new Promise(() => {}) }
    const summary = await summarise([hung, reader('ok', [record('done')])], 10)
    expect(formatSwapSummary(summary)).toEqual([
      'Swaps 2025-10-14 06:00 to 12:00 UTC',
      'ok: 1 fulfilled',
      'hung: unreadable (no answer within 10ms), retried next report',
    ])
  })

  it('advances a corridor window only after a read answered, so a failure is late rather than lost', async () => {
    let now = UNTIL
    const failing = { calls: 0 }
    const windows: Record<string, LedgerWindow[]> = { ok: [], flaky: [] }
    const recording = (pair: string, fail: () => boolean): SummaryReader => ({
      descriptor: { pair },
      economics: async (window) => {
        windows[pair]!.push(window)
        if (fail()) throw new Error('db locked')
        return { corridor: pair, records: [record('done')], truncated: false }
      },
    })
    const readers = [recording('ok', () => false), recording('flaky', () => failing.calls++ === 0)]
    const read = createSwapSummaryReader({ now: () => now, firstSince: SINCE })

    await read(readers)
    now = UNTIL + 3600
    const second = await read(readers)

    expect(windows.ok!.map((w) => w.since)).toEqual([SINCE, UNTIL])
    expect(windows.flaky!.map((w) => w.since)).toEqual([SINCE, SINCE])
    expect(formatSwapSummary(second)).toEqual([
      'Swaps 2025-10-14 06:00 to 13:00 UTC',
      'ok: 1 fulfilled (since 2025-10-14 12:00)',
      'flaky: 1 fulfilled',
    ])
  })

  it('lists at most five reasons, most frequent first, and shortens a long one on code points', async () => {
    const reasons = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].flatMap((r, i) =>
      Array.from({ length: 7 - i }, () => record('failed', { failureReason: r })),
    )
    const [, , line] = formatSwapSummary(await summarise([reader('p', reasons)]))
    expect(line).toBe('  failed: 7× a · 6× b · 5× c · 4× d · 3× e · +2 more')
    const emoji = '🙂'.repeat(100)
    const [, , only] = formatSwapSummary(await summarise([reader('p', [record('failed', { failureReason: emoji })])]))
    expect(only).toBe(`  failed: 1× ${'🙂'.repeat(79)}…`)
  })

  it('does not start a second read for a corridor whose previous one is still running', async () => {
    const economics = vi.fn(() => new Promise<never>(() => {}))
    const read = createSwapSummaryReader({ now: () => UNTIL, firstSince: SINCE, deadlineMs: 10 })
    await read([{ descriptor: { pair: 'hung' }, economics }])
    await read([{ descriptor: { pair: 'hung' }, economics }])
    expect(economics).toHaveBeenCalledTimes(1)
  })
})
