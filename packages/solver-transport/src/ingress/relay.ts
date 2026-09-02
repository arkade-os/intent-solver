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

import type { Limits } from '@arkade-os/solver-core/core/limits.js'
import { FREE, type Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import {
  defaultBidding,
  tokenBucket,
  type BiddingStrategy,
  type TokenBucket,
} from '@arkade-os/solver-core/core/openRfq.js'
import { marketKeyForPair } from '@arkade-os/solver-core/core/marketKey.js'
import type { RelayConnection, RelayEvent, RelaySubscription } from '../relay/connection.js'
import { eventId } from '../relay/connection.js'
import { RfqOpen, rfqBidPayload, rfqRefusalPayload } from '@arkade-os/solver-core/core/rfqProtocol.js'
import { respondToRfqRequest, respondToRfqStatus } from './rfq.js'
import type { CorridorReaderSet, CorridorSet } from '@arkade-os/solver-core/core/corridor.js'
import type { SwapIngress } from './port.js'

/** Publish a payload addressed to one recipient — the reply shape both
 * ingress classes share. */
const publishTo = async (
  connection: RelayConnection,
  author: string,
  recipient: string,
  payload: Record<string, unknown>,
  nowMs: number,
): Promise<void> =>
  connection.publish({ id: eventId(author, payload, nowMs), author, recipient, createdAtMs: nowMs, payload })

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
  onRefusal?: (context: string, detail: string) => void
  now?: () => number
}

export interface OpenRfqBidderDeps {
  connection: RelayConnection
  /** The solver's x-only pubkey, hex — the author of every bid. */
  providerPubkey: string
  /**
   * The directional pair this bidder serves — the one it subscribes for, the
   * one it validates opens against, and the one its bids claim. Injected so
   * all three can never disagree, and so a second market is a second bidder
   * rather than an edit to this class.
   */
  pair: string
  limits: Limits
  /**
   * What the served corridor charges. Omitted means free.
   *
   * A bid quotes a `to_amount` derived from this, so a bid that understates the
   * fee is a promise the quote will not keep. See {@link OpenRfqBidder} for
   * what happens when the fee cannot be expressed in a bid at all.
   */
  fee?: Fee
  /**
   * How this bidder decides. Absent means § 4.6's rules as `decideOpenRfqBid`
   * implements them — what every deployment used before bidding was injectable.
   *
   * The silence rule and the rate limit are enforced around this, not by it.
   */
  bidding?: BiddingStrategy
  /** MUST be positive — whether to bid at all is the composer's decision. */
  maxBidsPerMinute: number
  onError?: (context: string, error: unknown) => void
  now?: () => number
}

/**
 * Open-RFQ bidding (docs/rfq-protocol.md § 4.6): subscribe to the served
 * market's broadcasts, answer with sealed bids. Deliberately separate from
 * {@link RelayIngress} — bidding touches no swap state, so it composes (and
 * tests) without the swap stack, and it never owns the shared connection.
 */
export class OpenRfqBidder {
  private readonly now: () => number
  private subscription?: RelaySubscription
  private readonly bidBucket: TokenBucket

  constructor(private readonly deps: OpenRfqBidderDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.bidBucket = tokenBucket(deps.maxBidsPerMinute, this.now())
  }

  async start(): Promise<void> {
    // sinceMs ≈ now is the § 4.6 freshness rule: without it, subscription
    // replay after every reconnect would hand us the relay's stored backlog
    // of stale opens.
    // KNOWN: EVM pairs cannot reach here. `marketKeyForPair` resolves a leg's
    // asset through the § 2 ticker registry, and an EVM pair names its token by
    // ADDRESS (`ethereum:0x…`) — so it throws rather than deriving a key. Today
    // that is unreachable because `deps.pair` is the Lightning send pair, fixed
    // at the composition root; widening it to the EVM corridors needs the two
    // grammars reconciled first, which is the open question in arkade-os/meta#19
    // (Q10). Wiring them in without that lands a throw here, or — if the throw
    // is softened — a subscription to a market nobody publishes to, which is the
    // silent miss `marketKey.ts` exists to prevent.
    this.subscription = await this.deps.connection.subscribe(
      { topic: marketKeyForPair(this.deps.pair), sinceMs: this.now() },
      (event) => this.handleOpenRfq(event),
    )
  }

  /** Closes only its own subscription; the connection belongs to the composer. */
  async stop(): Promise<void> {
    await this.subscription?.close()
  }

  /**
   * One open-RFQ broadcast. Every failure path is SILENCE — never a refusal
   * (§ 4.6) — and never a throw. The token is taken only when we actually
   * bid: a flood of unserved opens costs us a pure-function evaluation each,
   * not our bidding budget.
   */
  private async handleOpenRfq(event: RelayEvent): Promise<void> {
    try {
      const parsed = RfqOpen.safeParse(event.payload)
      if (!parsed.success) return
      const fee = this.deps.fee ?? FREE
      // Both price components go to the bid. A flat fee used to mean not
      // bidding at all, because the bid could carry `fee_bps` and nothing
      // else, so bidding would have advertised a better rate than the quote
      // would honour. § 4.6 carries `fee_flat` now, so the corridor can bid
      // honestly instead of declining silently.
      const decision = (this.deps.bidding ?? defaultBidding).decide({
        open: parsed.data,
        eventCreatedAtMs: event.createdAtMs,
        servedPair: this.deps.pair,
        limits: this.deps.limits,
        feeBps: fee.bps,
        feeFlat: fee.flatSats,
        nowMs: this.now(),
      })
      if (decision.kind === 'skip') return
      if (!this.bidBucket.take(this.now())) return
      await publishTo(
        this.deps.connection,
        this.deps.providerPubkey,
        event.author,
        rfqBidPayload(parsed.data.open_id, this.deps.pair, decision),
        this.now(),
      )
    } catch (error) {
      this.deps.onError?.('open-rfq handle', error)
    }
  }
}

export class RelayIngress implements SwapIngress {
  private readonly now: () => number
  private subscription?: RelaySubscription
  /**
   * Held once at construction rather than looked up per event. Assembly — and
   * with it the pair/stem collision check, a composition-time fault rather than
   * one to rediscover per quote — happens in `src/ops/corridorSet.ts`, before
   * this is ever constructed.
   */
  private readonly corridors: CorridorSet
  private readonly readers: CorridorReaderSet

  constructor(private readonly deps: RelayIngressDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.corridors = deps.corridors
    this.readers = deps.readers
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
        // A THROW here is still an answer owed. Observed on mainnet: a
        // Lightning-receive quote died inside `createHoldInvoice` on a
        // transport fault, this handler logged it and returned, and the client
        // waited out its own 30s timeout for a reply that was never coming.
        //
        // The closed set already has the word for it. `pricing_unavailable` is
        // what the corridor says when it cannot serve a request right now, and
        // that is exactly true of a backend that would not answer — an
        // immediate honest decline costs the client nothing and lets them
        // retry or go elsewhere.
        //
        // Deliberately narrow: only this branch, and only after the request
        // parsed as an `rfq_request` carrying an id to answer. A stray event
        // is still ignored in silence, because scolding every event on a shared
        // relay is the noise this handler already declines to make.
        const rfqId = (event.payload as { rfq_id?: unknown } | null)?.rfq_id
        let outcome
        try {
          outcome = await respondToRfqRequest(this.corridors, event.payload, { requesterKey: event.author })
        } catch (error) {
          this.deps.onError?.('relay quote', error)
          if (typeof rfqId === 'string') {
            await this.reply(event.author, rfqRefusalPayload(rfqId, 'pricing_unavailable'))
          }
          return
        }
        if (outcome.kind !== 'quote' && outcome.detail) {
          this.deps.onRefusal?.('relay refused', `${outcome.kind}: ${outcome.detail}`)
        }
        await this.reply(event.author, outcome.payload)
        return
      }
      if (type === 'rfq_status_request') {
        const outcome = await respondToRfqStatus(this.readers, event.payload)
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
}
