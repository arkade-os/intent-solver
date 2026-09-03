/**
 * `nostrRelayTransport` is constructible — which is to say, its module's
 * imports actually cover what its body uses.
 *
 * This exists because main shipped broken. Two PRs merged independently: one
 * added `nostrRelayTransport`, whose body calls `schnorr.getPublicKey`, and
 * another removed the `schnorr` import, because on ITS branch — cut before the
 * first landed — the only caller was code that branch deleted. Git merged both
 * without a conflict and the result threw `ReferenceError: schnorr is not
 * defined` on the first line of every real-Nostr client.
 *
 * Nothing could have caught it. `examples/` is outside `tsc` and outside
 * vitest, and an undefined global only throws when the line RUNS, so even
 * importing the module stays quiet — the reference sits inside a function
 * body. Only calling it fails.
 *
 * So this calls it. `WebSocketCtor` is injectable for exactly this reason: the
 * constructor derives the client's own pubkey and the NIP-44 conversation key
 * before it ever touches the socket, so a stub is enough to execute every line
 * that a missing import would break.
 */

import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { NOSTR_KIND_DIRECTED } from '@arkade-os/solver-transport/relay/nostr.js'
// @ts-expect-error -- untyped .mjs example, imported for exactly the reason above
import { nostrRelayTransport } from '../../examples/lib/swap-client.mjs'

/** Enough of a WebSocket to construct against; it is never driven. */
class StubSocket {
  addEventListener(): void {}
  send(): void {}
  close(): void {}
}

/**
 * As above, but it fires `open` and keeps what was sent.
 *
 * Safe to queue the `open` in the constructor: `nostrRelayTransport` builds
 * the socket and attaches all three listeners inside one synchronous
 * `new Promise` executor, so the microtask cannot run before they are there.
 */
class RecordingSocket {
  static sent: string[] = []
  private readonly listeners = new Map<string, (ev: unknown) => void>()
  constructor() {
    RecordingSocket.sent = []
    queueMicrotask(() => this.listeners.get('open')?.({}))
  }
  addEventListener(name: string, fn: (ev: unknown) => void): void {
    this.listeners.set(name, fn)
  }
  send(data: string): void {
    RecordingSocket.sent.push(data)
  }
  close(): void {}
}

describe('nostrRelayTransport', () => {
  it('constructs without a missing-import ReferenceError', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    // A real x-only key: the constructor runs a NIP-44 ECDH against it, which
    // rejects anything that is not a point on the curve.
    const solverPubkey = hex.encode(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))

    const transport = nostrRelayTransport('ws://localhost:1', {
      solverPubkey,
      secretKey,
      WebSocketCtor: StubSocket,
    })

    expect(typeof transport.requestQuote).toBe('function')
    expect(typeof transport.requestStatus).toBe('function')
    expect(typeof transport.close).toBe('function')
  })

  /**
   * The example and the solver must agree on the event kind, and NOTHING ELSE
   * makes them.
   *
   * This shipped broken too. The solver moved directed traffic to 24859 — the
   * ephemeral range, for privacy and to stop reconnects replaying a stored
   * backlog — and this client stayed on 4859. Two disjoint `kinds` filters do
   * not fail to match, they never match: the request is published, the relay
   * accepts it, the solver is subscribed elsewhere and never sees it, and the
   * client times out with `no reply within 30000ms` as though the solver were
   * down. Confirmed against one whose log said `relay ingress open`.
   *
   * Asserted against the SOLVER'S OWN EXPORT rather than a literal, so the
   * next move of that constant fails here instead of in silence. A literal
   * would only pin the example to whatever it happened to say.
   *
   * Driven rather than read: the subscription is built inside the socket's
   * `open` handler, so a source match would prove the constant is mentioned,
   * not that it is what goes on the wire.
   */
  it('subscribes on the kind the solver actually publishes on', async () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const solverPubkey = hex.encode(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))

    const transport = nostrRelayTransport('ws://localhost:1', {
      solverPubkey,
      secretKey,
      WebSocketCtor: RecordingSocket,
    })
    // Let the queued `open` run; the REQ is sent from that handler.
    await Promise.resolve()
    await transport.close()

    const frames = RecordingSocket.sent.map((raw) => JSON.parse(raw) as unknown[])
    const req = frames.find((frame) => frame[0] === 'REQ')
    // A missing REQ would make the kind assertion below vacuously pass.
    expect(req, 'the transport sent no REQ frame').toBeDefined()
    expect((req as [string, string, { kinds: number[] }])[2].kinds).toEqual([NOSTR_KIND_DIRECTED])
  })
})
