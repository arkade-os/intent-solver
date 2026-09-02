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
// @ts-expect-error -- untyped .mjs example, imported for exactly the reason above
import { nostrRelayTransport } from '../../examples/lib/swap-client.mjs'

/** Enough of a WebSocket to construct against; it is never driven. */
class StubSocket {
  addEventListener(): void {}
  send(): void {}
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
})
