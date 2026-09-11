import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withEvmSendSweep } from '@arkade-os/solver-app/ops/evmSendSweep.js'

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

describe('the watch loop during slow wallet maintenance', () => {
  it.each(['contract', 'float'])('drives EVM sends while %s maintenance is unresolved', async (stage) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const blocked = deferred()
    const signals = new EventEmitter()
    const maintenance = vi.fn(() => blocked.promise)
    let funded = false
    const progressed = vi.fn()
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
      corridors: [{ tickAll, findRecoverable: async () => [] }],
    }
    const watch = runInNewContext(`${compiled}; watchUntilStopped`, {
      process: signals,
      withEvmSendSweep,
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
      runContractLifecycle: stage === 'contract' ? maintenance : async () => {},
      runFloatLifecycle: async () => {
        if (stage === 'float') await maintenance()
        return { failures: [] }
      },
      maybeMintPool: async () => ({ minted: false, skipped: 'disabled' }),
    }) as (services: unknown) => Promise<void>
    const watching = watch(services)
    try {
      await vi.advanceTimersByTimeAsync(250)
      expect(maintenance).toHaveBeenCalledOnce()
      funded = true
      await vi.advanceTimersByTimeAsync(3000)
      expect(progressed).toHaveBeenCalled()
    } finally {
      signals.emit('SIGTERM')
      blocked.resolve()
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
      policies: [{ enabled: true, direction: 'send' as const }],
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

  it.each(['disabled', 'receive-only', 'no-service'])('does not schedule work for %s', async (configuration) => {
    const { input, tickAll } = harness()
    await withEvmSendSweep({
      ...input,
      service: configuration === 'no-service' ? null : input.service,
      policies: [
        { enabled: configuration !== 'disabled', direction: configuration === 'receive-only' ? 'receive' : 'send' },
      ],
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
