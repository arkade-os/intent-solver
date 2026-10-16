import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withEvmSendSweep } from '@arkade-os/solver-app/ops/evmSendSweep.js'
import { createDirectFillRecovery } from '@arkade-os/solver-app/ops/directFillRecovery.js'
import { DirectFillAttempts } from '@arkade-os/solver-arkade/arkade/directFillAttempts.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import { sqliteExecutor } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { startCadence } from '@arkade-os/solver-app/ops/cadence.js'

const source = ts.createSourceFile(
  'cli.ts',
  readFileSync(new URL('../../packages/solver-app/src/cli.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
)
const declarations = new Set([
  'HOT_TICK_MS',
  'WATCH_SYNC_MS',
  'FULL_SWEEP_MS',
  'REFUND_SWEEP_MS',
  'VTXO_LIFECYCLE_MS',
  'watchUntilStopped',
  'watchSwaps',
])
const compiled = ts.transpileModule(
  source.statements
    .filter(
      (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((declaration) => declarations.has(declaration.name.getText(source))),
    )
    .map((node) => node.getText(source))
    .join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => vi.useRealTimers())

const watchLoopIn = (signals: EventEmitter, overrides: Record<string, unknown> = {}) =>
  runInNewContext(`${compiled}; watchUntilStopped`, {
    process: signals,
    withEvmSendSweep,
    startCadence,
    assetRfqPairFor: (from: string | null, to: string | null) => `${from}->${to}`,
    log: () => {},
    CORRIDORS: [],
    Date,
    AbortController,
    LockupWatcher: class {
      start() {}
      sync() {}
      async stop() {}
    },
    lazyContractSource: () => ({}),
    lockupSource: () => ({}),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    runContractLifecycle: async () => {},
    runFloatLifecycle: async () => ({ failures: [] }),
    maybeMintPool: async () => ({ minted: false, skipped: 'disabled' }),
    ...overrides,
  }) as (services: unknown) => Promise<void>

describe('the watch loop during slow wallet maintenance', () => {
  it.each(['contract', 'float'])('drives EVM sends while %s maintenance is unresolved', async (stage) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const blocked = deferred()
    const signals = new EventEmitter()
    const maintenance = vi.fn(() => blocked.promise)
    let funded = false
    const progressed = vi.fn()
    const customCorridorTick = vi.fn(async () => 0)
    const tickAll = vi.fn(async () => {
      if (funded) progressed()
      return []
    })
    const services = {
      config: { corridorEnabled: {}, contractRetentionMs: 0, poolAutoMint: false },
      policy: { evmCorridors: [{ enabled: true, direction: 'send' }] },
      arkade: { wallet: { getContractManager: async () => ({}) } },
      readers: [],
      evmSendService: { tickAll },
      corridors: [
        {
          descriptor: { pair: 'custom:asset->custom:btc', envStem: 'ASSET_CUSTOM' },
          tickAll: customCorridorTick,
          findRecoverable: async () => [],
        },
      ],
      assetRfqService: { tickAll: async () => [], stop: async () => {} },
      assetRfqMarkets: [],
    }
    const watch = watchLoopIn(signals, {
      runContractLifecycle: stage === 'contract' ? maintenance : async () => {},
      runFloatLifecycle: async () => {
        if (stage === 'float') await maintenance()
        return { failures: [] }
      },
    })
    const watching = watch(services)
    try {
      await vi.advanceTimersByTimeAsync(250)
      expect(maintenance).toHaveBeenCalledOnce()
      expect(customCorridorTick).toHaveBeenCalled()
      funded = true
      await vi.advanceTimersByTimeAsync(3000)
      expect(progressed).toHaveBeenCalled()
    } finally {
      signals.emit('SIGTERM')
      blocked.resolve()
      // The loop idles in `sleep(HOT_TICK_MS)` rather than inside the blocked
      // pass, so it needs one tick to see the abort and drain its cadences.
      await vi.advanceTimersByTimeAsync(250)
      await watching
    }
  })
})

/**
 * In production a lifecycle pass takes 55-70s and a refund sweep ~10s. Inline,
 * that stopped the hot tick and the sweep for exactly as long.
 */
describe('the hot loop during a slow refund sweep or lifecycle pass', () => {
  const harness = (overrides: Record<string, unknown> = {}, corridor: Record<string, unknown> = {}) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const signals = new EventEmitter()
    const tickHot = vi.fn(async () => {})
    const tickAll = vi.fn(async () => 0)
    const services = {
      config: { corridorEnabled: {}, contractRetentionMs: 0, poolAutoMint: false },
      policy: {},
      arkade: { wallet: { getContractManager: async () => ({}) } },
      readers: [],
      evmSendService: null,
      service: { tickHot },
      corridors: [
        {
          descriptor: { pair: 'lightning:BTC->arkade:BTC', envStem: 'LN' },
          tickAll,
          findRecoverable: async () => [],
          ...corridor,
        },
      ],
      assetRfqService: { tickAll: async () => [], stop: async () => {} },
      assetRfqMarkets: [],
    }
    return { signals, services, tickHot, tickAll, watch: watchLoopIn(signals, overrides) }
  }

  it('keeps ticking and sweeping while a float lifecycle pass never resolves', async () => {
    const blocked = deferred()
    const pass = vi.fn(() => blocked.promise)
    const { signals, services, tickHot, tickAll, watch } = harness({
      runFloatLifecycle: async () => {
        await pass()
        return { failures: [] }
      },
    })
    const watching = watch(services)
    try {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(pass).toHaveBeenCalledOnce()
      expect(tickHot.mock.calls.length).toBeGreaterThan(30)
      expect(tickAll.mock.calls.length).toBeGreaterThan(2)
    } finally {
      signals.emit('SIGTERM')
      blocked.resolve()
      await vi.advanceTimersByTimeAsync(250)
      await watching
    }
  })

  it('keeps ticking and sweeping while a corridor refund sweep never resolves', async () => {
    const blocked = deferred()
    const refundSweep = vi.fn(async () => {
      await blocked.promise
      return []
    })
    const { signals, services, tickHot, tickAll, watch } = harness({}, { refundSweep })
    const watching = watch(services)
    try {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(refundSweep).toHaveBeenCalledOnce()
      expect(tickHot.mock.calls.length).toBeGreaterThan(30)
      expect(tickAll.mock.calls.length).toBeGreaterThan(2)
    } finally {
      signals.emit('SIGTERM')
      blocked.resolve()
      await vi.advanceTimersByTimeAsync(250)
      await watching
    }
  })

  it('drains a pass in flight before rejecting, when the loop itself throws', async () => {
    const blocked = deferred()
    const { services, tickHot, watch } = harness({
      runFloatLifecycle: async () => {
        await blocked.promise
        return { failures: [] }
      },
    })
    tickHot.mockRejectedValueOnce(new Error('backend gone'))
    let settled = false
    const watching = watch(services).then(
      () => (settled = true),
      (error: unknown) => ((settled = true), error),
    )
    await vi.advanceTimersByTimeAsync(2_000)
    expect(settled).toBe(false)
    blocked.resolve()
    expect(String(await watching)).toContain('backend gone')
  })

  it('rejects with the loop’s own error when teardown fails too', async () => {
    const { services, tickHot, watch } = harness({
      LockupWatcher: class {
        start() {}
        sync() {}
        async stop() {
          throw new Error('unsubscribe failed')
        }
      },
    })
    tickHot.mockRejectedValueOnce(new Error('backend gone'))
    const outcome = watch(services).then(
      () => 'resolved',
      (error: unknown) => String(error),
    )
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await outcome).toContain('backend gone')
  })

  // Unguarded inline, a throwing refund sweep ended the whole watch loop.
  it('keeps the loop alive when a refund sweep throws', async () => {
    const refundSweep = vi.fn(async () => {
      throw new Error('store unavailable')
    })
    const { signals, services, tickHot, watch } = harness({}, { refundSweep })
    const watching = watch(services)
    try {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(refundSweep).toHaveBeenCalled()
      expect(tickHot.mock.calls.length).toBeGreaterThan(30)
    } finally {
      signals.emit('SIGTERM')
      await vi.advanceTimersByTimeAsync(250)
      await watching
    }
  })
})

describe('disabling the EVM send corridor', () => {
  it('logs a routine journal-list failure, keeps holds, and retries without stopping other watchers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const db = sqliteExecutor(':memory:')
    const pins = createReservationLedger()
    const script = `5120${'11'.repeat(32)}`
    const attempts = await DirectFillAttempts.open(db, pins, 'wallet', script)
    await attempts.prepare({
      parent: { kind: 'offer', id: 'active' },
      deposit: { txid: '22'.repeat(32), vout: 0 },
      funding: [{ txid: '33'.repeat(32), vout: 1, value: 5000, script, assets: [] }],
      offerPkScript: script,
      proceedsScript: script,
    })
    const list = vi.spyOn(attempts, 'list').mockRejectedValueOnce(new Error('SQLite temporarily unavailable'))
    const signals = new EventEmitter()
    const log = vi.fn()
    const watcherStart = vi.fn()
    const tickAll = vi.fn(async () => 0)
    const services = {
      config: { corridorEnabled: {}, contractRetentionMs: 0, poolAutoMint: false },
      policy: { evmCorridors: [] },
      arkade: { wallet: { getContractManager: async () => ({}) } },
      readers: [],
      corridors: [{ descriptor: { pair: 'other' }, tickAll, findRecoverable: async () => [] }],
      assetRfqMarkets: [],
      assetRfqService: { tickAll: async () => [], stop: async () => {} },
      directFillRecovery: createDirectFillRecovery({ attempts } as never),
    }
    const watching = watchLoopIn(signals, {
      Error,
      log,
      LockupWatcher: class {
        start = watcherStart
        sync() {}
        async stop() {}
      },
    })(services)
    const outcome = watching.catch((error: unknown) => error)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(log).toHaveBeenCalledWith('direct fill recovery failed:', 'SQLite temporarily unavailable')
      expect(watcherStart).toHaveBeenCalledOnce()
      expect(tickAll).toHaveBeenCalledOnce()
      expect(pins.reserved().size).toBe(1)
      await vi.advanceTimersByTimeAsync(6000)
      expect(list.mock.calls.length).toBeGreaterThan(1)
      expect(tickAll.mock.calls.length).toBeGreaterThan(1)
      expect(pins.reserved().size).toBe(1)
    } finally {
      signals.emit('SIGTERM')
      await vi.advanceTimersByTimeAsync(250)
      await outcome
      db.close()
    }
  })

  it('recovers direct fills at startup and on full sweeps with all asset markets disabled', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const signals = new EventEmitter()
    const sweep = vi.fn(async () => {})
    const services = {
      config: { corridorEnabled: {}, contractRetentionMs: 0, poolAutoMint: false, offerMarkets: [] },
      policy: { evmCorridors: [], offerMarkets: [] },
      arkade: { wallet: { getContractManager: async () => ({}) } },
      readers: [],
      corridors: [],
      assetRfqMarkets: [],
      assetOffers: null,
      assetRfqService: { tickAll: async () => [], stop: async () => {} },
      directFillRecovery: { sweep },
    }
    const watching = watchLoopIn(signals)(services)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(sweep).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(6000)
      expect(sweep.mock.calls.length).toBeGreaterThan(1)
    } finally {
      signals.emit('SIGTERM')
      await vi.advanceTimersByTimeAsync(250)
      await watching
    }
  })
  it('stops the corridor quoting without stopping the sweep that watches what it already locked', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const signals = new EventEmitter()
    const tickAll = vi.fn(async () => [])
    const services = {
      config: { corridorEnabled: {}, contractRetentionMs: 0, poolAutoMint: false },
      policy: { evmCorridors: [{ enabled: false, direction: 'send' }] },
      arkade: { wallet: { getContractManager: async () => ({}) } },
      readers: [],
      evmSendService: { tickAll },
      corridors: [],
      assetRfqService: { tickAll: async () => [], stop: async () => {} },
      assetRfqMarkets: [],
    }
    const watching = watchLoopIn(signals)(services)
    try {
      await vi.advanceTimersByTimeAsync(3000)
      expect(tickAll).toHaveBeenCalled()
    } finally {
      signals.emit('SIGTERM')
      await vi.advanceTimersByTimeAsync(250)
      await watching
    }
  })
})

describe('the independent EVM send sweep', () => {
  const harness = () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const tickAll = vi.fn().mockResolvedValue([])
    const input = {
      service: { tickAll },
      intervalMs: 3000,
      signal: controller.signal,
      onError: vi.fn(),
    }
    return { input, controller, tickAll }
  }

  it('starts only when recovery has finished, at the supplied sweep cadence', async () => {
    const { input, tickAll } = harness()
    await withEvmSendSweep({
      ...input,
      run: async (start) => {
        await vi.advanceTimersByTimeAsync(6000)
        expect(tickAll).not.toHaveBeenCalled()
        start()
        start()
        await vi.advanceTimersByTimeAsync(2999)
        expect(tickAll).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(tickAll).toHaveBeenCalledOnce()
      },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not schedule work when the deployment has no EVM send service at all', async () => {
    const { input, tickAll } = harness()
    await withEvmSendSweep({
      ...input,
      service: null,
      run: async (start) => {
        start()
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(9000)
        expect(tickAll).not.toHaveBeenCalled()
      },
    })
  })

  it('reports a rejected sweep and allows the next pass', async () => {
    const { input, tickAll } = harness()
    const error = new Error('store unavailable')
    tickAll.mockRejectedValueOnce(error)
    await withEvmSendSweep({
      ...input,
      run: async (start) => {
        start()
        await vi.advanceTimersByTimeAsync(3000)
        expect(input.onError).toHaveBeenCalledWith(error)
        await vi.advanceTimersByTimeAsync(3000)
        expect(tickAll).toHaveBeenCalledTimes(2)
        expect(input.onError).toHaveBeenCalledOnce()
      },
    })
  })

  it('runs funding recovery in the background without blocking or overlapping live ticks', async () => {
    const { input, tickAll } = harness()
    const recovery = deferred()
    const recoverySweep = vi.fn(() => recovery.promise)
    await withEvmSendSweep({
      ...input,
      recoverySweep,
      run: async (start) => {
        start()
        await vi.advanceTimersByTimeAsync(0)
        expect(recoverySweep).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(3000)
        expect(tickAll).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(3000)
        expect(recoverySweep).toHaveBeenCalledOnce()
        recovery.resolve()
      },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drains active funding recovery before returning to close services', async () => {
    const { input, controller } = harness()
    const recovery = deferred()
    const loop = deferred()
    let closed = false
    const watching = withEvmSendSweep({
      ...input,
      recoverySweep: () => recovery.promise,
      run: async (start) => {
        start()
        await vi.advanceTimersByTimeAsync(0)
        await loop.promise
      },
    }).then(() => {
      closed = true
    })
    controller.abort()
    loop.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(closed).toBe(false)
    recovery.resolve()
    await watching
    expect(closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops on abort and drains active work before returning to close services', async () => {
    const { input, controller, tickAll } = harness()
    const sweep = deferred()
    const loop = deferred()
    tickAll.mockReturnValue(sweep.promise)
    let closed = false
    const watching = withEvmSendSweep({
      ...input,
      run: async (start) => {
        start()
        await loop.promise
      },
    }).then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(9000)
    expect(tickAll).toHaveBeenCalledOnce()
    controller.abort()
    expect(vi.getTimerCount()).toBe(0)
    loop.resolve()
    await vi.advanceTimersByTimeAsync(9000)
    expect(closed).toBe(false)
    expect(tickAll).toHaveBeenCalledOnce()
    sweep.resolve()
    await watching
    expect(closed).toBe(true)
  })

  it('clears its timer and drains the sweep if the watch loop throws', async () => {
    const { input, tickAll } = harness()
    const sweep = deferred()
    const loop = deferred()
    const error = new Error('watch loop failed')
    tickAll.mockReturnValue(sweep.promise)
    let closed = false
    const watching = withEvmSendSweep({
      ...input,
      run: async (start) => {
        start()
        await loop.promise
        throw error
      },
    }).catch((failure: unknown) => {
      closed = true
      return failure
    })
    await vi.advanceTimersByTimeAsync(3000)
    loop.resolve()
    await vi.advanceTimersByTimeAsync(9000)
    expect(vi.getTimerCount()).toBe(0)
    expect(tickAll).toHaveBeenCalledOnce()
    expect(closed).toBe(false)
    sweep.resolve()
    expect(await watching).toBe(error)
    expect(closed).toBe(true)
  })
})

describe('named carrier work in the CLI watch loop', () => {
  it.each(['stop', 'loop failure', 'recovery failure'] as const)('drains before closing after %s', async (exit) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const signals = new EventEmitter()
    const held = deferred()
    const stop = vi.fn(() => held.promise)
    const watcherStop = vi.fn(async () => {})
    const tickAll = vi.fn(async () => [])
    const fault = new Error(exit)
    let failLoop = false
    const services = {
      config: { corridorEnabled: {}, contractRetentionMs: 0, poolAutoMint: false },
      policy: { evmCorridors: [] },
      arkade: { wallet: { getContractManager: async () => ({}) } },
      readers: [],
      corridors:
        exit === 'recovery failure'
          ? [
              {
                descriptor: { pair: 'custom' },
                tickAll: async () => {
                  throw fault
                },
              },
            ]
          : [],
      service: {
        tickHot: async () => {
          if (failLoop) throw fault
        },
      },
      assetRfqService: { tickAll, stop },
      assetRfqMarkets: [],
    }
    let completed = false
    const watching = watchLoopIn(signals, {
      LockupWatcher: class {
        start() {}
        sync() {}
        stop = watcherStop
      },
    })(services).then(
      () => {
        completed = true
        return undefined
      },
      (error: unknown) => {
        completed = true
        return error
      },
    )
    try {
      await vi.advanceTimersByTimeAsync(3250)
      if (exit !== 'recovery failure') {
        expect(tickAll.mock.calls.length).toBeGreaterThan(1)
        expect(tickAll).toHaveBeenCalledWith({ backgroundNamed: true })
        failLoop = exit === 'loop failure'
        if (exit === 'stop') signals.emit('SIGTERM')
        await vi.advanceTimersByTimeAsync(250)
      }
      expect(stop).toHaveBeenCalled()
      expect(completed).toBe(false)
      expect(watcherStop).not.toHaveBeenCalled()
      held.resolve()
      expect(await watching).toBe(exit === 'stop' ? undefined : fault)
      expect(watcherStop).toHaveBeenCalledTimes(exit === 'recovery failure' ? 0 : 1)
    } finally {
      signals.emit('SIGTERM')
      held.resolve()
      await vi.advanceTimersByTimeAsync(250)
      await watching
    }
  })
})
