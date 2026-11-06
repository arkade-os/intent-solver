/**
 * What the inline loop gave for free and this has to pin: one pass at a time,
 * and a rejected pass that does not end the cadence.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { startCadence } from '@arkade-os/solver-app/ops/cadence.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => vi.useRealTimers())

describe('startCadence', () => {
  it('runs the first pass at once, then on the interval', async () => {
    vi.useFakeTimers()
    const pass = vi.fn(async () => {})
    const cadence = startCadence({ intervalMs: 1000, signal: new AbortController().signal, pass, onError: () => {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(pass).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(999)
    expect(pass).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(pass).toHaveBeenCalledTimes(2)
    await cadence.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never runs two passes at once, however long one takes', async () => {
    vi.useFakeTimers()
    const blocked = deferred()
    const pass = vi.fn(() => blocked.promise)
    const cadence = startCadence({ intervalMs: 1000, signal: new AbortController().signal, pass, onError: () => {} })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pass).toHaveBeenCalledOnce()
    blocked.resolve()
    await vi.advanceTimersByTimeAsync(1000)
    expect(pass).toHaveBeenCalledTimes(2)
    await cadence.stop()
  })

  it('reports a rejected pass and keeps the cadence', async () => {
    vi.useFakeTimers()
    const error = new Error('indexer unavailable')
    const pass = vi.fn<() => Promise<void>>().mockRejectedValueOnce(error).mockResolvedValue(undefined)
    const onError = vi.fn()
    const cadence = startCadence({ intervalMs: 1000, signal: new AbortController().signal, pass, onError })
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(error)
    await vi.advanceTimersByTimeAsync(1000)
    expect(pass).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledOnce()
    await cadence.stop()
  })

  it('starts no pass once the signal aborts, and leaves no timer behind', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const pass = vi.fn(async () => {})
    const cadence = startCadence({ intervalMs: 1000, signal: controller.signal, pass, onError: () => {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(pass).toHaveBeenCalledOnce()
    controller.abort()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pass).toHaveBeenCalledOnce()
    await cadence.stop()
  })

  it('does not start a pass at all when the signal is already aborted', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    controller.abort()
    const pass = vi.fn(async () => {})
    const cadence = startCadence({ intervalMs: 1000, signal: controller.signal, pass, onError: () => {} })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pass).not.toHaveBeenCalled()
    await cadence.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  // The shutdown contract the watch loop depends on: it tears down the watcher
  // and the offer stream a pass reads from, so stop() has to outlive the pass.
  it('drains the pass in flight before stop resolves', async () => {
    vi.useFakeTimers()
    const blocked = deferred()
    const controller = new AbortController()
    const cadence = startCadence({
      intervalMs: 1000,
      signal: controller.signal,
      pass: () => blocked.promise,
      onError: () => {},
    })
    controller.abort()
    let stopped = false
    const stopping = cadence.stop().then(() => {
      stopped = true
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(stopped).toBe(false)
    blocked.resolve()
    await stopping
    expect(stopped).toBe(true)
  })
})
