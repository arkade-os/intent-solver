/**
 * Relay ingress: swap requests read off an outbound connection.
 *
 * The provider subscribes to the relay for `rfq_request` events addressed to
 * its own pubkey, quotes each through the SAME corridor services the HTTP host
 * uses, and publishes the reply — a quote or a refusal — back to the relay,
 * addressed to whoever sent the request. It opens no port.
 *
 * The payloads on the wire are byte-for-byte the HTTP bodies: this is the
 * message-bus transport the HTTP layer was always a scaffold for, so a client
 * that spoke HTTP speaks relay by changing only where it sends the same JSON.
 *
 * Idempotency is a property of the request, not the transport. Relays redeliver;
 * a redelivered request for a payment hash we have already quoted must not mint a
 * second swap. The store's UNIQUE payment_hash guarantees that, and the shared
 * RFQ handler turns it into a *useful* redelivery: we re-publish the EXISTING
 * quote, so a client that missed our first reply recovers it by asking again.
 */

import type { RelayConnection, RelayEvent, RelaySubscription } from '../relay/connection.js'
import { eventId } from '../relay/connection.js'
import { rfqRefusalPayload } from '@arkade-os/solver-core/core/rfqProtocol.js'
import { respondToRfqRequest, respondToRfqStatus } from './rfq.js'
import { reportRfqRefusal, type RfqRefusalObserver } from './refusals.js'
import type { CorridorReaderSet, CorridorSet } from '@arkade-os/solver-core/core/corridor.js'

/** Publish a payload addressed to one recipient — the reply shape both
 * ingress classes share. */
const publishTo = async (
  connection: RelayConnection,
  author: string,
  recipient: string,
  payload: Record<string, unknown>,
  nowMs: number,
): Promise<void> => connection.publish({ id: eventId(author, nowMs), author, recipient, createdAtMs: nowMs, payload })

export interface RelayIngressDeps {
  /**
   * The corridors this ingress serves, already assembled — see
   * {@link HttpDeps.corridors}, same contract and the same reason.
   */
  corridors: CorridorSet
  /** Status readers — wider than quoting; see `respondToRfqStatus`. */
  readers: CorridorReaderSet
  connection: RelayConnection
  /** The provider's x-only pubkey, hex — the address clients send offers to. */
  providerPubkey: string
  /** Emitted for observability; never throws into the loop. */
  onError?: (context: string, error: unknown) => void
  /**
   * A request the solver turned away, and why — the log's only copy.
   *
   * Separate from {@link onError} because a refusal is not a fault: the closed
   * vocabulary answers the client correctly and nothing threw, so `onError`
   * never fired and the service printed nothing at all. Six distinct faults on
   * the Lightning send leg alone reach a client as `unsupported_payload`, and
   * with no line here an operator cannot tell which fired without the client's
   * own payload. Diagnostic only: whether to answer, and with what, is decided
   * long before this is called.
   */
  onRefusal?: RfqRefusalObserver
  onQuoteTiming?: (sample: { rfqRef?: string; quoteMs: number; publishMs: number; outcome: string }) => void
  now?: () => number
}

export class RelayIngress {
  private readonly now: () => number
  private subscription?: RelaySubscription

  constructor(private readonly deps: RelayIngressDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  async start(): Promise<void> {
    // `sinceMs` is stated here, not left to the transport, for the same reason
    // OpenRfqBidder states its own: what counts as too stale to answer is an
    // ingress fact. A request older than this has no client behind it — the
    // reference wallet stops waiting after 30 s — and answering one costs a
    // verify, a decrypt and a signed reply to nobody.
    this.subscription = await this.deps.connection.subscribe(
      { recipient: this.deps.providerPubkey, sinceMs: this.now() },
      (event) => this.handle(event),
    )
  }

  async stop(): Promise<void> {
    await this.subscription?.close()
    await this.deps.connection.close()
  }

  /** One inbound event. Never throws — a bad request must not kill the loop. */
  private async handle(event: RelayEvent): Promise<void> {
    try {
      const type = (event.payload as { type?: unknown } | null)?.type

      // The RFQ family — the only family. The shared handler owns validation,
      // idempotent re-emit and the closed refusal set; the reply goes back in
      // the family the request arrived in.
      if (type === 'rfq_request') {
        const quoteStarted = performance.now()
        // A THROW is still an answer owed: an immediate `pricing_unavailable` beats a client waiting out its 30 s
        // timeout. Only for a parsed `rfq_request` with an id; stray events stay silent on a shared relay.
        const rfqId = (event.payload as { rfq_id?: unknown } | null)?.rfq_id
        let outcome
        try {
          outcome = await respondToRfqRequest(this.deps.corridors, event.payload, { requesterKey: event.author })
        } catch (error) {
          this.deps.onError?.('relay quote', error)
          if (typeof rfqId === 'string') {
            const quoteMs = Math.round(performance.now() - quoteStarted)
            const payload = rfqRefusalPayload(rfqId, 'pricing_unavailable')
            await this.publishTimed(event.author, payload, 'pricing_unavailable', quoteMs, rfqId.slice(0, 12))
          }
          return
        }
        const quoteMs = Math.round(performance.now() - quoteStarted)
        reportRfqRefusal(this.deps.onRefusal, 'relay', 'rfq_request', outcome)
        const rfqRef = typeof rfqId === 'string' ? rfqId.slice(0, 12) : undefined
        await this.publishTimed(event.author, outcome.payload, outcome.kind, quoteMs, rfqRef)
        return
      }
      if (type === 'rfq_status_request') {
        const outcome = await respondToRfqStatus(this.deps.readers, event.payload)
        reportRfqRefusal(this.deps.onRefusal, 'relay', 'rfq_status_request', outcome)
        await this.reply(event.author, outcome.payload)
        return
      }
      // Anything else — a reply echoed back, another protocol's event, the
      // removed pre-RFQ `ln_send_*` shape — is ignored silently: scolding
      // every stray event on a shared relay would be noise.
    } catch (error) {
      this.deps.onError?.('relay handle', error)
    }
  }

  private async reply(recipient: string, payload: Record<string, unknown>): Promise<void> {
    await publishTo(this.deps.connection, this.deps.providerPubkey, recipient, payload, this.now())
  }

  private async publishTimed(
    recipient: string,
    payload: Record<string, unknown>,
    outcome: string,
    quoteMs: number,
    rfqRef: string | undefined,
  ): Promise<void> {
    const publishStarted = performance.now()
    await this.reply(recipient, payload)
    try {
      this.deps.onQuoteTiming?.({ rfqRef, quoteMs, publishMs: Math.round(performance.now() - publishStarted), outcome })
    } catch {}
  }
}
