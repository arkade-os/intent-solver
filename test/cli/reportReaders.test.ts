/**
 * How `openReportReaders` opens and closes, asserted against the source text for
 * the reason `evmServices.test.ts` gives about its neighbour: the function takes
 * a whole `Config`, and building a valid one is a fixture larger than the
 * behaviour under test.
 *
 * SCOPED to the declaration, never the whole file — a whole-file substring is
 * satisfied by `createServices` further down, which already has every one of
 * these properties, and would go green while this one had none of them.
 */
import { describe, it, expect } from 'vitest'
import { servicesBodyOf } from '../support/createServicesBody.js'

const body = () => servicesBodyOf('openReportReaders')

describe('openReportReaders — no rail, no network', () => {
  it('opens stores only', () => {
    const source = body()
    for (const live of ['createLightningRail', 'createArkadeContext', 'RestEmulatorProvider', 'getInfo']) {
      expect(source).not.toContain(live)
    }
  })

  it('builds READERS, which cannot quote or move money', () => {
    expect(body()).toContain('readerSetFromDeps')
    expect(body()).not.toContain('corridorSetFromDeps')
  })
})

describe('openReportReaders — an asset market that stopped serving', () => {
  it('opens the store when the table exists, not only when something serves', () => {
    expect(body()).toContain('assetRfqMarkets.length > 0 || (await assetRfqTableExists(swapFile))')
  })

  it('probes rather than opening blind, so a reporting command creates no table', () => {
    const source = body()
    const probe = source.indexOf('assetRfqTableExists(swapFile)')
    const open = source.indexOf("track('assetRfqStore', await AssetRfqSwapStore.open(swapFile))")
    // `indexOf` answers -1 for an absent needle, which would satisfy `<` on its own.
    expect(probe).toBeGreaterThan(-1)
    expect(open).toBeGreaterThan(-1)
    expect(probe).toBeLessThan(open)
  })

  it('hands the recovered markets to the reader set', () => {
    expect(body()).toContain('readableAssetRfqMarketsFrom(assetRfqMarkets, await assetRfqStore.listNonTerminal())')
    expect(body()).toContain('readableAssetRfqMarkets,')
  })
})

describe('openReportReaders — partial open', () => {
  /**
   * `ReceiveSwapStore.open` and `assetRfqMarketsFrom` both throw on inputs an
   * operator can really have, and seven stores plus a driver are open by then.
   */
  it('closes what already opened when a later open throws', () => {
    const source = body()
    expect(source).toMatch(/try\s*\{/)
    expect(source).toMatch(/catch \(error\) \{\s*await close\(\)\s*throw error/)
  })

  it('tracks every store as it opens, so none is missed by that cleanup', () => {
    const source = body()
    // Each `await X.open(...)` must be wrapped, or it leaks on the next throw.
    // One `track(` call site per open — the declaration reads `track = <T`, so
    // it is not counted here.
    const opens = source.match(/await \w+Store\.open\(/g) ?? []
    expect(opens.length).toBeGreaterThan(0)
    expect(source.match(/track\(/g) ?? []).toHaveLength(opens.length)
  })
})

describe('openReportReaders — close', () => {
  /**
   * The bug this pins: a bare `await closeable?.close()` loop. One throwing
   * close skipped the other seven AND replaced any real error on its way out of
   * the CLI's `finally`, reporting a genuine `economics()` failure as a close
   * failure.
   */
  it('isolates each step rather than letting one failure end the loop', () => {
    const source = body()
    expect(source).toMatch(/for \(const \[name, store\] of[\s\S]*?try \{[\s\S]*?await store\.close\(\)[\s\S]*?catch/)
    expect(source).toContain('close(${name}) failed:')
  })

  it('does not mutate the tracked list while closing', () => {
    // `opened.reverse()` in place would leave a second close() iterating a list
    // it had already flipped.
    expect(body()).toContain('[...opened].reverse()')
  })
})
