// The preview must not fetch per keystroke, and must never serve the write
// PROBE from cache — a probe is a live claim about right now.
import { describe, it, expect, vi } from 'vitest'
import { createFeedCache } from '@arkade-os/solver-app/admin/feedCache.js'
import { priceFrom } from '@arkade-os/solver-core/core/priceFeed.js'

const at = (ms: number) => () => ms

describe('createFeedCache', () => {
  it('serves a second read inside the window without a second fetch', async () => {
    const fetchPrice = vi.fn().mockResolvedValue(priceFrom('100000'))
    let clock = 1_000
    const cache = createFeedCache(fetchPrice, { ttlMs: 15_000, now: () => clock })
    expect((await cache.read('https://feed.test/p', '/price'))!.price).toEqual(priceFrom('100000'))
    clock += 14_999
    await cache.read('https://feed.test/p', '/price')
    expect(fetchPrice).toHaveBeenCalledTimes(1)
  })

  it('refetches once the window has passed', async () => {
    const fetchPrice = vi.fn().mockResolvedValue(priceFrom('100000'))
    let clock = 1_000
    const cache = createFeedCache(fetchPrice, { ttlMs: 15_000, now: () => clock })
    await cache.read('https://feed.test/p', '/price')
    clock += 15_000
    await cache.read('https://feed.test/p', '/price')
    expect(fetchPrice).toHaveBeenCalledTimes(2)
  })

  it('does not collide a URL/pointer pair across the join boundary', async () => {
    const fetchPrice = vi.fn().mockResolvedValue(priceFrom('100000'))
    const cache = createFeedCache(fetchPrice, { now: at(1_000) })
    await cache.read('https://f.test/a /b', '/c')
    await cache.read('https://f.test/a', '/b /c')
    expect(fetchPrice).toHaveBeenCalledTimes(2)
  })

  it('keys on the pointer as well as the URL', async () => {
    const fetchPrice = vi.fn().mockResolvedValue(priceFrom('100000'))
    const cache = createFeedCache(fetchPrice, { now: at(1_000) })
    await cache.read('https://feed.test/p', '/a')
    await cache.read('https://feed.test/p', '/b')
    expect(fetchPrice).toHaveBeenCalledTimes(2)
  })

  it('collapses concurrent reads into one fetch', async () => {
    let release: (value: unknown) => void = () => {}
    const fetchPrice = vi.fn(() => new Promise((resolve) => (release = resolve)))
    const cache = createFeedCache(fetchPrice as never, { now: at(1_000) })
    const both = Promise.all([cache.read('https://feed.test/p', '/price'), cache.read('https://feed.test/p', '/price')])
    release(priceFrom('100000'))
    await both
    expect(fetchPrice).toHaveBeenCalledTimes(1)
  })

  it('answers null on an unreadable feed rather than throwing into the route', async () => {
    const cache = createFeedCache(vi.fn().mockRejectedValue(new Error('HTTP 503')), { now: at(1_000) })
    expect(await cache.read('https://feed.test/p', '/price')).toBeNull()
  })

  it('does not cache a failure, so a feed that recovers is read again', async () => {
    const fetchPrice = vi.fn().mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValue(priceFrom('9'))
    const cache = createFeedCache(fetchPrice, { now: at(1_000) })
    expect(await cache.read('https://feed.test/p', '/price')).toBeNull()
    expect((await cache.read('https://feed.test/p', '/price'))!.price).toEqual(priceFrom('9'))
  })

  it('takes a price the caller already fetched, so a save leaves the preview live', async () => {
    const fetchPrice = vi.fn()
    const cache = createFeedCache(fetchPrice, { now: at(1_000) })
    cache.prime('https://feed.test/p', '/price', priceFrom('100000'))
    expect(await cache.read('https://feed.test/p', '/price')).toEqual({ price: priceFrom('100000'), readAt: 1_000 })
    expect(fetchPrice).not.toHaveBeenCalled()
  })
})
