import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { watchRail } from '@arkade-os/solver-app/ops/railWatch.js'

describe('watchRail', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const start = (probe: () => Promise<void>) => {
    const log = vi.fn()
    const onReachable = vi.fn()
    const watch = watchRail({ probe, intervalMs: 5_000, log, onReachable })
    return { watch, log, onReachable }
  }

  it('reads down until the first probe answers', async () => {
    const { watch, onReachable } = start(async () => {})
    expect(watch.up()).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.up()).toBe(true)
    expect(onReachable).toHaveBeenCalledTimes(1)
    watch.stop()
  })

  it('goes down on a failed probe, says why once, and comes back without a restart', async () => {
    let answer: () => Promise<void> = async () => {}
    const { watch, log } = start(() => answer())
    await vi.advanceTimersByTimeAsync(0)

    answer = async () => {
      throw new Error('LND at lnd:10009 did not answer getWalletInfo: GetWalletInfoErr: 14 UNAVAILABLE')
    }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(watch.up()).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toContain('14 UNAVAILABLE')

    answer = async () => {}
    await vi.advanceTimersByTimeAsync(5_000)
    expect(watch.up()).toBe(true)
    expect(log).toHaveBeenCalledTimes(2)
    watch.stop()
  })

  it('fails closed when a probe stalls, before its own deadline would say so', async () => {
    let answer: () => Promise<void> = async () => {}
    const { watch } = start(() => answer())
    await vi.advanceTimersByTimeAsync(0)
    answer = () => new Promise<void>(() => {})
    await vi.advanceTimersByTimeAsync(10_000)
    expect(watch.up()).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(watch.up()).toBe(false)
    watch.stop()
  })

  it('does not act on a probe that answers after it was stopped', async () => {
    let resolve: () => void = () => {}
    const { watch, onReachable } = start(() => new Promise<void>((r) => (resolve = r)))
    watch.stop()
    resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(onReachable).not.toHaveBeenCalled()
  })

  it('never stacks probes behind one that hangs', async () => {
    const probe = vi.fn(() => new Promise<void>(() => {}))
    const { watch } = start(probe)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(watch.up()).toBe(false)
    watch.stop()
  })

  it('stops probing once stopped', async () => {
    const probe = vi.fn(async () => {})
    const { watch } = start(probe)
    await vi.advanceTimersByTimeAsync(0)
    watch.stop()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
