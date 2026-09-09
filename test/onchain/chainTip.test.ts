/**
 * The chain-tip provider: one read per tick, shared, and loud when the indexer is down.
 *
 * The caching is not an optimisation. Two swaps in one tick deciding against different
 * heights is how one refund gets pushed and its neighbour does not, for no reason either
 * could report — so the interesting assertions here are about SHARING a reading, not
 * about saving a request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEsploraClient, type EsploraClient } from '@arkade-os/solver-rails-esplora/esplora.js'
import { esploraChainTip, staticChainTip, TIP_CACHE_MS } from '@arkade-os/solver-rails/onchain/chainTip.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Only `getText` is ever reached; the rest of the port is unimplemented on purpose. */
const client = (getText: (path: string) => Promise<string>): EsploraClient => ({ getText }) as unknown as EsploraClient

describe('esploraChainTip', () => {
  it('reads the tip height endpoint and parses it', async () => {
    const getText = vi.fn(async () => '812\n')
    const tip = esploraChainTip(client(getText))
    expect(await tip.height()).toBe(812)
    expect(getText).toHaveBeenCalledWith('/blocks/tip/height')
  })

  it('answers every caller in a tick from ONE reading', async () => {
    let now = 0
    const getText = vi.fn(async () => '812')
    const tip = esploraChainTip(client(getText), { now: () => now })
    expect(await Promise.all([tip.height(), tip.height(), tip.height()])).toEqual([812, 812, 812])
    // Not three round-trips a few milliseconds apart, all of which would have to
    // agree to be self-consistent.
    expect(getText).toHaveBeenCalledTimes(1)
  })

  it('re-reads once the cache window has passed', async () => {
    let now = 0
    let height = 812
    const getText = vi.fn(async () => String(height))
    const tip = esploraChainTip(client(getText), { now: () => now })
    expect(await tip.height()).toBe(812)
    height = 900
    now = TIP_CACHE_MS - 1
    expect(await tip.height()).toBe(812)
    now = TIP_CACHE_MS
    expect(await tip.height()).toBe(900)
  })

  it.each(['', 'not-a-height', '0', '-1', '812.5'])('throws rather than returning %s as a height', async (raw) => {
    // A NaN height silently makes every `tipHeight >= locktime` comparison false,
    // so every refund would look permanently unripe and nothing would ever be
    // pushed. A down indexer must look like a down indexer.
    const tip = esploraChainTip(client(async () => raw))
    await expect(tip.height()).rejects.toThrow(/chain tip height must be a positive integer/)
  })

  it('does not cache a failure, and retries on the next ask', async () => {
    let answer = 'down'
    const getText = vi.fn(async () => answer)
    const tip = esploraChainTip(client(getText))
    await expect(tip.height()).rejects.toThrow()
    answer = '812'
    expect(await tip.height()).toBe(812)
  })

  it('recovers from a read that never answers, instead of wedging on it forever', async () => {
    // The in-flight reading is SHARED and cleared only when it settles, so one that never does is a
    // dead promise every later caller joins. Composed with the real client, as `ops/services.ts` is.
    let quiet = true
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) =>
      quiet
        ? new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
          })
        : Promise.resolve(new Response('812', { status: 200 })),
    ) as unknown as typeof fetch

    const tip = esploraChainTip(createEsploraClient('https://esplora.example/api', undefined, 20))
    await expect(tip.height()).rejects.toThrow(/timeout/i)
    quiet = false
    expect(await tip.height()).toBe(812)
  })

  it('propagates a transport failure rather than swallowing it', async () => {
    const tip = esploraChainTip(
      client(async () => {
        throw new Error('esplora GET /blocks/tip/height failed (503)')
      }),
    )
    await expect(tip.height()).rejects.toThrow(/503/)
  })
})

describe('staticChainTip', () => {
  it('answers the height it was given', async () => {
    expect(await staticChainTip(900).height()).toBe(900)
  })
})
