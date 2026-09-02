/**
 * The PRODUCTION configuration, end to end: `webSocketRelayConnection` driving
 * the real Nostr codec against a real socket speaking real NIP-01.
 *
 * Everything else in test/relay/ tests one half. `websocket.test.ts` drives the
 * connection with the dev broker framing; `nostr.test.ts` tests the codec as
 * pure functions. Nothing composed them, so the only configuration that ever
 * runs in production — `RELAY_PROTOCOL=nostr` against a stored-event relay —
 * had no coverage at all, and every relay-shaped bug (unacknowledged
 * publishes, archive replay on reconnect, a torn-down subscription the client
 * still believes in) was invisible to CI by construction.
 *
 * The broker below is deliberately a NIP-01 relay and not a mock of our own
 * framing: it STORES events and replays them to matching filters, which is the
 * behaviour `scripts/mock-relay.mjs` does not have and therefore the behaviour
 * that went untested. Its filter and limit semantics follow strfry's, verified
 * against a live strfry 1.0.4 (`scripts/probe-relay.mjs`).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer, WebSocket as WsClient } from 'ws'
import { finalizeEvent, type Event } from 'nostr-tools/pure'
import { matchFilter, type Filter } from 'nostr-tools/filter'
import { encrypt, getConversationKey } from 'nostr-tools/nip44'
import {
  deriveNostrIdentity,
  nostrCodec,
  NOSTR_KIND_BROADCAST,
  NOSTR_KIND_DIRECTED,
} from '@arkade-os/solver-transport/relay/nostr.js'
import {
  webSocketRelayConnection,
  type RelayEvent,
  type RelayNotice,
  type WebSocketRelayOptions,
} from '@arkade-os/solver-transport/relay/connection.js'

/** ws's WebSocket where the connection expects the DOM one. */
const Ctor = WsClient as unknown as typeof WebSocket

const solver = deriveNostrIdentity('abandon '.repeat(11) + 'about', true)
const client = deriveNostrIdentity('legal winner thank year wave sausage worth useful legal winner thank yellow', true)
const clientToSolver = getConversationKey(client.secretKey, solver.pubkey)

interface RelayOptions {
  /** Refuse every EVENT with this reason, as a policy plugin would. */
  rejectWith?: string
  /** Refuse every REQ with this reason. */
  closeSubsWith?: string
  /** Pre-loaded history, so a first connect can face a backlog. */
  stored?: Event[]
}

/** A minimal NIP-01 relay: REQ/EVENT/CLOSE, stored events, OK/EOSE/CLOSED. */
const startNostrRelay = (port: number, options: RelayOptions = {}) => {
  const server = new WebSocketServer({ port })
  const stored: Event[] = [...(options.stored ?? [])]
  const published: Event[] = []
  const seenFilters: Filter[] = []

  // Subscriptions are per-connection, but fanout is relay-wide: an EVENT from
  // one socket must reach every OTHER socket's matching REQ. Keeping the map
  // only on the sending socket is the bug that makes a broker look like it
  // works while delivering nothing.
  const connections = new Map<WsClient, Map<string, Filter>>()

  server.on('connection', (socket) => {
    const subs = new Map<string, Filter>()
    connections.set(socket, subs)
    socket.on('close', () => connections.delete(socket))
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as [string, ...unknown[]]
      const [type] = message
      if (type === 'REQ') {
        const id = message[1] as string
        const filter = message[2] as Filter
        seenFilters.push(filter)
        if (options.closeSubsWith) {
          socket.send(JSON.stringify(['CLOSED', id, options.closeSubsWith]))
          return
        }
        subs.set(id, filter)
        // Stored events first, newest-last, capped by `limit` — strfry's order.
        const backlog = stored.filter((e) => matchFilter(filter, e))
        for (const event of filter.limit === undefined ? backlog : backlog.slice(0, filter.limit)) {
          socket.send(JSON.stringify(['EVENT', id, event]))
        }
        socket.send(JSON.stringify(['EOSE', id]))
      } else if (type === 'EVENT') {
        const event = message[1] as Event
        if (options.rejectWith) {
          socket.send(JSON.stringify(['OK', event.id, false, options.rejectWith]))
          return
        }
        published.push(event)
        stored.push(event)
        socket.send(JSON.stringify(['OK', event.id, true, '']))
        for (const [peer, peerSubs] of connections) {
          for (const [id, filter] of peerSubs) {
            if (matchFilter(filter, event)) peer.send(JSON.stringify(['EVENT', id, event]))
          }
        }
      } else if (type === 'CLOSE') {
        subs.delete(message[1] as string)
      }
    })
  })
  return { server, stored, published, seenFilters }
}

/** A directed kind-24859 event from the client to the solver, as the wallet builds it. */
const directedFromClient = (payload: unknown, createdAt: number): Event =>
  finalizeEvent(
    {
      kind: NOSTR_KIND_DIRECTED,
      created_at: createdAt,
      tags: [['p', solver.pubkey]],
      content: encrypt(JSON.stringify(payload), clientToSolver),
    },
    client.secretKey,
  )

const broadcastFromClient = (topic: string, payload: unknown, createdAt: number): Event =>
  finalizeEvent(
    { kind: NOSTR_KIND_BROADCAST, created_at: createdAt, tags: [['t', topic]], content: JSON.stringify(payload) },
    client.secretKey,
  )

/**
 * Poll until `predicate` holds, giving up after `ms`.
 *
 * The budget is a FAILURE deadline, not a success dependency: the loop exits
 * the moment the predicate is true, so a generous ceiling costs a green run
 * nothing and only buys a loaded machine room to schedule a socket. It was
 * 3000 ms, which a contended runner could genuinely exhaust while the relay was
 * still binding. Nothing here may wait on this budget for CORRECTNESS — a test
 * that only passes because the deadline is long is a test that will go red on
 * someone else's machine, so each call below waits on a real happens-before
 * edge and uses the deadline purely to fail rather than hang.
 */
const until = async (predicate: () => boolean, ms = 15000): Promise<void> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`condition never became true within ${ms}ms`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const stopServer = async (server: WebSocketServer): Promise<void> => {
  for (const socket of server.clients) socket.terminate()
  await new Promise((resolve) => server.close(resolve))
}

/** The production stack pointed at a relay, torn down after the test. */
const connect = (
  relay: ReturnType<typeof startNostrRelay>,
  extra: Partial<WebSocketRelayOptions> = {},
): { connection: ReturnType<typeof webSocketRelayConnection>; port: number } => {
  const port = (relay.server.address() as { port: number }).port
  const connection = webSocketRelayConnection(`ws://127.0.0.1:${port}`, {
    codec: nostrCodec(solver),
    WebSocketCtor: Ctor,
    ...extra,
  })
  cleanups.push(async () => {
    await connection.close()
    await stopServer(relay.server)
  })
  return { connection, port }
}

describe('the production transport: webSocketRelayConnection + nostrCodec over NIP-01', () => {
  it('carries a directed request in and a sealed reply back out', async () => {
    const relay = startNostrRelay(0)
    const received: RelayEvent[] = []
    const { connection, port } = connect(relay)
    await connection.subscribe({ recipient: solver.pubkey }, (event) => void received.push(event))
    await new Promise((resolve) => setTimeout(resolve, 100))

    // A raw client publishes exactly what the wallet publishes.
    const raw = new WsClient(`ws://127.0.0.1:${port}`)
    await new Promise((resolve) => raw.on('open', resolve))
    const request = { v: 1, type: 'rfq_request', rfq_id: 'a'.repeat(64) }
    raw.send(JSON.stringify(['EVENT', directedFromClient(request, Math.floor(Date.now() / 1000))]))

    await until(() => received.length === 1)
    // Decrypted and parsed by the real codec — proof the NIP-44 seal round-trips.
    expect(received[0]!.payload).toEqual(request)
    expect(received[0]!.author).toBe(client.pubkey)

    // And the reply goes back out as a signed, sealed, p-tagged kind 24859.
    await connection.publish({
      id: 'ignored-by-nostr',
      author: solver.pubkey,
      recipient: client.pubkey,
      createdAtMs: Date.now(),
      payload: { v: 1, type: 'rfq_refusal', reason: 'unsupported_payload' },
    })
    // The relay stores every publish, the client's request included, so select
    // the solver's reply by author rather than by arrival order.
    await until(() => relay.published.some((e) => e.pubkey === solver.pubkey))
    const reply = relay.published.find((e) => e.pubkey === solver.pubkey)!
    expect(reply.kind).toBe(NOSTR_KIND_DIRECTED)
    expect(reply.tags).toContainEqual(['p', client.pubkey])
    // Sealed: the ciphertext must not be the plaintext.
    expect(reply.content).not.toContain('rfq_refusal')
    raw.close()
  })

  it('does not drag the relay archive through the swap stack on connect', async () => {
    // Against live strfry this replayed every stored request addressed to the
    // solver, bounded only by the relay's max_limit — each one costing a verify,
    // a decrypt and a signed reply to a client that stopped listening long ago.
    const nowSec = Math.floor(Date.now() / 1000)
    const archive = [
      directedFromClient({ v: 1, type: 'rfq_request', rfq_id: 'b'.repeat(64) }, nowSec - 3600),
      directedFromClient({ v: 1, type: 'rfq_request', rfq_id: 'c'.repeat(64) }, nowSec - 1800),
      directedFromClient({ v: 1, type: 'rfq_request', rfq_id: 'd'.repeat(64) }, nowSec - 600),
    ]
    const relay = startNostrRelay(0, { stored: archive })
    const received: RelayEvent[] = []
    const { connection, port } = connect(relay)
    await connection.subscribe({ recipient: solver.pubkey }, (event) => void received.push(event))
    await until(() => relay.seenFilters.length === 1)

    // The REQ carries a recent `since`, so the relay has nothing old to send.
    expect(relay.seenFilters[0]!.since).toBeGreaterThan(nowSec - 300)

    // Live traffic still arrives — and its arrival is also what proves the
    // archive did not. The relay serves a REQ's stored backlog and its EOSE
    // before anything published later, on this one socket and in order, so by
    // the time the sentinel below is delivered every replayed event the relay
    // was ever going to send has already been pushed through `received`. That
    // is a happens-before edge, so `toHaveLength(1)` is exact rather than a bet
    // on a sleep being long enough; a regression to a wide `since` puts the
    // three archived requests in front of the sentinel and fails here.
    const raw = new WsClient(`ws://127.0.0.1:${port}`)
    await new Promise((resolve) => raw.on('open', resolve))
    // Stamped NOW, not at `nowSec`. NIP-01 carries whole seconds and the
    // subscription's `since` is computed at subscribe() time, which is after
    // `nowSec` was read: reusing that stale second meant that whenever the
    // clock happened to roll over in between, `since` exceeded the event's
    // `created_at` and the relay correctly dropped a sentinel the test then
    // waited on forever. A ~26 ms window against a 1 s tick — an intermittent
    // red that no timeout could have fixed, because the event never came.
    const sentinel = 'e'.repeat(64)
    raw.send(
      JSON.stringify([
        'EVENT',
        directedFromClient({ v: 1, type: 'rfq_request', rfq_id: sentinel }, Math.floor(Date.now() / 1000)),
      ]),
    )
    await until(() => received.some((e) => (e.payload as { rfq_id?: string }).rfq_id === sentinel))
    expect(received).toHaveLength(1)
    raw.close()
  })

  it('reports a relay that refuses our publishes instead of resolving successfully', async () => {
    // publish() resolving on `OK false` is why "the relay rejects everything"
    // and "nobody is trading" looked identical from the logs.
    const relay = startNostrRelay(0, { rejectWith: 'blocked: kind not allowed' })
    const notices: RelayNotice[] = []
    const { connection } = connect(relay, { onNotice: (notice) => void notices.push(notice) })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await connection.publish({
      id: 'x',
      author: solver.pubkey,
      recipient: client.pubkey,
      createdAtMs: Date.now(),
      payload: { v: 1, type: 'rfq_quote' },
    })

    await until(() => notices.some((n) => n.kind === 'rejected'))
    expect(notices.find((n) => n.kind === 'rejected')!.message).toBe('blocked: kind not allowed')
    expect(relay.published).toHaveLength(0)
  })

  it('reports a subscription the relay tore down, rather than going quietly deaf', async () => {
    // A CLOSED REQ leaves the solver believing it is subscribed forever. Under
    // an auth-requiring or filter-restricting relay this is the whole failure.
    const relay = startNostrRelay(0, { closeSubsWith: 'auth-required: we only serve authenticated users' })
    const notices: RelayNotice[] = []
    const { connection } = connect(relay, { onNotice: (notice) => void notices.push(notice) })
    await connection.subscribe({ recipient: solver.pubkey }, () => {})

    await until(() => notices.some((n) => n.kind === 'subscription-closed'))
    expect(notices.find((n) => n.kind === 'subscription-closed')!.message).toMatch(/auth-required/)
  })

  it('delivers a broadcast on the market topic through the real t-tag filter', async () => {
    const topic = 'arkade:btc/lightning:btc'
    const relay = startNostrRelay(0)
    const received: RelayEvent[] = []
    const { connection, port } = connect(relay)
    await connection.subscribe({ topic, sinceMs: Date.now() }, (event) => void received.push(event))
    await until(() => relay.seenFilters.length === 1)
    expect(relay.seenFilters[0]!['#t']).toEqual([topic])
    expect(relay.seenFilters[0]!.kinds).toEqual([NOSTR_KIND_BROADCAST])

    const raw = new WsClient(`ws://127.0.0.1:${port}`)
    await new Promise((resolve) => raw.on('open', resolve))
    const open = { v: 1, type: 'rfq_open', open_id: 'f'.repeat(64), pair: 'arkade:BTC->lightning:BTC' }
    // Stamped at the start of the current second: the wire carries whole
    // seconds, so this is "before" the subscribe in ms and "at" it in seconds.
    raw.send(JSON.stringify(['EVENT', broadcastFromClient(topic, open, Math.floor(Date.now() / 1000))]))

    await until(() => received.length === 1)
    expect(received[0]!.payload).toEqual(open)
    expect(received[0]!.topic).toBe(topic)
    raw.close()
  })
})
