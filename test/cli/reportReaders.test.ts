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
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { servicesBodyOf } from '../support/createServicesBody.js'
import { loadConfig } from '@arkade-os/solver-app/config.js'
import { openReportReaders } from '@arkade-os/solver-app/ops/services.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'

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

/** A real `Config` and a real file, against the header's advice: no source
 * substring reaches what the CLI can SEE, nor what it writes on the way. */
describe('openReportReaders — a live row on a market nothing serves', () => {
  const USDA = '1a'.repeat(34)
  const PAIR = `arkade:BTC->arkade:${USDA}`
  const RFQ_ID = 'a'.repeat(64)
  const ENV = ['SWAP_NETWORK', 'ARK_MNEMONIC', 'ARK_SERVER_URL', 'EMULATOR_URL', 'LN_BACKEND', 'SWAP_DB_PATH']

  let saved: Record<string, string | undefined> = {}
  let dir: string
  let swapDbPath: string

  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]))
    dir = mkdtempSync(join(tmpdir(), 'report-readers-'))
    swapDbPath = join(dir, 'swaps.sqlite')
    Object.assign(process.env, {
      SWAP_NETWORK: 'regtest',
      ARK_MNEMONIC: 'test mnemonic, never a real one',
      ARK_SERVER_URL: 'http://localhost:7070',
      EMULATOR_URL: 'http://localhost:7073',
      LN_BACKEND: 'fake',
      SWAP_DB_PATH: swapDbPath,
    })
  })

  afterEach(() => {
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const writeLiveRow = async (): Promise<void> => {
    const store = await AssetRfqSwapStore.open(swapDbPath, () => 1_000)
    await store.insertQuote({
      id: 'swap-1',
      rfqId: RFQ_ID,
      pair: PAIR,
      fromAssetId: null,
      fromAmount: 100_000_000n,
      toAssetId: USDA,
      toAmount: 99_500_000n,
      makerPkScript: `5120${'c'.repeat(64)}`,
      makerPublicKey: 'b'.repeat(64),
      offerPkScript: `5120${'d'.repeat(64)}`,
      offerAddress: 'ark1qoffer',
      solverPubkey: 'e'.repeat(64),
      validUntil: 2_000,
    })
    await store.close()
  }

  const tables = async (): Promise<string[]> => {
    const driver = betterSqliteDriver(swapDbPath)
    try {
      const rows = await driver.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      return rows.map((row) => row.name)
    } finally {
      await driver.close()
    }
  }

  it('reads the pair back, though no console row names it', async () => {
    await writeLiveRow()
    const { readers, close } = await openReportReaders(loadConfig())
    try {
      expect(readers.get(PAIR)).toBeDefined()
      expect(await readers.get(PAIR)!.statusFor(RFQ_ID)).not.toBeNull()
    } finally {
      await close()
    }
  })

  it('reports its committed capital, which is the number `pnl` exists to print', async () => {
    await writeLiveRow()
    const { readers, close } = await openReportReaders(loadConfig())
    try {
      const ledger = await readers.get(PAIR)!.economics!({ since: 0, until: 10_000, limit: 10 })
      expect(ledger.records).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('creates no asset RFQ table on a deployment that never served one', async () => {
    const { close } = await openReportReaders(loadConfig())
    await close()
    expect(await tables()).toContain('send_swap')
    expect(await tables()).not.toContain('asset_rfq_swap')
  })
})
