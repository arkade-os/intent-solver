/**
 * The I/O half of pricing.
 *
 * Every refusal below has one consequence in common: a feed that answers
 * something other than a price must not become one. A 500, HTML from a proxy, a
 * body missing the pointer - each would otherwise price a swap against a number
 * nobody chose, and the swap would quote and settle normally.
 */

import { describe, it, expect, vi } from 'vitest'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'

/** What the arkade regtest stack serves at `http://pricefeed/btc-asset`. */
const REGTEST_BODY = '{"btc":{"asset":100000000}}'

const respond = (text: string, init: { status?: number; statusText?: string } = {}) =>
  vi.fn().mockResolvedValue({
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    text: async () => text,
  } as unknown as Response)

describe('reading a price off a feed', () => {
  it('resolves the pointer the regtest stack actually needs', async () => {
    const fetch = respond(REGTEST_BODY)
    const price = await createPriceFeed({ fetch })('http://pricefeed/btc-asset', '/btc/asset')
    expect(price).toEqual({ mantissa: 100000000n, scale: 0 })
  })

  it('GETs the feed url with an abort signal attached', async () => {
    const fetch = respond(REGTEST_BODY)
    await createPriceFeed({ fetch })('http://pricefeed/btc-asset', '/btc/asset')
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://pricefeed/btc-asset')
    expect((init as RequestInit).method).toBe('GET')
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })

  it('derives the pointer for a known provider when the operator left it empty', async () => {
    const fetch = respond('{"price":"64000.5"}')
    const price = await createPriceFeed({ fetch })('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', '')
    expect(price).toEqual({ mantissa: 640005n, scale: 1 })
  })

  it('derives the coingecko pointer from its query parameters', async () => {
    const fetch = respond('{"bitcoin":{"usd":64000}}')
    const price = await createPriceFeed({ fetch })(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      '',
    )
    expect(price).toEqual({ mantissa: 64000n, scale: 0 })
  })
})

describe('refusals', () => {
  it('refuses a malformed pointer BEFORE spending a request on it', async () => {
    // Costs no network call, and reports the pointer rather than whatever the
    // feed happened to answer.
    const fetch = respond(REGTEST_BODY)
    await expect(createPriceFeed({ fetch })('http://pricefeed/btc-asset', 'btc/asset')).rejects.toThrow(/starting with/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a feed it cannot derive a pointer for, rather than guessing', async () => {
    // Guessing would price the swap against whatever number sat at the guess.
    const fetch = respond(REGTEST_BODY)
    await expect(createPriceFeed({ fetch })('http://pricefeed/btc-asset', '')).rejects.toThrow(/price_path is required/)
  })

  it('refuses a non-2xx and includes the BODY, not just the code', async () => {
    const fetch = respond('daily quota exceeded', { status: 429, statusText: 'Too Many Requests' })
    await expect(createPriceFeed({ fetch })('http://feed', '/p')).rejects.toThrow(/429.*daily quota exceeded/)
  })

  it('refuses a body that is not JSON', async () => {
    // An HTML error page from a proxy in front of the feed.
    const fetch = respond('<html>502 Bad Gateway</html>')
    await expect(createPriceFeed({ fetch })('http://feed', '/p')).rejects.toThrow(/was not JSON/)
  })

  it('refuses a body that is JSON but has nothing at the pointer', async () => {
    const fetch = respond('{"btc":{"usd":1}}')
    await expect(createPriceFeed({ fetch })('http://feed', '/btc/asset')).rejects.toThrow(/no key "asset"/)
  })

  it('refuses a zero price, which would make every swap free one way', async () => {
    const fetch = respond('{"btc":{"asset":0}}')
    await expect(createPriceFeed({ fetch })('http://feed', '/btc/asset')).rejects.toThrow(/positive/)
  })

  it('abandons a feed that accepts the connection and never answers', async () => {
    // Awaited on the quote path: without this a client waits with no refusal.
    const fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('TimeoutError')))
        }),
    ) as unknown as typeof globalThis.fetch
    await expect(createPriceFeed({ fetch, timeoutMs: 20 })('http://feed', '/p')).rejects.toThrow()
  })
})

/**
 * A misconfigured timeout is a STARTUP fault, not a request-time one.
 *
 * `AbortSignal.timeout` raises `RangeError` for a negative value, but only when
 * the first request builds a signal — so before this the process came up
 * healthy, served nothing, and died on the first quote a client asked for, with
 * an error from inside a fetch rather than one naming the setting.
 */
describe('createPriceFeed validates its timeout', () => {
  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses a %s timeout at construction', (_why, timeoutMs) => {
    expect(() => createPriceFeed({ timeoutMs })).toThrow(/timeoutMs must be a non-negative finite number/)
  })

  it('accepts zero and an ordinary value', () => {
    // Zero is a legal `AbortSignal.timeout` argument (it aborts immediately),
    // so refusing it would be this guard overreaching past the fault it exists
    // for. The bound is "not negative, not non-finite", nothing more.
    expect(() => createPriceFeed({ timeoutMs: 0 })).not.toThrow()
    expect(() => createPriceFeed({ timeoutMs: 5_000 })).not.toThrow()
  })

  it('still constructs with no timeout given', () => {
    expect(() => createPriceFeed({})).not.toThrow()
  })
})
