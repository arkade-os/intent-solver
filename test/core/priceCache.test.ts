import { describe, it, expect, vi } from 'vitest'
import { cachedPriceFeed, STALE_FACTOR } from '@arkade-os/solver-core/core/priceCache.js'
import { priceFrom } from '@arkade-os/solver-core/core/priceFeed.js'

const TTL = 15_000
const build = (fetch: ReturnType<typeof vi.fn>, over: { onStale?: () => void } = {}) => {
  let clock = 0
  const feed = cachedPriceFeed({ fetch, ttlMs: TTL, now: () => clock, ...over })
  return { feed, advance: (ms: number) => (clock += ms) }
}

describe('cachedPriceFeed', () => {
  it('reads the feed once inside the TTL', async () => {
    const fetch = vi.fn(async () => priceFrom('100'))
    const { feed, advance } = build(fetch)
    await feed('https://f', '/p')
    advance(TTL - 1)
    await feed('https://f', '/p')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('re-reads once the TTL has passed', async () => {
    const fetch = vi.fn(async () => priceFrom('100'))
    const { feed, advance } = build(fetch)
    await feed('https://f', '/p')
    advance(TTL)
    await feed('https://f', '/p')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keys on the pointer too, so one host can serve two markets', async () => {
    const fetch = vi.fn(async () => priceFrom('100'))
    const { feed } = build(fetch)
    await feed('https://f', '/a')
    await feed('https://f', '/b')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('serves a stale price inside the window, and says so', async () => {
    let fail = false
    const fetch = vi.fn(async () => {
      if (fail) throw new Error('feed down')
      return priceFrom('100')
    })
    const onStale = vi.fn()
    const { feed, advance } = build(fetch, { onStale })
    await feed('https://f', '/p')
    fail = true
    advance(TTL * 2)
    await expect(feed('https://f', '/p')).resolves.toEqual(priceFrom('100'))
    expect(onStale).toHaveBeenCalledTimes(1)
  })

  it('THROWS past the stale window rather than trading on a forgotten price', async () => {
    // The half that decides money: a feed down for minutes must stop the
    // solver, not keep it filling at a price the market has left behind.
    let fail = false
    const fetch = vi.fn(async () => {
      if (fail) throw new Error('feed down')
      return priceFrom('100')
    })
    const { feed, advance } = build(fetch)
    await feed('https://f', '/p')
    fail = true
    advance(TTL * STALE_FACTOR)
    await expect(feed('https://f', '/p')).rejects.toThrow('feed down')
  })

  it('throws when the first read fails and there is nothing cached', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('feed down')
    })
    const { feed } = build(fetch)
    await expect(feed('https://f', '/p')).rejects.toThrow('feed down')
  })
})
