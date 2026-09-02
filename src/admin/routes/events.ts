/**
 * The SSE stream the console repaints from.
 *
 * SSE rather than a WebSocket because the traffic is one-directional — the
 * client never pushes — and SSE reconnects on its own with no framing, no
 * upgrade handshake and no dependency. Every mutation still goes through a
 * plain POST, where the confirmation gate lives.
 */

import type { Hono } from 'hono'
import type { AdminDeps } from '../server.js'

/** How often to send a comment line when nothing has changed. */
const KEEPALIVE_MS = 20_000

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

export const registerEventRoutes = (app: Hono, deps: AdminDeps): void => {
  app.get('/api/events', (c) => {
    const feed = deps.changes
    if (!feed) return c.json({ error: 'unavailable', message: 'no change feed on this host' }, 503)

    const encoder = new TextEncoder()
    let unsubscribe: (() => void) | undefined
    let keepalive: ReturnType<typeof setInterval> | undefined

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string): void => {
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            // The client went away between the change firing and this write.
            // Nothing to do but stop pushing at it.
            cleanup()
          }
        }
        const cleanup = (): void => {
          unsubscribe?.()
          unsubscribe = undefined
          if (keepalive) clearInterval(keepalive)
          keepalive = undefined
        }

        // An immediate frame so the client knows the stream is live rather than
        // merely accepted — the same "am I actually connected" question the
        // relay probe exists to answer, one layer up.
        send(frame('hello', { mode: deps.mode }))

        unsubscribe = feed.subscribe((changes) => send(frame('swaps', { changes })))

        // A comment line, not an event: it keeps proxies from reaping an idle
        // connection without the client having to filter heartbeat frames.
        keepalive = setInterval(() => send(': keepalive\n\n'), KEEPALIVE_MS)
        keepalive.unref?.()

        c.req.raw.signal.addEventListener('abort', () => {
          cleanup()
          try {
            controller.close()
          } catch {
            // Already closed by the runtime; the listeners are what mattered.
          }
        })
      },
      cancel() {
        unsubscribe?.()
        if (keepalive) clearInterval(keepalive)
      },
    })

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        // Nginx buffers by default, which turns a live stream into nothing at
        // all until the buffer fills. The reverse proxy in front of this port
        // is the deployment's own, so the hint has to be on the response.
        'x-accel-buffering': 'no',
      },
    })
  })
}
