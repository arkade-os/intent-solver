/**
 * A short-lived feed read for the preview only, so a form does not fetch per
 * keystroke — not `price/feed.ts`'s seam; nothing here reaches a quote.
 */
import type { FetchPrice } from '@arkade-os/solver-core/price/feed.js'
import type { Price } from '@arkade-os/solver-core/core/priceFeed.js'

export interface FeedRead {
  price: Price
  /** Unix milliseconds the value was fetched. */
  readAt: number
}

export interface FeedCache {
  /** The cached price, refetched past the TTL. Null when the feed could not be read. */
  read(feedUrl: string, pricePath: string): Promise<FeedRead | null>
  /** A price the caller already fetched — the write probe's. */
  prime(feedUrl: string, pricePath: string, price: Price): void
}

const DEFAULT_TTL_MS = 15_000

export const createFeedCache = (
  fetchPrice: FetchPrice,
  opts: { ttlMs?: number; now?: () => number } = {},
): FeedCache => {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ?? ((): number => Date.now())
  const entries = new Map<string, FeedRead>()
  const inFlight = new Map<string, Promise<FeedRead | null>>()
  // Space-joined: a URL cannot contain one, so two feeds cannot collide onto one entry.
  const keyFor = (feedUrl: string, pricePath: string): string => `${feedUrl} ${pricePath}`

  return {
    prime(feedUrl, pricePath, price) {
      entries.set(keyFor(feedUrl, pricePath), { price, readAt: now() })
    },
    async read(feedUrl, pricePath) {
      const key = keyFor(feedUrl, pricePath)
      const cached = entries.get(key)
      if (cached && now() - cached.readAt < ttlMs) return cached
      const existing = inFlight.get(key)
      if (existing) return existing
      const pending = fetchPrice(feedUrl, pricePath)
        .then((price): FeedRead => {
          const read = { price, readAt: now() }
          entries.set(key, read)
          return read
        })
        // Not cached: a feed that recovers must be readable on the next call, not after the window.
        .catch((): null => null)
        .finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
      return pending
    },
  }
}
