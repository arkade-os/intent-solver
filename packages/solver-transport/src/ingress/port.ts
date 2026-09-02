/**
 * Lifecycle seam for a long-lived, outbound ingress.
 *
 * The money path (`SendSwapService`) does not care how a swap request arrived —
 * it only ever sees `quote(invoice, refundAddress)` — and the payloads both
 * transports carry are defined once in `src/wire/`. This interface adds only the
 * `start`/`stop` lifecycle that a persistent OUTBOUND connection needs, which is
 * why `RelayIngress` implements it and the HTTP host does not: the Hono app
 * (`buildApp`) is request/response with no lifecycle of its own, and must also
 * run on Workers with no process at all. The shared logic between the two hosts
 * is the wire payloads, not a start/stop lifecycle — so there is deliberately no
 * `HttpIngress`.
 */
export interface SwapIngress {
  /** Begin reading swap requests off the connection. Resolves once ready. */
  start(): Promise<void>
  /** Stop and release the transport. */
  stop(): Promise<void>
}
