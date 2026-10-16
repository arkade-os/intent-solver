import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWalletInfo, type AuthenticatedLnd } from 'lightning'
import { deadlined, LndReadTimeoutError } from '@arkade-os/solver-rails-lnd/deadline.js'

const client = () => {
  const callbacks: ((error: Error) => void)[] = []
  const lnd = {
    default: {
      getInfo: (_request: unknown, callback: (error: Error) => void) => callbacks.push(callback),
    },
  } as unknown as AuthenticatedLnd
  return { lnd, callbacks }
}

describe('LND read work bound', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('retains timed-out reads in the capacity budget across wrappers', async () => {
    const { lnd, callbacks } = client()
    const reads = [deadlined('getWalletInfo', getWalletInfo), deadlined('getWalletInfo', getWalletInfo)]
    const errors: Error[] = []
    for (let i = 0; i < 24; i++) {
      const result = reads[i % 2]!({ lnd }, 10).catch((error: Error) => error)
      await vi.advanceTimersByTimeAsync(10)
      errors.push((await result) as Error)
    }
    expect(callbacks).toHaveLength(8)
    expect(errors[0]).toBeInstanceOf(LndReadTimeoutError)
    expect(errors.slice(8).every((error) => error.name === 'LndReadCapacityError')).toBe(true)
  })

  it('admits work again only after a timed-out vendor read settles', async () => {
    const { lnd, callbacks } = client()
    const read = deadlined('getWalletInfo', getWalletInfo)
    const first = Array.from({ length: 8 }, () => read({ lnd }, 10).catch((error: Error) => error))
    await vi.advanceTimersByTimeAsync(10)
    await Promise.all(first)
    const blocked = read({ lnd }, 10).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(10)
    expect(await blocked).toMatchObject({ name: 'LndReadCapacityError' })
    callbacks[0]!(new Error('connection closed'))
    await vi.advanceTimersByTimeAsync(0)

    const retried = read({ lnd }, 10).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(10)
    expect(callbacks).toHaveLength(9)
    expect(await retried).toBeInstanceOf(LndReadTimeoutError)
  })

  it('does not let one stalled LND client consume another client capacity', async () => {
    const stalled = client()
    const healthy = client()
    const read = deadlined('getWalletInfo', getWalletInfo)
    const pending = Array.from({ length: 8 }, () => read({ lnd: stalled.lnd }, 10).catch(() => {}))
    await vi.advanceTimersByTimeAsync(10)
    await Promise.all(pending)
    const result = read({ lnd: healthy.lnd }, 10).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(10)
    expect(healthy.callbacks).toHaveLength(1)
    expect(await result).toBeInstanceOf(LndReadTimeoutError)
  })
})
