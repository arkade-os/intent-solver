import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { MnemonicIdentity } from '@arkade-os/sdk'
import { finalizeEvent } from 'nostr-tools/pure'
import { encrypt, getConversationKey } from 'nostr-tools/nip44'
import {
  deriveNostrIdentity,
  nostrCodec,
  nostrCodecForWallet,
  NOSTR_KIND_BROADCAST,
  NOSTR_KIND_DIRECTED,
} from '@arkade-os/solver-transport/relay/nostr.js'
import type { RelayEvent } from '@arkade-os/solver-transport/relay/connection.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

const solver = deriveNostrIdentity(MNEMONIC, true)
const client = deriveNostrIdentity(OTHER, true)
const stranger = deriveNostrIdentity(OTHER, false)

const solverCodec = nostrCodec(solver)
const clientCodec = nostrCodec(client)
const strangerCodec = nostrCodec(stranger)

const directed = (payload: unknown): RelayEvent => ({
  id: 'x',
  author: client.pubkey,
  recipient: solver.pubkey,
  createdAtMs: 1_800_000_000_000,
  payload,
})

describe('deriveNostrIdentity', () => {
  it('derives exactly the SDK wallet identity, mainnet and testnet', async () => {
    // THE load-bearing assertion: the relay key must be the key the registry
    // card advertises and makers address. If the SDK's derivation ever moves,
    // this fails here and the startup gate fails in production.
    for (const isMainnet of [true, false]) {
      const sdk = MnemonicIdentity.fromMnemonic(MNEMONIC, { isMainnet })
      expect(deriveNostrIdentity(MNEMONIC, isMainnet).pubkey).toBe(hex.encode(await sdk.xOnlyPublicKey()))
    }
  })

  it('mainnet and testnet derive different keys', () => {
    expect(deriveNostrIdentity(MNEMONIC, true).pubkey).not.toBe(deriveNostrIdentity(MNEMONIC, false).pubkey)
  })
})

describe('nostrCodecForWallet', () => {
  it('binds when the derivation matches the wallet identity, refuses when it does not', () => {
    expect(() => nostrCodecForWallet(MNEMONIC, true, solver.pubkey)).not.toThrow()
    // A mismatched expectation (here: the wrong network's key) must refuse to
    // produce a codec at all — a drifted key fails silently forever.
    expect(() => nostrCodecForWallet(MNEMONIC, false, solver.pubkey)).toThrow(/does not match the wallet identity/)
  })
})

describe('kind ranges', () => {
  /**
   * The RANGE, not the digits.
   *
   * docs/rfq-protocol.md § 12 leaves the exact numbers open — they still need
   * coordinating across implementations — but the range is a design decision
   * with teeth: NIP-01 says 20000 ≤ n < 30000 is ephemeral, and a conforming
   * relay does not retain those. Drift back into the regular range (where
   * these kinds started, at 4859/4860) and nothing fails loudly: the codec
   * works, every test above still passes, and the only symptom is that a
   * relay quietly begins archiving plaintext trade intent again.
   *
   * So this asserts the property the other tests cannot, because they all go
   * through the constants and would follow them anywhere.
   */
  it.each([
    ['directed', NOSTR_KIND_DIRECTED],
    ['broadcast', NOSTR_KIND_BROADCAST],
  ])('keeps the %s kind inside NIP-01 ephemeral range', (_name, kind) => {
    expect(kind).toBeGreaterThanOrEqual(20_000)
    expect(kind).toBeLessThan(30_000)
  })

  it('keeps the two kinds distinct', () => {
    // One filter subscribes by `p` tag and the other by `t` tag; collapsing
    // them would make a directed reply visible to every market subscriber.
    expect(NOSTR_KIND_DIRECTED).not.toBe(NOSTR_KIND_BROADCAST)
  })
})

describe('nostrCodec subscriptions', () => {
  it('maps a directed filter to a kind-24859 #p REQ', () => {
    const req = JSON.parse(solverCodec.encodeSub('s1', { recipient: solver.pubkey }))
    expect(req).toEqual(['REQ', 's1', { kinds: [NOSTR_KIND_DIRECTED], '#p': [solver.pubkey] }])
  })

  it('maps a topic filter to a kind-24860 #t REQ with since in seconds', () => {
    const req = JSON.parse(
      solverCodec.encodeSub('s2', { topic: 'arkade:btc/lightning:btc', sinceMs: 1_800_000_000_500 }),
    )
    expect(req).toEqual([
      'REQ',
      's2',
      { kinds: [NOSTR_KIND_BROADCAST], '#t': ['arkade:btc/lightning:btc'], since: 1_800_000_000 },
    ])
  })

  it('refuses an unconstrained subscription — a public relay is a firehose', () => {
    expect(() => solverCodec.encodeSub('s3', {})).toThrow(/recipient or a topic/)
  })

  it('unsubscribes with CLOSE', () => {
    expect(JSON.parse(solverCodec.encodeUnsub('s1'))).toEqual(['CLOSE', 's1'])
  })
})

describe('nostrCodec events', () => {
  it('round-trips a directed event: sealed by the client, readable only by the addressee', () => {
    const payload = { v: 1, type: 'rfq_request', rfq_id: 'ab'.repeat(32) }
    const wire = clientCodec.encodeEvent(directed(payload))

    const [tag, event] = JSON.parse(wire)
    expect(tag).toBe('EVENT')
    expect(event.kind).toBe(NOSTR_KIND_DIRECTED)
    expect(event.pubkey).toBe(client.pubkey)
    expect(event.tags).toEqual([['p', solver.pubkey]])
    // Sealed: the payload must not appear in the clear on the wire.
    expect(event.content).not.toContain('rfq_request')

    // A relay delivers ["EVENT", subId, event].
    const delivered = JSON.stringify(['EVENT', 's1', event])
    const received = solverCodec.decodeEvent(delivered)
    expect(received?.payload).toEqual(payload)
    expect(received?.author).toBe(client.pubkey)
    expect(received?.recipient).toBe(solver.pubkey)
    expect(received?.createdAtMs).toBe(1_800_000_000_000)

    // Anyone else gets silence, not an error.
    expect(strangerCodec.decodeEvent(delivered)).toBeNull()
  })

  it('round-trips a broadcast: plaintext, t-tagged, readable by anyone', () => {
    const payload = { v: 1, type: 'rfq_open', open_id: 'cd'.repeat(32) }
    const wire = clientCodec.encodeEvent({
      id: 'x',
      author: client.pubkey,
      topic: 'arkade:btc/lightning:btc',
      createdAtMs: 1_800_000_000_000,
      payload,
    })
    const [, event] = JSON.parse(wire)
    expect(event.kind).toBe(NOSTR_KIND_BROADCAST)
    expect(event.tags).toEqual([['t', 'arkade:btc/lightning:btc']])

    const delivered = JSON.stringify(['EVENT', 's2', event])
    for (const codec of [solverCodec, strangerCodec]) {
      const received = codec.decodeEvent(delivered)
      expect(received?.payload).toEqual(payload)
      expect(received?.topic).toBe('arkade:btc/lightning:btc')
    }
  })

  it('drops a tampered event: the signature gate comes first', () => {
    const [, event] = JSON.parse(clientCodec.encodeEvent(directed({ v: 1 })))
    event.created_at += 1 // any mutation breaks id/sig
    expect(solverCodec.decodeEvent(JSON.stringify(['EVENT', 's1', event]))).toBeNull()
  })

  it('drops acks, notices, foreign dialects and garbage as silence', () => {
    for (const raw of [
      JSON.stringify(['OK', 'abc', true, '']),
      JSON.stringify(['EOSE', 's1']),
      JSON.stringify(['NOTICE', 'restricted']),
      JSON.stringify(['CLOSED', 's1', 'reason']),
      JSON.stringify(['AUTH', 'challenge']),
      JSON.stringify({ op: 'event', event: {} }), // the dev framing
      'not json at all',
    ]) {
      expect(solverCodec.decodeEvent(raw)).toBeNull()
    }
  })

  it('drops events whose fields are the wrong type, without leaning on verifyEvent', () => {
    // Each mutation is rejected by our own schema; none may reach the library
    // and depend on it throwing or returning false. `tags` covers the element
    // type too, which a bare Array.isArray check left unasserted.
    const [, event] = JSON.parse(clientCodec.encodeEvent(directed({ v: 1 })))
    for (const bad of [
      { id: 42 },
      { pubkey: null },
      { sig: [] },
      { kind: '24859' },
      { created_at: 'now' },
      { tags: 'p' },
      { tags: [['p', 7]] },
    ]) {
      expect(solverCodec.decodeEvent(JSON.stringify(['EVENT', 's1', { ...event, ...bad }]))).toBeNull()
    }
  })

  it('drops an event whose first matching tag carries no value, rather than scanning past it', () => {
    // First match wins. A peer prefixing a valueless ['p'] before the real one
    // gets silence, not a quietly-skipped malformed tag — undefined is how
    // every caller spells "drop".
    //
    // Signed here rather than patched onto an encoded event: mutating `tags`
    // after the fact breaks the signature, so verifyEvent would reject it
    // first and the test would pass no matter what firstTag did. This event
    // is valid in every respect EXCEPT the shadowing tag, so the tag logic is
    // the only variable.
    const shadowed = finalizeEvent(
      {
        kind: NOSTR_KIND_DIRECTED,
        created_at: 1_800_000_000,
        tags: [['p'], ['p', solver.pubkey]],
        content: encrypt(JSON.stringify({ v: 1 }), getConversationKey(client.secretKey, solver.pubkey)),
      },
      client.secretKey,
    )
    expect(solverCodec.decodeEvent(JSON.stringify(['EVENT', 's1', shadowed]))).toBeNull()
  })

  it('drops oversized content before touching the ciphertext', () => {
    const [, event] = JSON.parse(clientCodec.encodeEvent(directed({ v: 1 })))
    event.content = 'A'.repeat(20_000)
    expect(solverCodec.decodeEvent(JSON.stringify(['EVENT', 's1', event]))).toBeNull()
  })

  it('refuses to sign as anyone but its own identity, and refuses unaddressed events', () => {
    expect(() => solverCodec.encodeEvent(directed({ v: 1 }))).toThrow(/refusing to sign/)
    expect(() => clientCodec.encodeEvent({ id: 'x', author: client.pubkey, createdAtMs: 1, payload: {} })).toThrow(
      /recipient or a topic/,
    )
  })
})

describe('nostrCodec relay feedback', () => {
  // Verified against strfry 1.0.4 (nostr.arkade.sh): every EVENT is answered
  // with an OK naming the policy that accepted or refused it. Discarding
  // those frames makes "the relay refuses everything we publish" look exactly
  // like "the market is quiet", which is how a dead solver stays undiagnosed.
  it('surfaces OK-false, CLOSED and NOTICE — the frames that carry a refusal', () => {
    expect(solverCodec.decodeNotice!(JSON.stringify(['OK', 'abc', false, 'blocked: kind not allowed']))).toEqual({
      kind: 'rejected',
      ref: 'abc',
      message: 'blocked: kind not allowed',
    })
    expect(solverCodec.decodeNotice!(JSON.stringify(['CLOSED', 's1', 'error: too many filters']))).toEqual({
      kind: 'subscription-closed',
      ref: 's1',
      message: 'error: too many filters',
    })
    expect(solverCodec.decodeNotice!(JSON.stringify(['NOTICE', 'rate limited']))).toEqual({
      kind: 'notice',
      message: 'rate limited',
    })
  })

  it('distinguishes an accepted publish from a refused one', () => {
    const ok = solverCodec.decodeNotice!(JSON.stringify(['OK', 'abc', true, '']))
    expect(ok?.kind).toBe('accepted')
  })

  it('says nothing about ordinary traffic or frames it cannot read', () => {
    // EVENT and EOSE are the normal case, not news; garbage must not throw.
    for (const raw of [
      JSON.stringify(['EVENT', 's1', {}]),
      JSON.stringify(['EOSE', 's1']),
      JSON.stringify({ not: 'an array' }),
      'not json at all',
    ]) {
      expect(solverCodec.decodeNotice!(raw)).toBeNull()
    }
  })

  it('reports the since it actually put on the wire, truncated to whole seconds', () => {
    // The connection matches against this locally, so it must never be
    // stricter than the REQ we sent — otherwise live events are dropped after
    // the relay correctly delivered them.
    const armed = solverCodec.effectiveFilter!({ recipient: solver.pubkey, sinceMs: 1_800_000_000_500 })
    expect(armed.sinceMs).toBe(1_800_000_000_000)
    // And it agrees with encodeSub, which is the point of reporting it.
    const [, , wire] = JSON.parse(solverCodec.encodeSub('s1', { recipient: solver.pubkey, sinceMs: 1_800_000_000_500 }))
    expect(wire.since).toBe(1_800_000_000)
    // A filter with no since is carried through untouched.
    expect(solverCodec.effectiveFilter!({ recipient: solver.pubkey })).toEqual({ recipient: solver.pubkey })
  })
})
