/**
 * Offers, off arkd's filtered transaction stream.
 *
 * The discovery half of the taker: an offer rides in its funding transaction's
 * Arkade-extension OP_RETURN as packet type 3, at the MAKER's script — which
 * this wallet does not own and cannot know in advance. So it is matched by a
 * CEL filter arkd evaluates, via `getFilteredSubscription`, not by script.
 *
 * Reconnects, because the alternative is a solver that goes quietly deaf. arkd
 * heartbeats the stream, so silence past `STALE_MS` means a half-open
 * connection rather than an idle market.
 */
import { RestIndexerProvider, isEventSourceUnavailableError, type IndexerProvider } from '@arkade-os/sdk'

/** Matches any transaction carrying an offer packet. Evaluated by arkd. */
export const OFFER_PACKET_FILTER = 'has(tx.extension) && hasPacket(tx.extension, 3)'

/** Silence longer than this means half-open, not idle: arkd beats every 60s. */
const STALE_MS = 180_000

/** One connection attempt. Injectable so tests need no arkd. */
export type FilteredSubscribe = IndexerProvider['getFilteredSubscription']

export interface OfferStreamDeps {
  /** arkd's base URL — the same host the REST indexer is on. */
  arkdUrl: string
  /** Bounds how long the stream stays down once arkd is reachable again. */
  reconnectMinMs?: number
  reconnectMaxMs?: number
  onError?: (error: unknown) => void
  signal?: AbortSignal
  subscribe?: FilteredSubscribe
}

/** A transaction arkd matched, still encoded as it sent it. */
export interface OfferTx {
  txid: string
  tx: string
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    // Removed on BOTH exits: `signal` outlives this wait by the whole process,
    // so a listener left behind on each reconnect grows without bound.
    let timer: ReturnType<typeof setTimeout>
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done)
  })

const restSubscribe = (arkdUrl: string): FilteredSubscribe => {
  const indexer = new RestIndexerProvider(arkdUrl.replace(/\/+$/, ''))
  return (filter, signal) => indexer.getFilteredSubscription(filter, signal)
}

/**
 * Every transaction matching the filter, until `signal` aborts.
 *
 * Yields only events carrying a tx: heartbeats are normal traffic and are
 * consumed silently, after re-arming the watchdog.
 */
export async function* streamOfferTxs(deps: OfferStreamDeps): AsyncGenerator<OfferTx> {
  const subscribe = deps.subscribe ?? restSubscribe(deps.arkdUrl)
  const minMs = deps.reconnectMinMs ?? 1_000
  const maxMs = deps.reconnectMaxMs ?? 10_000
  let backoff = minMs

  while (!deps.signal?.aborted) {
    // Per attempt, so a stalled stream is torn down without ending the caller's.
    const attempt = new AbortController()
    const onAbort = (): void => attempt.abort()
    deps.signal?.addEventListener('abort', onAbort)
    let stale = false
    const arm = () =>
      setTimeout(() => {
        stale = true
        attempt.abort()
      }, STALE_MS)
    let watchdog = arm()

    try {
      for await (const message of subscribe({ expressions: [OFFER_PACKET_FILTER] }, attempt.signal)) {
        // Reset on DELIVERY, never on the call: the iterator connects lazily.
        backoff = minMs
        clearTimeout(watchdog)
        watchdog = arm()
        if (message.type === 'event' && message.txid && message.tx) yield { txid: message.txid, tx: message.tx }
      }
      if (stale) deps.onError?.(new Error(`no frame from arkd in ${STALE_MS / 1000}s, reconnecting`))
    } catch (error) {
      if (deps.signal?.aborted) return
      deps.onError?.(error)
      // An environment fact, not a stream failure: retrying cannot fix it.
      if (isEventSourceUnavailableError(error)) return
    } finally {
      clearTimeout(watchdog)
      deps.signal?.removeEventListener('abort', onAbort)
    }

    if (deps.signal?.aborted) return
    await sleep(backoff, deps.signal)
    backoff = Math.min(backoff * 2, maxMs)
  }
}
