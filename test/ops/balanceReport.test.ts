import { describe, it, expect, vi } from 'vitest'
import {
  createBalanceReportReader,
  formatBalanceReport,
  type BalanceReportInput,
} from '@arkade-os/solver-app/ops/balanceReport.js'
import type { FundBalance, FundSource } from '@arkade-os/solver-app/ops/fundSources.js'
import type { SwapSummary } from '@arkade-os/solver-app/ops/swapSummary.js'

const source = (label: string, readBalance: () => Promise<FundBalance>): FundSource => ({
  id: label,
  label,
  unit: 'sats',
  readBalance,
})

const sats = (...figures: Array<[string, string | null, string?]>): FundBalance => ({
  unit: 'sats',
  figures: figures.map(([label, amount, note]) => ({ label, amount, ...(note === undefined ? {} : { note }) })),
})

const read = (overrides: Partial<BalanceReportInput> = {}, reader = createBalanceReportReader()) =>
  reader({
    network: 'mutinynet',
    sources: [
      source('arkade float', async () =>
        sats(['available', '1234567', 'What can fund a swap now.'], ['total', '1300000']),
      ),
    ],
    readAssets: async () => [],
    readCommittedSats: async () => 150_000,
    ...overrides,
  })

describe('balance report', () => {
  it('lists every source, its figures, the assets and the committed total', async () => {
    const text = formatBalanceReport(
      await read({
        sources: [
          source('arkade float', async () => sats(['available', '1234567'], ['total', '1300000'])),
          source('BTC rail', async () => sats(['channel out', '2000000'], ['onchain confirmed', '300000'])),
        ],
        readAssets: async () => [
          { assetId: 'a'.repeat(64), shortId: 'aaaaaaaa…aaaa', amount: '1250000000', ticker: 'USDA' },
          { assetId: 'b'.repeat(64), shortId: 'bbbbbbbb…bbbb', amount: '42' },
        ],
      }),
    )
    expect(text).toBe(
      [
        'Balance report — mutinynet',
        'arkade float (sats): available 1,234,567 · total 1,300,000',
        'BTC rail (sats): channel out 2,000,000 · onchain confirmed 300,000',
        'arkade assets (base units): USDA 1250000000 · bbbbbbbb…bbbb 42',
        'committed to live swaps: 150,000 sats',
      ].join('\n'),
    )
  })

  it('reports a source that failed to read, and still reports the rest', async () => {
    const text = formatBalanceReport(
      await read({
        sources: [
          source('BTC rail', async () => {
            throw new Error('node unreachable')
          }),
          source('arkade float', async () => sats(['available', '5'])),
        ],
        readAssets: async () => {
          throw new Error('indexer down')
        },
      }),
    )
    expect(text).toContain('BTC rail: unreadable (node unreachable)')
    expect(text).toContain('arkade float (sats): available 5')
    expect(text).toContain('arkade assets: unreadable (indexer down)')
  })

  // A backend that keeps ONE pool says so with a null-amount figure; that is a caveat, not a zero or a failure.
  it('renders a figure without an amount as its note, never as 0', async () => {
    const text = formatBalanceReport(
      await read({
        sources: [
          source('BTC rail', async () =>
            sats(
              ['channel out', '700'],
              ['channel in', null, 'lnd timed out'],
              ['pools', null, 'ONE pool.'],
              ['x', null],
            ),
          ),
        ],
      }),
    )
    expect(text).toContain(
      'BTC rail (sats): channel out 700 · channel in: lnd timed out · pools: ONE pool. · x: unread',
    )
  })

  // A hung read would otherwise hold the report forever, and every later one behind it.
  it('reports a source that never answers as timed out, and still sends the rest', async () => {
    const text = formatBalanceReport(
      await read({
        sources: [
          source('BTC rail', () => new Promise(() => {})),
          source('arkade float', async () => sats(['available', '5'])),
        ],
        readCommittedSats: () => new Promise(() => {}),
        deadlineMs: 10,
      }),
    )
    expect(text).toContain('BTC rail: unreadable (no answer within 10ms)')
    expect(text).toContain('arkade float (sats): available 5')
    expect(text).toContain('committed to live swaps: unreadable (no answer within 10ms)')
  })

  it('joins a read still running from an earlier report instead of starting another', async () => {
    const reader = createBalanceReportReader()
    const hung = vi.fn(() => new Promise<FundBalance>(() => {}))
    const healthy = vi.fn(async () => sats(['available', '5']))
    const overrides = { sources: [source('BTC rail', hung), source('arkade float', healthy)], deadlineMs: 10 }

    const first = formatBalanceReport(await read(overrides, reader))
    const second = formatBalanceReport(await read(overrides, reader))

    expect(second).toBe(first)
    expect(hung).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalledTimes(2)
  })

  it('leaves a non-sats amount exactly as the source wrote it', async () => {
    const big = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    const text = formatBalanceReport(
      await read({
        sources: [source('usdc', async () => ({ unit: 'USDC', figures: [{ label: 'held', amount: big }] }))],
      }),
    )
    expect(text).toContain(`usdc (USDC): held ${big}`)
  })

  it('omits the assets line when the float holds none', async () => {
    expect(formatBalanceReport(await read())).not.toContain('assets')
  })

  const summary = (over: Partial<SwapSummary> = {}): SwapSummary => ({
    since: 1_760_421_600,
    until: 1_760_443_200,
    corridors: [],
    unreadable: [],
    unmeasured: [],
    ...over,
  })

  it('appends the swap summary after the balances, and only when asked for one', async () => {
    expect(formatBalanceReport(await read())).not.toContain('Swaps')
    const text = formatBalanceReport(await read({ readSwaps: async () => summary() }))
    expect(text.split('\n').at(-1)).toBe('Swaps 2025-10-14 06:00 to 12:00 UTC: none finished')
  })

  it('reports a summary that could not be read without losing the balances', async () => {
    const text = formatBalanceReport(
      await read({
        readSwaps: async () => {
          throw new Error('db locked')
        },
      }),
    )
    expect(text).toContain('arkade float (sats): available 1,234,567')
    expect(text).toContain('swaps: unreadable (db locked)')
  })

  // Telegram refuses a message over 4096 characters, which would drop the whole report.
  it('caps the message below the Telegram limit and says it was cut', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      corridor: `corridor-${i}-${'x'.repeat(30)}`,
      since: 1_760_421_600,
      fulfilled: 1,
      failed: 0,
      unfunded: 0,
      reasons: new Map<string, number>(),
      truncated: false,
    }))
    const text = formatBalanceReport(await read({ readSwaps: async () => summary({ corridors: many }) }))
    expect(text.length).toBeLessThanOrEqual(4000)
    expect(text.endsWith('… (message cut at 4000 characters)')).toBe(true)
  })
})
