/**
 * The concrete WebSocket relay client against a real (in-process) broker
 * speaking the same frames as scripts/mock-relay.mjs — connection, delivery,
 * and the part that matters for a long-lived provider: reconnect with
 * subscription REPLAY after the relay drops.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer, WebSocket as WsClient } from 'ws'
import {
  devCodec,
  matchesFilter as matches,
  webSocketRelayConnection,
  type RelayConnection,
  type RelayEvent,
  type RelayFilter,
  type RelayNotice,
  type WireCodec,
} from '@arkade-os/solver-transport/relay/connection.js'

/** The mock-relay broker, embedded: sub/unsub/event with recipient filtering. */
const startBroker = (port: number): WebSocketServer => {
  const server = new WebSocketServer({ port })
  const subscribers = new Map<import('ws').WebSocket, Map<string, { recipient?: string }>>()
  server.on('connection', (socket) => {
    subscribers.set(socket, new Map())
    socket.on('close', () => subscribers.delete(socket))
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as {
        op: string
        id?: string
        filter?: { recipient?: string }
        event?: RelayEvent
      }
      if (frame.op === 'sub' && frame.id) subscribers.get(socket)?.set(frame.id, frame.filter ?? {})
      if (frame.op === 'unsub' && frame.id) subscribers.get(socket)?.delete(frame.id)
      if (frame.op === 'event' && frame.event) {
        for (const [peer, subs] of subscribers) {
          for (const filter of subs.values()) {
            if (matches(frame.event, filter)) {
              peer.send(JSON.stringify({ op: 'event', event: frame.event }))
              break
            }
          }
        }
      }
    })
  })
  return server
}

const until = async (predicate: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const closed: (() => Promise<void>)[] = []
afterEach(async () => {
  while (closed.length) await closed.pop()!()
})

const stopServer = async (server: WebSocketServer): Promise<void> => {
  // ws's close() only stops listening; it waits forever for live clients.
  for (const client of server.clients) client.terminate()
  await new Promise((resolve) => server.close(resolve))
}

const track = (connection: RelayConnection, server?: WebSocketServer): RelayConnection => {
  closed.push(async () => {
    await connection.close()
    if (server) await stopServer(server)
  })
  return connection
}

/** Raw second participant publishing straight to the broker. */
const rawPublish = async (port: number, event: RelayEvent): Promise<void> => {
  const ws = new WsClient(`ws://127.0.0.1:${port}`)
  await new Promise((resolve) => ws.on('open', resolve))
  ws.send(JSON.stringify({ op: 'event', event }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  ws.close()
}

describe('webSocketRelayConnection', () => {
  it('delivers events matching a subscription, outbound only', async () => {
    const server = startBroker(0)
    const port = (server.address() as { port: number }).port
    const received: RelayEvent[] = []

    const connection = track(webSocketRelayConnection(`ws://127.0.0.1:${port}`), server)
    await connection.subscribe({ recipient: 'provider' }, (event) => void received.push(event))
    // Give the sub frame time to land before publishing.
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Stamped now: a subscription defaults its `since` to when it was opened,
    // so a fixture stamped at the epoch is legitimately filtered out.
    const stamp = Date.now()
    await rawPublish(port, { id: 'e1', author: 'client', recipient: 'provider', createdAtMs: stamp, payload: { v: 1 } })
    await rawPublish(port, {
      id: 'e2',
      author: 'client',
      recipient: 'someone-else',
      createdAtMs: stamp,
      payload: { v: 1 },
    })

    await until(() => received.length === 1)
    expect(received[0]!.id).toBe('e1')
  })

  it('reconnects after the relay drops and REPLAYS its subscriptions', async () => {
    let server = startBroker(0)
    const port = (server.address() as { port: number }).port
    const received: RelayEvent[] = []

    const connection = track(
      webSocketRelayConnection(`ws://127.0.0.1:${port}`, { reconnectDelaysMs: [50, 50, 50, 50, 50, 50] }),
    )
    closed.push(async () => stopServer(server))
    await connection.subscribe({ recipient: 'provider' }, (event) => void received.push(event))
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Kill the relay entirely, then bring it back on the same port.
    for (const client of server.clients) client.terminate()
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => setTimeout(resolve, 100))
    server = startBroker(port)

    // The provider must be subscribed again WITHOUT any new subscribe() call.
    await until(() => server.clients.size === 1, 5000)
    await new Promise((resolve) => setTimeout(resolve, 150))
    await rawPublish(port, {
      id: 'after',
      author: 'client',
      recipient: 'provider',
      createdAtMs: Date.now(),
      payload: { v: 1 },
    })

    await until(() => received.length === 1, 5000)
    expect(received[0]!.id).toBe('after')
  })

  it('queues events published while the relay is down and flushes them on reconnect', async () => {
    // publish() must not silently drop a reply produced during a reconnect
    // window — the client would wait forever for a quote the provider believes
    // it sent.
    let server = startBroker(0)
    const port = (server.address() as { port: number }).port
    const seen: RelayEvent[] = []
    let reconnects = 0

    const connection = track(
      webSocketRelayConnection(`ws://127.0.0.1:${port}`, {
        reconnectDelaysMs: [40, 40, 40, 40, 40, 40],
        onReconnect: () => (reconnects += 1),
      }),
    )
    closed.push(async () => stopServer(server))
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Kill the relay. Publish only once the socket is DEFINITIVELY down (a
    // reconnect has fired) — a publish in the split-second before the client
    // observes the drop still sends on the dying socket, which is not the case
    // under test here.
    for (const client of server.clients) client.terminate()
    await new Promise((resolve) => server.close(resolve))
    await until(() => reconnects >= 1, 3000)
    await connection.publish({
      id: 'queued',
      author: 'provider',
      recipient: 'client',
      createdAtMs: 3,
      payload: { v: 1 },
    })

    // Bring the relay back; the queued event must arrive without any re-publish.
    server = startBroker(port)
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as { op: string; event?: RelayEvent }
        if (frame.op === 'event' && frame.event) seen.push(frame.event)
      })
    })

    await until(() => seen.some((e) => e.id === 'queued'), 5000)
  })
})

/** Records every `sub` filter the broker is sent, across reconnects. */
const recordSubs = (server: WebSocketServer, into: RelayFilter[]): void => {
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { op: string; filter?: RelayFilter }
      if (frame.op === 'sub' && frame.filter) into.push(frame.filter)
    })
  })
}

describe('webSocketRelayConnection — bounded replay', () => {
  it('never asks a relay for its archive, even when the caller sets no since', async () => {
    // Measured against strfry: an unbounded `{kinds,#p}` subscription replayed
    // every stored request addressed to the solver on every reconnect, capped
    // only by the relay's own max_limit (500 on nostr.arkade.sh). The ingress
    // answers each one, so the solver would sign and publish a burst of
    // replies to negotiations abandoned long ago.
    const server = startBroker(0)
    const port = (server.address() as { port: number }).port
    const subs: RelayFilter[] = []
    recordSubs(server, subs)

    const openedAt = Date.now()
    const connection = track(webSocketRelayConnection(`ws://127.0.0.1:${port}`), server)
    await connection.subscribe({ recipient: 'provider' }, () => {})

    await until(() => subs.length === 1)
    expect(subs[0]!.sinceMs).toBeDefined()
    // Recent, not the epoch: "from when I subscribed", never "from the start".
    expect(subs[0]!.sinceMs!).toBeGreaterThanOrEqual(openedAt - 1000)
  })

  it('resumes a reconnect from the newest event seen, not from the original subscribe', async () => {
    // The clock is injected so "still at the original since" and "advanced to
    // the high-water mark" are distinguishable without sleeping.
    const T = 1_800_000_000_000
    let fakeNow = T
    let server = startBroker(0)
    const port = (server.address() as { port: number }).port
    const subs: RelayFilter[] = []
    recordSubs(server, subs)
    const received: RelayEvent[] = []

    const connection = track(
      webSocketRelayConnection(`ws://127.0.0.1:${port}`, {
        reconnectDelaysMs: [50, 50, 50, 50, 50, 50],
        now: () => fakeNow,
      }),
    )
    closed.push(async () => stopServer(server))
    await connection.subscribe({ recipient: 'provider' }, (event) => void received.push(event))
    await until(() => subs.length === 1)
    expect(subs[0]!.sinceMs).toBe(T)

    // Time passes, then an event stamped between the subscribe and now.
    fakeNow = T + 10_000
    const seenAt = T + 5_000
    await rawPublish(port, { id: 'seen', author: 'client', recipient: 'provider', createdAtMs: seenAt, payload: {} })
    await until(() => received.length === 1)

    for (const client of server.clients) client.terminate()
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => setTimeout(resolve, 100))
    server = startBroker(port)
    recordSubs(server, subs)

    await until(() => subs.length === 2, 5000)
    // Advanced past the original floor, overlapped by exactly one second so a
    // whole-second wire stamp cannot open a gap.
    expect(subs[1]!.sinceMs).toBe(seenAt - 1000)
  })

  it('never lets a future-dated event push the resume point forward', async () => {
    // The stamp is the SENDER's claim and it feeds the `since` of every later
    // reconnect. An event dated far ahead — signed and correctly addressed, so
    // it passes every other gate — would otherwise leave us asking the relay
    // for events newer than anything that will ever exist: silent, total
    // deafness, for as long as the lie.
    const T = 1_800_000_000_000
    const fakeNow = T
    let server = startBroker(0)
    const port = (server.address() as { port: number }).port
    const subs: RelayFilter[] = []
    recordSubs(server, subs)
    const received: RelayEvent[] = []

    const connection = track(
      webSocketRelayConnection(`ws://127.0.0.1:${port}`, {
        reconnectDelaysMs: [50, 50, 50, 50, 50, 50],
        now: () => fakeNow,
      }),
    )
    closed.push(async () => stopServer(server))
    await connection.subscribe({ recipient: 'provider' }, (event) => void received.push(event))
    await until(() => subs.length === 1)

    await rawPublish(port, {
      id: 'from-the-future',
      author: 'liar',
      recipient: 'provider',
      createdAtMs: T + 365 * 24 * 3600 * 1000, // a year ahead
      payload: {},
    })
    await until(() => received.length === 1)

    for (const client of server.clients) client.terminate()
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => setTimeout(resolve, 100))
    server = startBroker(port)
    recordSubs(server, subs)

    await until(() => subs.length === 2, 5000)
    // Clamped to now, so the replay window is unchanged rather than a year ahead.
    expect(subs[1]!.sinceMs).toBeLessThanOrEqual(fakeNow)
    expect(subs[1]!.sinceMs).toBe(T)
  })
})

describe('webSocketRelayConnection — relay feedback', () => {
  it('forwards what the relay says about our traffic instead of swallowing it', async () => {
    // Without this the only symptom of a relay refusing every publish is
    // silence, which reads as an idle market.
    const server = new WebSocketServer({ port: 0 })
    const port = (server.address() as { port: number }).port
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as { op: string; event?: RelayEvent }
        if (frame.op === 'event') {
          socket.send(JSON.stringify({ op: 'refused', id: frame.event!.id, reason: 'blocked: not allowed' }))
        }
      })
    })

    const codec: WireCodec = {
      ...devCodec,
      decodeNotice: (raw) => {
        const frame = JSON.parse(raw) as { op: string; id?: string; reason?: string }
        return frame.op === 'refused' ? { kind: 'rejected', ref: frame.id, message: frame.reason } : null
      },
    }
    const notices: RelayNotice[] = []
    const connection = track(
      webSocketRelayConnection(`ws://127.0.0.1:${port}`, { codec, onNotice: (n) => void notices.push(n) }),
      server,
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    await connection.publish({
      id: 'e1',
      author: 'provider',
      recipient: 'client',
      createdAtMs: Date.now(),
      payload: {},
    })

    await until(() => notices.length === 1)
    expect(notices[0]).toEqual({ kind: 'rejected', ref: 'e1', message: 'blocked: not allowed' })
  })

  it('delivers an event stamped in the same second the subscription opened', async () => {
    // The dead window: a second-granularity codec sends `since = floor(ms/1000)`
    // and gets `created_at * 1000` back, so matching that against the raw
    // sinceMs drops up to 999ms of live events after every subscribe — right
    // across the few-second bid window of § 4.6.
    //
    // The clock is pinned half a second into a tick so the gap is exercised on
    // every run; with a real clock this only reproduces when the subscribe
    // happens to land late in a second.
    const second = Math.floor(Date.now() / 1000) * 1000
    const server = startBroker(0)
    const port = (server.address() as { port: number }).port
    const received: RelayEvent[] = []
    // A codec that truncates stamps to whole seconds, exactly as Nostr does.
    // States the lossy transform ONCE and encodes through it — the shape a
    // real codec has, and the reason effectiveFilter reports the filter rather
    // than describing the transformation.
    const truncateToSeconds = (filter: RelayFilter): RelayFilter =>
      filter.sinceMs === undefined ? filter : { ...filter, sinceMs: Math.floor(filter.sinceMs / 1000) * 1000 }
    const codec: WireCodec = {
      ...devCodec,
      effectiveFilter: truncateToSeconds,
      encodeSub: (id, filter) => devCodec.encodeSub(id, truncateToSeconds(filter)),
    }

    const connection = track(
      webSocketRelayConnection(`ws://127.0.0.1:${port}`, { codec, now: () => second + 500 }),
      server,
    )
    await connection.subscribe({ topic: 'arkade:btc/lightning:btc' }, (event) => void received.push(event))
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Stamped at the start of that second — before the subscribe in
    // milliseconds, at-or-after it in the seconds the wire actually carries.
    await rawPublish(port, {
      id: 'same-second',
      author: 'client',
      topic: 'arkade:btc/lightning:btc',
      createdAtMs: second,
      payload: {},
    })

    await until(() => received.length === 1)
    expect(received[0]!.id).toBe('same-second')
  })
})

describe('webSocketRelayConnection — backoff', () => {
  it('escalates backoff against a relay that accepts the socket and drops it immediately', async () => {
    // A relay over capacity, demanding auth, or refusing our kinds can complete
    // the handshake and close at once. Resetting the schedule on `open` turns
    // that into a hot loop at the shortest delay, forever — the client hammers
    // the relay hardest exactly when the relay is least able to serve it.
    const server = new WebSocketServer({ port: 0 })
    const port = (server.address() as { port: number }).port
    server.on('connection', (socket) => socket.close())

    const attempts: number[] = []
    track(
      webSocketRelayConnection(`ws://127.0.0.1:${port}`, {
        reconnectDelaysMs: [10, 20, 40, 80, 160],
        onReconnect: (attempt) => void attempts.push(attempt),
      }),
      server,
    )

    await until(() => attempts.length >= 4, 5000)
    // Each cycle costs more than the last, rather than pinning at 1.
    expect(attempts.slice(0, 4)).toEqual([1, 2, 3, 4])
  })
})

describe('webSocketRelayConnection — connectivity signal', () => {
  it('reports connected while the socket is up and disconnected once it drops', async () => {
    // The only liveness a port-less solver can publish. Reconnect is automatic
    // and unbounded, so "the process is alive" never distinguished a working
    // solver from a deaf one — this does, and the container healthcheck is
    // built on it.
    let server = startBroker(0)
    const port = (server.address() as { port: number }).port
    let reconnects = 0

    const connection = track(
      webSocketRelayConnection(`ws://127.0.0.1:${port}`, {
        reconnectDelaysMs: [40, 40, 40, 40, 40, 40],
        onReconnect: () => (reconnects += 1),
      }),
    )
    closed.push(async () => stopServer(server))

    // Not connected before the socket opens — it cannot be OPEN synchronously.
    expect(connection.isConnected()).toBe(false)
    await until(() => connection.isConnected(), 3000)

    await stopServer(server)
    await until(() => reconnects >= 1, 3000)
    expect(connection.isConnected()).toBe(false)

    // And true again once the relay is back.
    server = startBroker(port)
    await until(() => connection.isConnected(), 5000)
  })
})
