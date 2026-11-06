/**
 * The discovery stream, against a fake subscription. Reconnection and liveness
 * are the parts worth pinning: a solver that goes quietly deaf still looks healthy.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { getEventListeners } from 'node:events'
import { EventSourceUnavailableError, type SubscriptionEvent, type SubscriptionHeartbeat } from '@arkade-os/sdk'
import {
  streamOfferTxs,
  OFFER_PACKET_FILTER,
  type FilteredSubscribe,
} from '@arkade-os/solver-arkade/arkade/offerStream.js'

type Message = SubscriptionEvent | SubscriptionHeartbeat

const event = (txid: string, tx?: string): SubscriptionEvent => ({
  type: 'event',
  txid,
  tx,
  scripts: [],
  newVtxos: [],
  spentVtxos: [],
  sweptVtxos: [],
})

const heartbeat: SubscriptionHeartbeat = { type: 'heartbeat' }

/** A subscription that yields these messages once, then ends. */
const yielding = (messages: Message[]): FilteredSubscribe =>
  async function* () {
    for (const message of messages) yield message
  }

/** A subscription that yields these messages, then stays open until aborted. */
const holding = (messages: Message[]): FilteredSubscribe =>
  async function* (_filter, signal) {
    for (const message of messages) yield message
    await new Promise((resolve) => signal.addEventListener('abort', resolve))
  }

const collect = async (gen: AsyncGenerator<{ txid: string; tx: string }>, n: number) => {
  const out: { txid: string; tx: string }[] = []
  for await (const item of gen) {
    out.push(item)
    if (out.length >= n) break
  }
  return out
}

const url = 'http://arkd.test'

const MIN_MS = 10
const STALE_MS = 180_000

/**
 * A stream whose every attempt fails, unless `override` supplies one that does
 * not. Driven on fake timers, so the reconnect waits are exact rather than raced.
 */
const driveFailing = (
  override?: (call: number, args: Parameters<FilteredSubscribe>) => ReturnType<FilteredSubscribe> | null,
) => {
  let calls = 0
  const errors: unknown[] = []
  const subscribe: FilteredSubscribe = (...args) => {
    calls += 1
    return (
      override?.(calls, args) ??
      (async function* () {
        throw new Error('EventSource error')
      })()
    )
  }
  const controller = new AbortController()
  const drained = (async () => {
    for await (const item of streamOfferTxs({
      arkdUrl: url,
      subscribe,
      signal: controller.signal,
      reconnectMinMs: MIN_MS,
      reconnectMaxMs: 10_000,
      onError: (error) => void errors.push(error),
    }))
      void item
  })()
  return {
    attempts: () => calls,
    errors,
    signal: controller.signal,
    stop: async () => {
      controller.abort()
      await vi.advanceTimersByTimeAsync(MIN_MS)
      await drained
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('streamOfferTxs', () => {
  it('asks arkd for offer packets by default', async () => {
    const subscribe = vi.fn(yielding([event('a', 'tx-a')]))
    const signal = AbortSignal.timeout(2_000)
    await collect(streamOfferTxs({ arkdUrl: url, subscribe, signal }), 1)
    expect(subscribe.mock.calls[0]![0]).toEqual({ expressions: [OFFER_PACKET_FILTER] })
  })

  it("reaches arkd's filtered SSE route when no subscription is injected", async () => {
    const opened: string[] = []
    class FakeEventSource extends EventTarget {
      constructor(readonly url: string) {
        super()
        opened.push(url)
        setTimeout(() => {
          const data = JSON.stringify({ event: { txid: 'a', tx: 'tx-a' } })
          this.dispatchEvent(new MessageEvent('message', { data }))
        }, 0)
      }
      close() {}
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    const signal = AbortSignal.timeout(2_000)
    const got = await collect(streamOfferTxs({ arkdUrl: `${url}/`, signal }), 1)
    expect(got).toEqual([{ txid: 'a', tx: 'tx-a' }])
    const opened0 = new URL(opened[0]!)
    expect(`${opened0.origin}${opened0.pathname}`).toBe(`${url}/v1/indexer/subscription`)
    expect(opened0.searchParams.getAll('filter.expressions')).toEqual([OFFER_PACKET_FILTER])
  })

  it('yields transactions and swallows heartbeats', async () => {
    const subscribe = yielding([heartbeat, event('a', 'tx-a'), heartbeat, event('b', 'tx-b')])
    const signal = AbortSignal.timeout(2_000)
    const got = await collect(streamOfferTxs({ arkdUrl: url, subscribe, signal }), 2)
    expect(got).toEqual([
      { txid: 'a', tx: 'tx-a' },
      { txid: 'b', tx: 'tx-b' },
    ])
  })

  it('skips an event that carries no tx', async () => {
    const subscribe = yielding([event('bare'), event('', 'tx-anon'), event('a', 'tx-a')])
    const signal = AbortSignal.timeout(2_000)
    const got = await collect(streamOfferTxs({ arkdUrl: url, subscribe, signal }), 1)
    expect(got).toEqual([{ txid: 'a', tx: 'tx-a' }])
  })

  it('RECONNECTS after the stream ends, rather than going quietly deaf', async () => {
    let call = 0
    const subscribe: FilteredSubscribe = (...args) => {
      call += 1
      return call === 1 ? yielding([])(...args) : yielding([event('after', 'tx-after')])(...args)
    }
    const signal = AbortSignal.timeout(3_000)
    const got = await collect(streamOfferTxs({ arkdUrl: url, subscribe, signal, reconnectMinMs: 1 }), 1)
    expect(got).toEqual([{ txid: 'after', tx: 'tx-after' }])
    expect(call).toBeGreaterThan(1)
  })

  it('reports a refused subscription and retries', async () => {
    const errors: unknown[] = []
    let call = 0
    const subscribe: FilteredSubscribe = (...args) => {
      call += 1
      if (call === 1) {
        return (async function* () {
          throw new Error('arkd refused: invalid filter')
        })()
      }
      return yielding([event('ok', 'tx-ok')])(...args)
    }
    const signal = AbortSignal.timeout(3_000)
    const got = await collect(
      streamOfferTxs({ arkdUrl: url, subscribe, signal, reconnectMinMs: 1, onError: (e) => void errors.push(e) }),
      1,
    )
    expect(got).toEqual([{ txid: 'ok', tx: 'tx-ok' }])
    expect(String(errors[0])).toContain('invalid filter')
  })

  it('LENGTHENS the wait between failed reconnects, rather than hammering arkd', async () => {
    vi.useFakeTimers()
    const { attempts, stop } = driveFailing()
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts()).toBe(1)
    await vi.advanceTimersByTimeAsync(MIN_MS)
    expect(attempts()).toBe(2)
    // The second wait has to exceed the first, so another `MIN_MS` buys nothing.
    await vi.advanceTimersByTimeAsync(MIN_MS)
    expect(attempts()).toBe(2)
    await stop()
  })

  it('and drops back to the shortest wait once a stream has delivered', async () => {
    vi.useFakeTimers()
    const { attempts, stop } = driveFailing((call, args) => (call === 2 ? yielding([heartbeat])(...args) : null))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(MIN_MS)
    expect(attempts()).toBe(2)
    await vi.advanceTimersByTimeAsync(MIN_MS)
    expect(attempts()).toBe(3)
    await stop()
  })

  it('frees each wait, instead of piling an abort listener up per reconnect', async () => {
    vi.useFakeTimers()
    const { attempts, signal, stop } = driveFailing()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(MIN_MS * 2 ** i)
    expect(attempts()).toBeGreaterThan(4)
    expect(getEventListeners(signal, 'abort').length).toBeLessThanOrEqual(2)
    await stop()
  })

  it('stays on one connection while heartbeats keep arriving', async () => {
    vi.useFakeTimers()
    const { attempts, errors, stop } = driveFailing((_call, [, signal]) =>
      (async function* () {
        while (!signal.aborted) {
          await new Promise((resolve) => {
            setTimeout(resolve, 60_000)
            signal.addEventListener('abort', resolve)
          })
          if (!signal.aborted) yield heartbeat
        }
      })(),
    )
    await vi.advanceTimersByTimeAsync(STALE_MS * 4)
    expect(attempts()).toBe(1)
    expect(errors).toEqual([])
    await stop()
  })

  it('reconnects a connection that has gone silent, and says so', async () => {
    vi.useFakeTimers()
    const { attempts, errors, stop } = driveFailing((_call, args) => holding([])(...args))
    await vi.advanceTimersByTimeAsync(STALE_MS - 1)
    expect(attempts()).toBe(1)
    await vi.advanceTimersByTimeAsync(1 + MIN_MS)
    expect(attempts()).toBe(2)
    expect(String(errors[0])).toContain('no frame from arkd')
    await stop()
  })

  it('gives up once, rather than looping, when there is no EventSource', async () => {
    const errors: unknown[] = []
    const subscribe = vi.fn<FilteredSubscribe>(async function* () {
      throw new EventSourceUnavailableError()
    } as FilteredSubscribe)
    const out = []
    for await (const item of streamOfferTxs({
      arkdUrl: url,
      subscribe,
      reconnectMinMs: 1,
      onError: (e) => void errors.push(e),
    }))
      out.push(item)
    expect(out).toEqual([])
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
  })

  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    const subscribe = vi.fn(yielding([]))
    const out = []
    for await (const item of streamOfferTxs({ arkdUrl: url, subscribe, signal: controller.signal })) {
      out.push(item)
    }
    expect(out).toEqual([])
    expect(subscribe).not.toHaveBeenCalled()
  })
})
