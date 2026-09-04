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
  /**
   * A request that FAULTED — separate from {@link onRefusal} for the same
   * reason `RelayIngressDeps` splits them: a refusal is the closed vocabulary
   * answering correctly with nothing thrown, while this is something that
   * should not have happened. Folding the two would bury a fault in the log an
   * operator scans for ordinary business.
   */
  onError?: (context: string, error: unknown) => void
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
        let outcome
        try {
          outcome = await respondToRfqRequest(corridors, body, { requesterKey: deps.clientKey?.(c) })
        } catch (error) {
          // The relay arm of this same handler has always caught here
          // (`ingress/relay.ts`); this one did not, so an unexpected throw fell
          // through to the framework's default and answered a bare 500 with no
          // body. Two transports the comment above calls byte-for-byte
          // identical disagreed about what a failure IS, and the operator's
          // refusal log had no record of it either.
          //
          // `pricing_unavailable` because the reason vocabulary is CLOSED: a
          // client may only branch on reasons the protocol names, and from its
          // side an unexpected fault and a pricing failure are the same event —
          // no quote, try later. Inventing an `internal_error` reason here
          // would put a word on the wire that no schema on either side knows.
          //
          // 422, not 500, and the envelope is this transport's own decision
          // (see above): every other refusal on this path is a 422, so a client
          // already reads the body at that status. A 500 would be more candid
          // about whose fault it is and would cost the client the reason, since
          // 5xx is exactly what a caller treats as "no body worth parsing".
          deps.onError?.('http quote', error)
          const rfqId = (body as { rfq_id?: unknown }).rfq_id
          return c.json(rfqRefusalPayload(typeof rfqId === 'string' ? rfqId : undefined, 'pricing_unavailable'), 422)
        }
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
    let outcome
    try {
      outcome = await respondToRfqStatus(readers, { v: 1, type: 'rfq_status_request', rfq_id: rfqId })
    } catch (error) {
      // 500, and deliberately NOT the 404 below — that is the whole point of
      // catching here rather than letting this fall through. "We could not
      // read" and "no swap has this id" are different facts, and a store that
      // throws is the case where they are easiest to confuse: a client polling
      // for its own swap would read a 404 as proof the swap does not exist and
      // stop asking, about a swap that may be funded and live. Same discipline
      // as `FundFigure.amount` being nullable rather than zero.
      //
      // The relay's outer handler logs a status throw the same way and simply
      // sends nothing; this transport must answer, so it answers with the one
      // status that does not assert anything about the swap.
      deps.onError?.('http status', error)
      return c.json({ v: 1, type: 'error' }, 500)
    }
    if (outcome.kind === 'unknown') return c.json({ v: 1, type: 'not_found' }, 404)
    return c.json(outcome.payload, outcome.kind === 'invalid' ? 400 : 200)
  })

  return app
}
