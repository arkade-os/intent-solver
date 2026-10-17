import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { registerStatusRoutes } from '@arkade-os/solver-app/admin/routes/status.js'
import type { AdminDeps } from '@arkade-os/solver-app/admin/server.js'
import { recordBalanceCheckpoint, withBalanceCheckpoints } from '@arkade-os/solver-app/ops/balanceCheckpoints.js'

const stores: AdminStore[] = []
const directories: string[] = []
const openStore = async (path = ':memory:') => {
  const store = await AdminStore.open(path)
  stores.push(store)
  return store
}
const fixture = async (path?: string) => {
  const arkade = { total: 1_000, assets: [{ assetId: 'aa'.repeat(34), amount: 10n ** 25n }] }
  const lightning = { availableSats: 2_000, incomingSats: 90_000 }
  const onchain = { confirmedSats: 3_000, unconfirmedSats: 400, sharedWithLightning: false }
  const services = {
    adminStore: await openStore(path),
    config: { network: 'regtest', lnBackend: 'lnd', arkade: { arkServerUrl: 'http://arkade.test' } },
    providerPubkey: 'provider',
    arkade: { wallet: { getBalance: vi.fn(async () => arkade) } },
    ln: { getBalance: vi.fn(async () => lightning) },
    onchain: { getBalance: vi.fn(async () => onchain) },
  } as unknown as Parameters<typeof recordBalanceCheckpoint>[0]
  return { services, arkade, lightning, onchain, sample: () => recordBalanceCheckpoint(services) }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true })
})

describe('balance checkpoints', () => {
  it('persists owned BTC and exact asset amounts, excluding inbound capacity', async () => {
    const f = await fixture()
    const checkpoint = await f.sample()
    expect(checkpoint.totalSats).toBe('6400')
    expect(checkpoint.arkade?.assets).toEqual({ [f.arkade.assets[0]!.assetId]: '10000000000000000000000000' })
    expect(checkpoint.previousId).toBeNull()
    expect(checkpoint.decreases).toEqual([])
    expect(await f.services.adminStore.listBalanceCheckpoints()).toEqual([checkpoint])
  })

  it('does not double count a shared Lightning/onchain pool', async () => {
    const f = await fixture()
    f.onchain.sharedWithLightning = true
    expect((await f.sample()).totalSats).toBe('4400')
    f.lightning.availableSats = 1
    expect((await f.sample()).decreases).toEqual([])
  })

  it('does not report internal BTC transfers or confirmations as losses', async () => {
    const f = await fixture()
    await f.sample()
    f.arkade.total -= 500
    f.lightning.availableSats += 500
    f.onchain.confirmedSats += 400
    f.onchain.unconfirmedSats = 0
    expect((await f.sample()).decreases).toEqual([])
  })

  it('reports net BTC decreases and assets disappearing without rounding', async () => {
    const f = await fixture()
    const baseline = await f.sample()
    f.arkade.total -= 12
    f.lightning.availableSats += 2
    f.arkade.assets = []
    const checkpoint = await f.sample()
    expect(checkpoint.previousId).toBe(baseline.id)
    expect(checkpoint.decreases).toEqual([
      { asset: 'BTC', before: '6400', after: '6390', decrease: '10' },
      {
        asset: `arkade:${'aa'.repeat(34)}`,
        before: '10000000000000000000000000',
        after: '0',
        decrease: '10000000000000000000000000',
      },
    ])
  })

  it('compares across a restart and incomplete readings against the last complete checkpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'solver-balance-checkpoints-'))
    directories.push(directory)
    const path = join(directory, 'admin.sqlite')
    const f = await fixture(path)
    const baseline = await f.sample()
    await f.services.adminStore.close()
    const restarted = await fixture(path)
    vi.mocked(restarted.services.ln!.getBalance).mockRejectedValueOnce(new Error('offline'))
    const incomplete = await restarted.sample()
    expect(incomplete.totalSats).toBeNull()
    expect(incomplete.lightningSats).toBeNull()
    expect(incomplete.errors).toEqual({ lightning: 'offline' })
    expect(incomplete.decreases).toEqual([])
    restarted.lightning.availableSats -= 5
    const recovered = await restarted.sample()
    expect(recovered.previousId).toBe(baseline.id)
    expect(recovered.decreases[0]?.decrease).toBe('5')
    expect((await restarted.services.adminStore.listBalanceCheckpoints()).map((row) => row.id)).toEqual([
      recovered.id,
      incomplete.id,
      baseline.id,
    ])
  })

  it('checks each asset independently even when BTC increases', async () => {
    const f = await fixture()
    await f.sample()
    f.arkade.total += 1_000
    f.arkade.assets[0]!.amount -= 1n
    const checkpoint = await f.sample()
    expect(checkpoint.decreases).toEqual([
      {
        asset: `arkade:${f.arkade.assets[0]!.assetId}`,
        before: '10000000000000000000000000',
        after: '9999999999999999999999999',
        decrease: '1',
      },
    ])
  })

  it('keeps providers and backends in separate baselines', async () => {
    const f = await fixture()
    await f.sample()
    f.arkade.total = 0
    f.services.providerPubkey = 'other-provider'
    expect((await f.sample()).previousId).toBeNull()
    f.services.config.lnBackend = 'fake'
    expect((await f.sample()).previousId).toBeNull()
  })

  it('supports deployments without a BTC rail', async () => {
    const f = await fixture()
    f.services.ln = null
    f.services.onchain = null
    expect((await f.sample()).totalSats).toBe('1000')
  })

  it.each([NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid sats: %s', async (value) => {
    const f = await fixture()
    f.arkade.total = value
    const checkpoint = await f.sample()
    expect(checkpoint.totalSats).toBeNull()
    expect(checkpoint.errors.arkade).toContain('safe integer')
  })

  it('bounds a backend read that never answers', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    vi.mocked(f.services.ln!.getBalance).mockImplementationOnce(() => new Promise(() => {}))
    const pending = f.sample()
    await vi.advanceTimersByTimeAsync(10_000)
    const checkpoint = await pending
    expect(checkpoint.totalSats).toBeNull()
    expect(checkpoint.errors.lightning).toContain('no answer within')
  })

  it('joins a timed-out backend read until it finishes instead of starting another', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    let release!: (balance: typeof f.lightning) => void
    vi.mocked(f.services.ln!.getBalance).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const first = f.sample()
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await first).totalSats).toBeNull()
    const second = f.sample()
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await second).totalSats).toBeNull()
    expect(f.services.ln!.getBalance).toHaveBeenCalledTimes(1)
    release(f.lightning)
    await vi.advanceTimersByTimeAsync(0)
    expect((await f.sample()).totalSats).toBe('6400')
    expect(f.services.ln!.getBalance).toHaveBeenCalledTimes(2)
  })

  it('serves bounded checkpoint history without reading wallets', async () => {
    const f = await fixture()
    const checkpoint = await f.sample()
    const app = new Hono()
    registerStatusRoutes(app, { services: f.services } as AdminDeps)
    expect(await (await app.request('/api/balance-checkpoints?limit=1')).json()).toEqual({ checkpoints: [checkpoint] })
    for (const limit of ['0', '201', '-1', '1.5', '1e2', '']) {
      expect((await app.request(`/api/balance-checkpoints?limit=${limit}`)).status).toBe(400)
    }
    expect(f.services.arkade.wallet.getBalance).toHaveBeenCalledTimes(1)
  })
})

describe('scheduled balance checkpoints', () => {
  it('samples at startup and every minute, logs possible losses, and stops on abort', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const controller = new AbortController()
    const log = vi.fn()
    let finish!: () => void
    const run = withBalanceCheckpoints({
      checkpoint: f.sample,
      log,
      signal: controller.signal,
      run: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await f.services.adminStore.listBalanceCheckpoints()).toHaveLength(1)
    f.arkade.total -= 10
    await vi.advanceTimersByTimeAsync(60_000)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('POSSIBLE LOSS'))
    controller.abort()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await f.services.adminStore.listBalanceCheckpoints()).toHaveLength(2)
    finish()
    await run
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains errors, avoids overlapping samples, and drains before shutdown', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const log = vi.fn()
    let reject!: (error: Error) => void
    let finish!: () => void
    const checkpoint = vi.fn(
      () =>
        new Promise<never>((_, fail) => {
          reject = fail
        }),
    )
    const running = withBalanceCheckpoints({
      checkpoint,
      log,
      signal: controller.signal,
      run: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    finish()
    let done = false
    void running.then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    reject(new Error('database unavailable'))
    await running
    expect(log).toHaveBeenCalledWith('balance checkpoint failed: database unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })
})
