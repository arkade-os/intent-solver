/**
 * The outbound relay transport.
 *
 * A relay is a pub/sub broker the provider CONNECTS OUT to — it never listens.
 * This is the whole reason the container can be port-less: swap requests arrive
 * over a connection the provider itself opened, not over a socket it accepts.
 *
 * The wire protocol is deliberately behind an interface. `RelayConnection` is
 * relay-agnostic (its shape is close to Nostr's — kinds, an addressed
 * recipient, a signed author — so a Nostr relay is a drop-in), and the concrete
 * `webSocketRelayConnection` speaks whichever dialect its {@link WireCodec}
 * encodes — the Nostr codec (`src/relay/nostr.ts`) in production, the dev
 * broker framing ({@link devCodec}) against `scripts/mock-relay.mjs`.
 * Everything above the codec is transport-independent and unit-tested; only
 * the socket glue is I/O.
 */

/** One message on the bus. `payload` is a versioned bus payload (`v: 1` RFQ family). */
export interface RelayEvent {
  /** Stable id for de-duplication across redelivery. */
  id: string
  /** Who sent it, x-only hex. For a request, the client; for a reply, the provider. */
  author: string
  /** Who it is addressed to, x-only hex (Nostr's p-tag). Undefined = broadcast. */
  recipient?: string
  /**
   * Broadcast topic: the canonical market key of an open RFQ (Nostr's t-tag,
   * docs/rfq-protocol.md § 4.6). Undefined for directed traffic.
   */
  topic?: string
  /** Unix milliseconds the sender stamped. Used only for `since` filtering. */
  createdAtMs: number
  payload: unknown
}

/** What a subscriber wants delivered. */
export interface RelayFilter {
  /** Only events addressed to this pubkey. */
  recipient?: string
  /** Only events carrying exactly this topic. */
  topic?: string
  /** Only events at or after this time, unix ms. */
  sinceMs?: number
}

export interface RelaySubscription {
  close(): Promise<void>
}

/**
 * Something the relay said about OUR traffic that is not a delivered event.
 *
 * Every dialect has these — NIP-01's `OK`/`CLOSED`/`NOTICE`, the dev broker's
 * nothing-at-all — and dropping them is how a relay that is refusing our
 * events or has torn down our subscription looks EXACTLY like a relay with
 * nothing to say. That failure is silent, permanent, and indistinguishable
 * from an idle market, which is the worst shape an operator can be handed.
 */
export interface RelayNotice {
  /**
   * `rejected` and `subscription-closed` are the actionable ones: the first
   * means an event we published was refused, the second that we are deaf on a
   * filter we still believe is live.
   */
  kind: 'accepted' | 'rejected' | 'subscription-closed' | 'notice'
  /** The event id (`OK`) or subscription id (`CLOSED`) the relay named. */
  ref?: string
  /** The relay's own words. Verbatim — it is usually the whole diagnosis. */
  message?: string
}

export interface RelayConnection {
  /** Send an event to the relay for delivery to matching subscribers. */
  publish(event: RelayEvent): Promise<void>
  /** Ask the relay to stream matching events to `onEvent`. Outbound; no port. */
  subscribe(filter: RelayFilter, onEvent: (event: RelayEvent) => void | Promise<void>): Promise<RelaySubscription>
  /**
   * Is there a live socket right now?
   *
   * The only externally observable liveness a port-less solver has. Reconnect
   * is automatic and unbounded, so a disconnected solver stays up, stays quiet
   * and looks entirely healthy from the outside — which is the failure this
   * whole transport keeps producing. A host that can answer "am I reachable"
   * can finally publish that as a health signal.
   */
  isConnected(): boolean
  close(): Promise<void>
}

/**
 * The dev broker framing's wire type — a minimal generic pub/sub dialect,
 * spoken by `scripts/mock-relay.mjs` and packaged as {@link devCodec}. Kept
 * as pure string<->object functions so they are testable without a socket.
 */
export type RelayFrame =
  { op: 'sub'; id: string; filter: RelayFilter } | { op: 'unsub'; id: string } | { op: 'event'; event: RelayEvent }

export const encodeFrame = (frame: RelayFrame): string => JSON.stringify(frame)

export const decodeFrame = (raw: string): RelayFrame => {
  const value = JSON.parse(raw) as RelayFrame
  if (value.op === 'event') {
    if (typeof value.event?.id !== 'string' || typeof value.event?.author !== 'string') {
      throw new Error('malformed event frame')
    }
  } else if (value.op === 'sub') {
    if (typeof value.id !== 'string' || typeof value.filter !== 'object') throw new Error('malformed sub frame')
  } else if (value.op !== 'unsub') {
    throw new Error(`unknown frame op`)
  }
  return value
}

/** Does an event match a subscriber's filter? Pure — the relay-side test in code. */
export const matchesFilter = (event: RelayEvent, filter: RelayFilter): boolean => {
  if (filter.recipient !== undefined && event.recipient !== filter.recipient) return false
  if (filter.topic !== undefined && event.topic !== filter.topic) return false
  if (filter.sinceMs !== undefined && event.createdAtMs < filter.sinceMs) return false
  return true
}

/**
 * A wire dialect. The connection below owns reconnect, replay and queueing —
 * everything protocol-independent — and delegates the bytes to one of these.
 * Two exist: {@link devCodec} (the broker framing above) and the Nostr codec
 * (`src/relay/nostr.ts`).
 */
export interface WireCodec {
  encodeSub(id: string, filter: RelayFilter): string
  encodeUnsub(id: string): string
  encodeEvent(event: RelayEvent): string
  /**
   * The delivered event, or null for anything else — acks, notices, other
   * protocols' frames, events that fail verification. Null must never throw
   * upward: a relay speaking a dialect we do not is not fatal.
   */
  decodeEvent(raw: string): RelayEvent | null
  /**
   * What the relay said about our own traffic, for frames {@link decodeEvent}
   * returned null for; null for anything not about us.
   *
   * Required, not optional, and `devCodec` answers `null` explicitly. A codec
   * that merely FORGOT this would be indistinguishable from a dialect that
   * genuinely has no such frames, and the failure it hides — a relay refusing
   * every publish, presented as an idle market — is the one this whole
   * mechanism exists to make impossible.
   */
  decodeNotice(raw: string): RelayNotice | null
  /**
   * The filter as this dialect ACTUALLY put it on the wire, when encoding is
   * lossy. Omitted means lossless.
   *
   * The connection filters twice — once at the relay via the encoded
   * subscription, once locally as a safety net against over-delivery — and the
   * two must not disagree. Nostr stamps `created_at` in whole seconds, so it
   * sends `floor(sinceMs / 1000)` and gets `created_at * 1000` back;
   * subscribing at `…000500` and comparing that reconstruction against the raw
   * `sinceMs` drops an event the relay was correctly told to send, a dead
   * window of up to 999 ms after every subscribe and reconnect — landing
   * exactly on the few-second bid window of docs/rfq-protocol.md § 4.6.
   *
   * Reporting the encoded filter rather than describing the transformation
   * (say, as a resolution in ms) keeps ONE implementation of it: the codec
   * applies this function when encoding, so the local filter cannot drift from
   * the wire filter, and a dialect that rounds, clamps to a relay's maximum
   * window, or has no time filter at all can still describe itself.
   */
  effectiveFilter?(filter: RelayFilter): RelayFilter
}

/** The dev broker framing as a codec. */
export const devCodec: WireCodec = {
  encodeSub: (id, filter) => encodeFrame({ op: 'sub', id, filter }),
  encodeUnsub: (id) => encodeFrame({ op: 'unsub', id }),
  encodeEvent: (event) => encodeFrame({ op: 'event', event }),
  decodeEvent: (raw) => {
    try {
      const frame = decodeFrame(raw)
      return frame.op === 'event' ? frame.event : null
    } catch {
      return null
    }
  },
  // The dev broker acks nothing and refuses nothing, so there is no news to
  // report. Stated rather than omitted: this is a fact about the dialect.
  decodeNotice: () => null,
}

/** Notices that mean something is wrong with our traffic, as opposed to acks. */
export const isRelayFault = (notice: RelayNotice): boolean =>
  notice.kind === 'rejected' || notice.kind === 'subscription-closed'

export interface WebSocketRelayOptions {
  /** Injected for tests; defaults to the runtime's global WebSocket. */
  WebSocketCtor?: typeof WebSocket
  /** Backoff schedule between reconnects, ms. A long-lived provider must survive relay blips. */
  reconnectDelaysMs?: number[]
  /** Called on each reconnect so the host can re-log or re-arm. */
  onReconnect?: (attempt: number) => void
  /**
   * Called for everything the relay says about our traffic that is not an
   * event ({@link RelayNotice}). Wire this to a log: a refused event or a
   * torn-down subscription is otherwise invisible.
   */
  onNotice?: (notice: RelayNotice) => void
  /**
   * How far back a reconnect may ask the relay to replay, ms. Defaults to
   * {@link DEFAULT_MAX_REPLAY_MS}. A subscriber that legitimately wants more
   * backfill raises it here rather than being silently truncated.
   */
  maxReplayMs?: number
  now?: () => number
  /** Wire dialect; defaults to the dev broker framing ({@link devCodec}). */
  codec?: WireCodec
}

/**
 * Default ceiling on how far back a reconnect asks the relay to replay.
 *
 * A subscriber's own `sinceMs` is the floor and a first subscribe defaults it
 * to subscribe time, so this is not what stops an unbounded archive request —
 * it caps how much BACKFILL a long-lived connection asks for after a long
 * outage, where the high-water mark has fallen far behind. Measured against
 * strfry, an unbounded replay was served up to the relay's own `max_limit`
 * (500 on nostr.arkade.sh), each event costing a signature verify plus a
 * decrypt, with the ingress then signing a reply to every well-formed one.
 *
 * Two minutes is shorter than any quote's validity: a request older than that
 * has no live client behind it (the reference wallet stops waiting after
 * 30 s). A caller that wants more sets `maxReplayMs`.
 */
export const DEFAULT_MAX_REPLAY_MS = 120_000

/**
 * Fixed safety margin subtracted from the high-water mark when resuming.
 *
 * Deliberately a constant rather than something derived from the codec's wire
 * resolution: it absorbs whatever a dialect's `since` truncates away, but also
 * clock skew between us and the relay, and a relay whose `since` is inclusive
 * of the boundary second. Redelivery is cheap — idempotency is a property of
 * the payload, not the transport — while a gap is a lost request.
 */
const RESUME_OVERLAP_MS = 1_000

/**
 * How long a socket must stay open before the reconnect backoff is considered
 * earned back. Ten seconds of working connection is a relay we can use;
 * anything shorter is flapping, and flapping must escalate rather than reset.
 */
const STABLE_CONNECTION_MS = 10_000

/**
 * Outbound WebSocket relay client.
 *
 * Reconnects on drop and REPLAYS its live subscriptions on the new socket, so a
 * relay restart does not silently stop swap requests arriving. Only outbound: it
 * opens the socket, it never accepts one.
 *
 * The {@link WireCodec} is the swap-point for a specific relay's protocol.
 */
export const webSocketRelayConnection = (url: string, options: WebSocketRelayOptions = {}): RelayConnection => {
  const Ctor = options.WebSocketCtor ?? WebSocket
  const delays = options.reconnectDelaysMs ?? [1000, 2000, 4000, 8000, 16000]
  const now = options.now ?? (() => Date.now())
  const codec = options.codec ?? devCodec

  const maxReplayMs = options.maxReplayMs ?? DEFAULT_MAX_REPLAY_MS

  interface Subscription {
    /** The caller's floor, defaulted to subscribe time. Floor for every replay. */
    filter: RelayFilter & { sinceMs: number }
    /** The filter currently live on the wire, at the codec's wire resolution. */
    armed: RelayFilter
    onEvent: (e: RelayEvent) => void | Promise<void>
    /** Newest event actually delivered on this subscription; 0 until one is. */
    highWaterMs: number
  }
  const subscriptions = new Map<string, Subscription>()
  let socket: WebSocket | undefined
  let closed = false
  let attempt = 0
  let subCounter = 0

  /**
   * Events waiting for a socket. Subscriptions replay from their map on every
   * reconnect, but a published EVENT has no such record — without this queue, a
   * quote published during a reconnect window would vanish while publish()
   * resolved successfully. Bounded so a relay that never comes back cannot grow
   * memory without limit; overflow drops the OLDEST (a client that never got a
   * reply retries, and the retry re-enters the queue).
   */
  const MAX_PENDING_EVENTS = 256
  const pending: RelayEvent[] = []

  const isOpen = (): boolean => socket !== undefined && socket.readyState === socket.OPEN

  const send = (raw: string): boolean => {
    if (!socket || socket.readyState !== socket.OPEN) return false
    socket.send(raw)
    return true
  }

  // Only EVENTS ever queue: subscriptions replay from their map on reconnect,
  // and events are queued in their ABSTRACT form so they hit the codec exactly
  // once, at send time. The open check has to come first for that to be true:
  // encodeEvent signs, and seals directed traffic, which is milliseconds of
  // asymmetric crypto — measured at ~4.6 ms per event — thrown away entirely
  // if the encoding is done only to discover there is no socket for it.
  const sendOrQueue = (event: RelayEvent): void => {
    if (isOpen() && send(codec.encodeEvent(event))) return
    pending.push(event)
    if (pending.length > MAX_PENDING_EVENTS) pending.shift()
  }

  /**
   * Arm a subscription for the socket it is about to go out on: compute the
   * `since` it should carry now, record what the wire will actually express
   * for the local safety net, and return the filter to encode.
   *
   * A subscription is created once and re-sent on every reconnect, so the
   * `since` it carries must move with time rather than staying frozen at the
   * moment subscribe() was called. Resume from the newest event we actually
   * saw (minus an overlap for wire-stamp truncation), never earlier than the
   * caller's own floor, and never further back than `maxReplayMs`.
   *
   * The armed filter is what the CODEC says it encoded, so the local match can
   * never be stricter than the subscription we sent.
   */
  const armFilter = (sub: Subscription): RelayFilter => {
    const wire = {
      ...sub.filter,
      sinceMs: Math.max(sub.filter.sinceMs, sub.highWaterMs - RESUME_OVERLAP_MS, now() - maxReplayMs),
    }
    sub.armed = codec.effectiveFilter?.(wire) ?? wire
    return wire
  }

  /** Surface what the relay said about our traffic; never fatal. */
  const reportNotice = (raw: string): void => {
    if (!options.onNotice) return
    try {
      const notice = codec.decodeNotice(raw)
      if (notice) options.onNotice(notice)
    } catch {
      // A dialect we misread is not a reason to drop the connection.
    }
  }

  // A SINGLE shared reconnect timer dedups retries at the connection level, so a
  // socket that fires both 'error' and 'close' schedules exactly one attempt,
  // and only ONE socket ever exists at a time: the timer fires connect() only
  // after the previous socket is already down (its close/error is what armed the
  // timer), so no two sockets are ever CONNECTING at once and none is orphaned
  // mid-connect. Every socket handler is guarded on `socket === ws`, so a late
  // event from a superseded socket is ignored.
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return
    const delay = delays[Math.min(attempt, delays.length - 1)]!
    attempt += 1
    options.onReconnect?.(attempt)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
  }

  const connect = (): void => {
    if (closed) return
    const ws = new Ctor(url)
    socket = ws
    /** When this socket reached OPEN; 0 if it never did. */
    let openedAtMs = 0

    // Reconnect must be armed on BOTH 'error' and 'close'. An established
    // connection that drops fires close (sometimes after error); a connect that
    // FAILS outright fires ONLY error, no close (verified against Node/undici).
    // Retrying solely from close therefore stops forever the moment it matters —
    // the relay still down on a reconnect attempt.
    const onDown = (): void => {
      if (socket !== ws) return
      // Reset the backoff only for a connection that actually held up. Doing
      // it on `open` instead means a relay that accepts the socket and drops
      // it immediately — over capacity, demanding auth, refusing our kinds —
      // resets the schedule every cycle, and the client hammers it at the
      // shortest delay forever instead of backing off.
      if (openedAtMs > 0 && now() - openedAtMs >= STABLE_CONNECTION_MS) attempt = 0
      scheduleReconnect()
    }

    ws.addEventListener('open', () => {
      if (socket !== ws) return
      openedAtMs = now()
      // Replay every live subscription onto the fresh socket, THEN flush the
      // events that were published while no socket was open.
      for (const [id, sub] of subscriptions) send(codec.encodeSub(id, armFilter(sub)))
      while (pending.length > 0 && socket === ws && ws.readyState === ws.OPEN) {
        send(codec.encodeEvent(pending.shift()!))
      }
    })
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (socket !== ws) return
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
      const event = codec.decodeEvent(raw)
      if (!event) {
        // Not an event for us — but it may still be the relay telling us our
        // event was refused or our subscription is gone. Say so out loud.
        reportNotice(raw)
        return
      }
      // Clamped to now, because the stamp is the SENDER's claim and it feeds
      // the `since` of every future reconnect. An event dated a year ahead —
      // signed and correctly addressed, so it passes every other gate — would
      // otherwise push the resume point into the future and leave us asking
      // the relay for events newer than anything that will ever exist. That is
      // silent, total deafness on the next reconnect, bounded only by whatever
      // future-dating the relay happens to refuse (strfry's default allows 15
      // minutes; nothing requires a relay to check at all).
      const stampedAt = Math.min(event.createdAtMs, now())
      for (const sub of subscriptions.values()) {
        if (!matchesFilter(event, sub.armed)) continue
        // Advance before dispatch: a handler that throws must not make the
        // subscription replay from an older point on the next reconnect.
        if (stampedAt > sub.highWaterMs) sub.highWaterMs = stampedAt
        void sub.onEvent(event)
      }
    })
    ws.addEventListener('close', onDown)
    ws.addEventListener('error', onDown)
  }

  connect()

  return {
    publish: async (event) => sendOrQueue(event),
    isConnected: isOpen,
    subscribe: async (filter, onEvent) => {
      const id = `s${(subCounter += 1)}`
      const armedFilter = { ...filter, sinceMs: filter.sinceMs ?? now() }
      const sub: Subscription = { filter: armedFilter, armed: armedFilter, onEvent, highWaterMs: 0 }
      subscriptions.set(id, sub)
      send(codec.encodeSub(id, armFilter(sub)))
      return {
        close: async () => {
          subscriptions.delete(id)
          send(codec.encodeUnsub(id))
        },
      }
    },
    close: async () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close()
    },
  }
}

// Uniqueness within a process run comes from the sequence; across restarts from
// the run tag. Payload length alone collided: two same-millisecond replies with
// equal-length JSON (refusals are all the same shape) got identical ids, and a
// relay that dedups by id — the field's documented purpose — dropped one.
let eventSequence = 0
const runTag = Math.random().toString(36).slice(2, 8)

/** Stamp a fresh, unique event id: author + time + run tag + sequence. */
export const eventId = (author: string, _payload: unknown, nowMs: number): string =>
  `${author}:${nowMs}:${runTag}:${(eventSequence += 1)}`
