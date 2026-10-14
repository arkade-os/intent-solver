import { describe, it, expect } from 'vitest'
import { formatSwapSummary, readSwapSummary } from '@arkade-os/solver-app/ops/swapSummary.js'
import type { SwapEconomics } from '@arkade-os/solver-core/analytics/economics.js'

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

const reader = (pair: string, records: SwapEconomics[] | Error, truncated = false) => ({
  descriptor: { pair },
  economics: async () => {
    if (records instanceof Error) throw records
    return { corridor: pair, records, truncated }
  },
})

const WINDOW = { since: 1_760_421_600, until: 1_760_443_200 }

describe('swap summary', () => {
  it('counts fulfilled, funded failures and never-funded quotes per corridor, with reasons', async () => {
    const summary = await readSwapSummary(
      [
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
      ],
      WINDOW,
    )
    expect(formatSwapSummary(summary)).toEqual([
      'Swaps 2025-10-14 06:00 to 12:00 UTC',
      'arkade:BTC->lightning:BTC: 2 fulfilled · 3 failed · 1 never funded',
      '  failed: 2× no route · 1× stuck',
    ])
  })

  it('says so when nothing finished', async () => {
    const summary = await readSwapSummary([reader('a', [record('open')])], WINDOW)
    expect(formatSwapSummary(summary)).toEqual(['Swaps 2025-10-14 06:00 to 12:00 UTC: none finished'])
  })

  it('names a corridor it could not read or measure instead of counting it as zero', async () => {
    const summary = await readSwapSummary(
      [reader('a', new Error('db locked')), { descriptor: { pair: 'b' } }, reader('c', [record('done')], true)],
      WINDOW,
    )
    expect(formatSwapSummary(summary)).toEqual([
      'Swaps 2025-10-14 06:00 to 12:00 UTC',
      'c: 1 fulfilled (partial: row cap reached)',
      'a: unreadable (db locked)',
      'not counted (no ledger): b',
    ])
  })

  it('lists at most five reasons, longest-first by count, and shortens a long one', async () => {
    const reasons = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].flatMap((r, i) =>
      Array.from({ length: 7 - i }, () => record('failed', { failureReason: r })),
    )
    const long = record('failed', { failureReason: 'x'.repeat(200) })
    const [, , line] = formatSwapSummary(await readSwapSummary([reader('p', [...reasons, long])], WINDOW))
    expect(line).toBe('  failed: 7× a · 6× b · 5× c · 4× d · 3× e · +3 more')
    const [, , only] = formatSwapSummary(await readSwapSummary([reader('p', [long])], WINDOW))
    expect(only).toBe(`  failed: 1× ${'x'.repeat(79)}…`)
  })
})
