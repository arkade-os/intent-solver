/**
 * HTTP host — scaffold for a message-bus transport, and shaped accordingly.
 *
 * Built on Hono so the SAME app runs on Node today and on Cloudflare Workers
 * unchanged: `app.fetch` is the whole runtime contract. Nothing in this module
 * may import Node builtins.
 *
 * The request and response BODIES are the future bus payloads, byte for byte:
 * versioned, typed, self-contained. When the transport moves to the arkd tx
 * stream + relays, the envelope changes and the payloads do not. Nothing in
 * here may leak into the payload shape (no URLs, no HTTP status semantics
 * inside the JSON).
 *
 * Contract with clients, and the reason the quote payload is so small:
 *
 * - A client trusts exactly TWO fields of a quote: `provider_pubkey` and
 *   `refund_locktime`. Everything else it derives itself — preimage hash from
 *   its own invoice, Arkade server key from its own connection, emulator key from
 *   its own fetch, amount from the invoice, refund script from its own wallet.
 * - `lockup_address` is COMPARE-ONLY. A client that funds a server-supplied
 *   address instead of its own derivation is wrong, and a compromised backend
 *   would only have to change one field to redirect funds.
 * - `swap_id` is a convenience for log correlation. It is never a storage key;
 *   identity is the payment hash (equivalently the derived script), which is
 *   why status lookup is keyed by payment hash.
 */

import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { respondToRfqRequest, respondToRfqStatus } from '../ingress/rfq.js'
import type { CorridorReaderSet, CorridorSet } from '@arkade-os/solver-core/core/corridor.js'
import { rfqRefusalPayload } from '@arkade-os/solver-core/core/rfqProtocol.js'

export interface HttpDeps {
  /**
   * The corridors this host serves, assembled by the composition root
   * (`packages/solver-app/src/ops/corridorSet.ts`) — the only place that knows which corridors a
   * deployment has. Being handed a set rather than deriving one is what lets a
   * consumer serve a corridor this build never compiled against.
   */
  corridors: CorridorSet
  /**
   * The corridors this host can report STATUS for, which is deliberately a
   * wider set than the quotable one: built from stores, so a disabled
   * corridor still answers for swaps it quoted before being switched off.
   */
  readers: CorridorReaderSet
  network: string
  /**
   * Requester identity for quote admission control (socket address on Node,
   * CF header on Workers). Supplied by the runtime binding — this module stays
   * runtime-agnostic, so it never reads the connection itself. Unset means
   * unmetered, which is only sane behind a trusted local binding.
   */
  clientKey?: (c: Context) => string
  /** A request this host turned away, and why. See `RelayIngressDeps.onRefusal`. */
  onRefusal?: (context: string, detail: string) => void
}

export const buildApp = (deps: HttpDeps): Hono => {
  const { corridors, readers } = deps
  const app = new Hono()

  app.get('/healthz', (c) => c.json({ ok: true, network: deps.network }))

  // The schemas cap individual fields, but only AFTER the body is parsed —
  // this caps the parse itself. 64 KiB is ~30x the largest legitimate request
  // (a 2048-char invoice plus framing), so no real client ever meets it.
  app.post(
    '/v1/swap',
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json(rfqRefusalPayload(undefined, 'unsupported_payload'), 413) }),
    async (c) => {
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json(rfqRefusalPayload(undefined, 'unsupported_payload'), 400)
      }

      // The RFQ family — the only family. Same payloads as the relay, byte for
      // byte; only the envelope (HTTP status codes) belongs to this transport.
      if ((body as { type?: unknown } | null)?.type === 'rfq_request') {
        const outcome = await respondToRfqRequest(corridors, body, { requesterKey: deps.clientKey?.(c) })
        if (outcome.kind !== 'quote' && outcome.detail) {
          deps.onRefusal?.('http refused', `${outcome.kind}: ${outcome.detail}`)
        }
        return c.json(outcome.payload, outcome.kind === 'quote' ? 201 : outcome.kind === 'invalid' ? 400 : 422)
      }

      // Anything else — including the removed pre-RFQ `ln_send_*` shape — is
      // not a request this host serves.
      return c.json(rfqRefusalPayload(undefined, 'unsupported_payload'), 400)
    },
  )

  // RFQ status by correlation id.
  // Routed through the shared handler so a miss falls through the remaining
  // corridors' stores, same as the relay transport.
  app.get('/v1/rfq/:rfqId', async (c) => {
    const rfqId = c.req.param('rfqId')
    if (!/^[0-9a-f]{64}$/.test(rfqId)) return c.json(rfqRefusalPayload(undefined, 'unsupported_payload'), 400)
    const outcome = await respondToRfqStatus(readers, { v: 1, type: 'rfq_status_request', rfq_id: rfqId })
    if (outcome.kind === 'unknown') return c.json({ v: 1, type: 'not_found' }, 404)
    return c.json(outcome.payload, outcome.kind === 'invalid' ? 400 : 200)
  })

  return app
}
