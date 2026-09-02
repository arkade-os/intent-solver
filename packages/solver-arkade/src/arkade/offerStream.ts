/**
 * Offers, off arkd's filtered transaction stream.
 *
 * The discovery half of the taker: an offer rides in its funding transaction's
 * Arkade-extension OP_RETURN as packet type 3, at the MAKER's script — which
 * this wallet does not own and cannot know in advance. That rules out
 * `subscribeForScripts`, the only subscription the TS SDK exposes, and is why
 * this speaks gRPC directly. @see grpcWire.ts
 *
 * Reconnects, because the alternative is a solver that goes quietly deaf. arkd
 * heartbeats the stream, so silence past `staleMs` means a half-open
 * connection rather than an idle market.
 */
import http2 from 'node:http2'
import { encodeSubscriptionRequest, grpcFrame, readFrames, decodeSubscriptionResponse } from './grpcWire.js'

/** Matches any transaction carrying an offer packet. Evaluated by arkd. */
export const OFFER_PACKET_FILTER = 'has(tx.extension) && hasPacket(tx.extension, 3)'

/** One request's response chunks. Injectable so tests need no arkd. */
export type GrpcTransport = (url: string, body: Uint8Array, signal: AbortSignal) => AsyncIterable<Uint8Array>

/**
 * gRPC over HTTP/2, which is what arkd actually requires.
 *
 * `fetch` is not an option against a direct arkd: undici speaks HTTP/1.1 and
 * arkd answers a gRPC POST with `505 HTTP Version Not Supported`. It appears to
 * work against a proxied endpoint only because something like Cloudflare
 * terminates h1 and speaks h2 upstream. `node:http2` covers both — h2c to a
 * local arkd, h2 over TLS to a hosted one — and is built in.
 */
export const http2Transport: GrpcTransport = async function* (url, body, signal) {
  const target = new URL(url)
  const client = http2.connect(target.origin)
  const request = client.request({
    ':method': 'POST',
    ':path': target.pathname,
    'content-type': 'application/grpc',
    te: 'trailers',
  })
  const onAbort = (): void => {
    request.close()
    client.close()
  }
  signal.addEventListener('abort', onAbort)
  try {
    let status = 0
    request.on('response', (headers) => void (status = Number(headers[':status'] ?? 0)))
    request.end(Buffer.from(body))
    for await (const chunk of request as unknown as AsyncIterable<Buffer>) {
      if (status !== 0 && status !== 200) throw new Error(`arkd subscription failed: ${status}`)
      yield new Uint8Array(chunk)
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    client.close()
  }
}

export interface OfferStreamDeps {
  /** arkd's base URL — the same host the REST indexer is on. */
  arkdUrl: string
  /** Defaults to offers only. */
  expressions?: readonly string[]
  /** Silence longer than this means half-open, not idle. arkd beats every 60s. */
  staleMs?: number
  /** Bounds how long the stream stays down once arkd is reachable again. */
  reconnectMinMs?: number
  reconnectMaxMs?: number
  onError?: (error: unknown) => void
  signal?: AbortSignal
  transport?: GrpcTransport
}

/** A transaction arkd matched, still encoded as it sent it. */
export interface OfferTx {
  txid: string
  tx: string
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

/**
 * Every transaction matching the filter, until `signal` aborts.
 *
 * Yields only events carrying a tx: heartbeats and the subscription-started
 * message are normal traffic and are consumed silently.
 */
export async function* streamOfferTxs(deps: OfferStreamDeps): AsyncGenerator<OfferTx> {
  const transport = deps.transport ?? http2Transport
  const expressions = deps.expressions ?? [OFFER_PACKET_FILTER]
  const staleMs = deps.staleMs ?? 180_000
  const minMs = deps.reconnectMinMs ?? 1_000
  const maxMs = deps.reconnectMaxMs ?? 10_000
  const url = `${deps.arkdUrl.replace(/\/+$/, '')}/ark.v1.IndexerService/GetSubscription`
  let backoff = minMs

  while (!deps.signal?.aborted) {
    // Per attempt, so a stalled stream is torn down without ending the caller's.
    const attempt = new AbortController()
    const onAbort = (): void => attempt.abort()
    deps.signal?.addEventListener('abort', onAbort)
    let watchdog = setTimeout(() => attempt.abort(), staleMs)

    try {
      const chunks = transport(url, grpcFrame(encodeSubscriptionRequest(expressions)), attempt.signal)
      backoff = minMs

      // `ArrayBufferLike`, because `readFrames` hands back a subarray view and
      // a narrower annotation rejects it.
      let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
      for await (const chunk of chunks) {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => attempt.abort(), staleMs)

        const merged = new Uint8Array(buffer.length + chunk.length)
        merged.set(buffer)
        merged.set(chunk, buffer.length)
        const { messages, rest } = readFrames(merged)
        buffer = rest
        for (const message of messages) {
          const event = decodeSubscriptionResponse(message)
          if (event !== null && event.tx !== '') yield event
        }
      }
    } catch (error) {
      if (deps.signal?.aborted) return
      deps.onError?.(error)
    } finally {
      clearTimeout(watchdog)
      deps.signal?.removeEventListener('abort', onAbort)
    }

    if (deps.signal?.aborted) return
    await sleep(backoff, deps.signal)
    backoff = Math.min(backoff * 2, maxMs)
  }
}
