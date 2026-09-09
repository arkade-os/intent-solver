/**
 * The discovery stream, against a fake transport. Reconnection and framing are
 * the parts worth pinning: a solver that goes quietly deaf still looks healthy.
 *
 * The real transport is exercised against a live arkd, not here — see the
 * commit that added this for the observed txid.
 */
import { describe, it, expect, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import { streamOfferTxs, OFFER_PACKET_FILTER, type GrpcTransport } from '@arkade-os/solver-arkade/arkade/offerStream.js'
import { grpcFrame } from '@arkade-os/solver-arkade/arkade/grpcWire.js'

const utf8 = new TextEncoder()
const lenField = (field: number, payload: Uint8Array): number[] => [field * 8 + 2, payload.length, ...payload]

/** A GetSubscriptionResponse carrying an event with this txid and tx. */
const eventFrame = (txid: string, tx: string): Uint8Array =>
  grpcFrame(
    Uint8Array.from(lenField(2, Uint8Array.from([...lenField(1, utf8.encode(txid)), ...lenField(5, utf8.encode(tx))]))),
  )

/** A heartbeat — normal traffic the caller must never see. */
const heartbeatFrame = (): Uint8Array => grpcFrame(Uint8Array.from(lenField(1, Uint8Array.from([]))))

/** A transport that yields these chunks once, then ends. */
const yielding = (chunks: Uint8Array[]): GrpcTransport =>
  async function* () {
    for (const chunk of chunks) yield chunk
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

/**
 * A stream whose every attempt fails, unless `override` supplies one that does
 * not. Driven on fake timers, so the reconnect waits are exact rather than raced.
 */
const driveFailing = (
  override?: (call: number, args: Parameters<GrpcTransport>) => ReturnType<GrpcTransport> | null,
) => {
  let calls = 0
  const transport: GrpcTransport = (...args) => {
    calls += 1
    return (
      override?.(calls, args) ??
      (async function* () {
        throw new Error('arkd subscription failed: 503')
      })()
    )
  }
  const controller = new AbortController()
  const drained = (async () => {
    for await (const item of streamOfferTxs({
      arkdUrl: url,
      transport,
      signal: controller.signal,
      reconnectMinMs: MIN_MS,
      reconnectMaxMs: 10_000,
      onError: () => {},
    }))
      void item
  })()
  return {
    attempts: () => calls,
    signal: controller.signal,
    stop: async () => {
      controller.abort()
      await vi.advanceTimersByTimeAsync(MIN_MS)
      await drained
    },
  }
}

describe('streamOfferTxs', () => {
  it('asks arkd for offer packets by default', async () => {
    const transport = vi.fn(yielding([eventFrame('a', 'tx-a')]))
    const signal = AbortSignal.timeout(2_000)
    await collect(streamOfferTxs({ arkdUrl: url, transport, signal }), 1)
    const body = transport.mock.calls[0]![1] as Uint8Array
    expect(new TextDecoder().decode(body)).toContain(OFFER_PACKET_FILTER)
  })

  it('targets the IndexerService path', async () => {
    const transport = vi.fn(yielding([eventFrame('a', 'tx-a')]))
    const signal = AbortSignal.timeout(2_000)
    await collect(streamOfferTxs({ arkdUrl: `${url}/`, transport, signal }), 1)
    expect(transport.mock.calls[0]![0]).toBe(`${url}/ark.v1.IndexerService/GetSubscription`)
  })

  it('yields transactions and swallows heartbeats', async () => {
    const transport = vi.fn(yielding([heartbeatFrame(), eventFrame('a', 'tx-a'), eventFrame('b', 'tx-b')]))
    const signal = AbortSignal.timeout(2_000)
    const got = await collect(streamOfferTxs({ arkdUrl: url, transport, signal }), 2)
    expect(got).toEqual([
      { txid: 'a', tx: 'tx-a' },
      { txid: 'b', tx: 'tx-b' },
    ])
  })

  it('reassembles a frame split across chunks', async () => {
    // Frames do not align with chunk boundaries; a reader that assumed they did
    // would drop the end of every large event. A real one measured 1396 bytes.
    const whole = eventFrame('split', 'tx-split')
    const transport = vi.fn(yielding([whole.subarray(0, 6), whole.subarray(6)]))
    const signal = AbortSignal.timeout(2_000)
    const got = await collect(streamOfferTxs({ arkdUrl: url, transport, signal }), 1)
    expect(got).toEqual([{ txid: 'split', tx: 'tx-split' }])
  })

  it('RECONNECTS after the stream ends, rather than going quietly deaf', async () => {
    let call = 0
    const transport: GrpcTransport = (...args) => {
      call += 1
      return call === 1 ? yielding([])(...args) : yielding([eventFrame('after', 'tx-after')])(...args)
    }
    const signal = AbortSignal.timeout(3_000)
    const got = await collect(streamOfferTxs({ arkdUrl: url, transport, signal, reconnectMinMs: 1 }), 1)
    expect(got).toEqual([{ txid: 'after', tx: 'tx-after' }])
    expect(call).toBeGreaterThan(1)
  })

  it('reports a refused subscription and retries', async () => {
    const errors: unknown[] = []
    let call = 0
    const transport: GrpcTransport = (...args) => {
      call += 1
      if (call === 1) {
        return (async function* () {
          throw new Error('arkd subscription failed: 503')
        })()
      }
      return yielding([eventFrame('ok', 'tx-ok')])(...args)
    }
    const signal = AbortSignal.timeout(3_000)
    const got = await collect(
      streamOfferTxs({ arkdUrl: url, transport, signal, reconnectMinMs: 1, onError: (e) => void errors.push(e) }),
      1,
    )
    expect(got).toEqual([{ txid: 'ok', tx: 'tx-ok' }])
    expect(String(errors[0])).toContain('503')
  })

  it('LENGTHENS the wait between failed reconnects, rather than hammering arkd', async () => {
    vi.useFakeTimers()
    try {
      const { attempts, stop } = driveFailing()
      await vi.advanceTimersByTimeAsync(0)
      expect(attempts()).toBe(1)
      await vi.advanceTimersByTimeAsync(MIN_MS)
      expect(attempts()).toBe(2)
      // The second wait has to exceed the first, so another `MIN_MS` buys nothing.
      await vi.advanceTimersByTimeAsync(MIN_MS)
      expect(attempts()).toBe(2)
      await stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('and drops back to the shortest wait once a stream has delivered', async () => {
    vi.useFakeTimers()
    try {
      const { attempts, stop } = driveFailing((call, args) =>
        call === 2 ? yielding([eventFrame('a', 'tx-a')])(...args) : null,
      )
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(MIN_MS)
      expect(attempts()).toBe(2)
      await vi.advanceTimersByTimeAsync(MIN_MS)
      expect(attempts()).toBe(3)
      await stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('frees each wait, instead of piling an abort listener up per reconnect', async () => {
    vi.useFakeTimers()
    try {
      const { attempts, signal, stop } = driveFailing()
      await vi.advanceTimersByTimeAsync(0)
      for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(MIN_MS * 2 ** i)
      expect(attempts()).toBeGreaterThan(4)
      expect(getEventListeners(signal, 'abort').length).toBeLessThanOrEqual(2)
      await stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    const transport = vi.fn(yielding([]))
    const out = []
    for await (const item of streamOfferTxs({ arkdUrl: url, transport, signal: controller.signal })) {
      out.push(item)
    }
    expect(out).toEqual([])
    expect(transport).not.toHaveBeenCalled()
  })
})
