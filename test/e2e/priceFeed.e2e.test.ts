/**
 * E2E - the price feed against the one the arkade stack actually runs.
 *
 * `test/price/feed.test.ts` drives this client against scripted responses, which
 * proves it handles the shapes we imagined. It cannot prove those shapes are the
 * ones an operator's feed serves. This reads the REAL `pricefeed` container from
 * `arkade-regtest` - the same service `solver-init` registers markets against -
 * so a change to what that serves shows up here rather than at the first quote.
 *
 * The Go solver (`arkade-os/solver`) reads this identical URL and pointer. That
 * is the point of matching its contract: an operator running both solvers points
 * them at ONE feed, and a rate that differed between them would be an arbitrage
 * against whichever quoted lower. This test is what keeps that claim honest.
 *
 * PREREQUISITE: the arkade regtest stack's `pricefeed` service, published on
 * 8088 by default. Skipped rather than failed when absent, like the EVM e2e.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'
import { convertAmount } from '@arkade-os/solver-core/core/priceFeed.js'

const FEED_URL = process.env.PRICEFEED_E2E_URL ?? 'http://localhost:8088/btc-asset'
/** The pointer `solver-init` registers with the Go solver for this feed, verbatim. */
const PRICE_PATH = '/btc/asset'

let available = false

beforeAll(async () => {
  try {
    const response = await fetch(FEED_URL, { signal: AbortSignal.timeout(2_000) })
    available = response.ok
  } catch {
    available = false
  }
}, 30_000)

const itOnFeed: typeof it = ((name: string, fn: any, timeout?: number) =>
  it(
    name,
    async (ctx: any) => {
      if (!available) return ctx.skip()
      await fn(ctx)
    },
    timeout,
  )) as never

describe('the arkade regtest price feed', () => {
  itOnFeed('reads a positive price at the pointer solver-init registers', async () => {
    const price = await createPriceFeed()(FEED_URL, PRICE_PATH)
    expect(price.mantissa).toBeGreaterThan(0n)
    expect(price.scale).toBeGreaterThanOrEqual(0)
  })

  itOnFeed('prices a whole BTC into the asset, exactly', async () => {
    // The feed quotes asset-per-BTC and the regtest asset carries no decimals,
    // so one whole BTC must come back as a whole number of asset units with no
    // remainder. A rounding difference here would mean the two solvers disagree.
    const price = await createPriceFeed()(FEED_URL, PRICE_PATH)
    const down = convertAmount({
      baseAmount: 100_000_000n,
      price,
      baseDecimals: 8,
      quoteDecimals: 0,
      rounding: 'down',
    })
    const up = convertAmount({ baseAmount: 100_000_000n, price, baseDecimals: 8, quoteDecimals: 0, rounding: 'up' })
    expect(down).toBeGreaterThan(0n)
    expect(up).toBe(down)
  })

  itOnFeed('refuses a pointer this feed does not carry, naming the key', async () => {
    // The ordinary failure in production is a feed changing shape. It must not
    // resolve to some other number that happens to be nearby.
    await expect(createPriceFeed()(FEED_URL, '/btc/usd')).rejects.toThrow(/no key "usd"/)
  })

  itOnFeed('refuses to derive a pointer for this feed, since it is not a known provider', async () => {
    await expect(createPriceFeed()(FEED_URL, '')).rejects.toThrow(/price_path is required/)
  })
})
