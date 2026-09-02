/**
 * The Nostr wire dialect (docs/rfq-protocol.md § 3.1) — the production codec
 * behind {@link WireCodec}: NIP-01 framing, kind 24859 for directed RFQ
 * traffic (NIP-44-sealed, `p`-tagged), kind 24860 for open-RFQ broadcasts
 * (plaintext, `t`-tagged with the § 2 market key).
 *
 * Every inbound event is signature-verified before anything else, a directed
 * event is readable only when it is sealed to OUR key, and every failure
 * decodes to null — on a shared relay, silence, never an error, is the
 * response to traffic that is not ours (§ 4.6).
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44'
import { z } from 'zod'
import type { RelayEvent, RelayFilter, RelayNotice, WireCodec } from './connection.js'

/**
 * Provisional kind numbers (docs/rfq-protocol.md § 3.1, § 12).
 *
 * Both sit in NIP-01's EPHEMERAL range (20000 ≤ n < 30000), and that range is
 * the whole point rather than an arbitrary pick. RFQ traffic is a negotiation:
 * a request nobody answered inside the client's 30-second patience, or a quote
 * past its `valid_until`, is worthless to everyone. In the regular range these
 * kinds started in (4859/4860) a relay stores them and serves them to any
 * subscriber who asks, forever — which cost two distinct things:
 *
 *  - PRIVACY. `rfq_open` is plaintext by design (§ 4.6), so a permanent public
 *    archive of every broadcast is a permanent public record of trade intent,
 *    pair and size. Directed traffic is NIP-44 sealed so its content is safe,
 *    but who negotiated with whom, when and how often is metadata no amount of
 *    client-side care removes once a relay has written it down.
 *  - CORRECTNESS. A stored backlog is a backlog to replay, so every reconnect
 *    re-delivered stale opens. `sinceMs` on both subscriptions
 *    (`src/ingress/relay.ts`) still bounds that — it is also a freshness
 *    policy, not only a workaround — but with nothing to replay the whole
 *    class stops depending on the client getting it right.
 *
 * The cost, stated honestly: ephemeral means no store-and-forward, so a
 * request sent while this solver is disconnected is dropped rather than
 * queued. The reference client's 30-second timeout and retry already covers
 * that, and a swap quoted from a request the solver never saw would have been
 * refused as stale anyway.
 *
 * docs/relay-transport.md § 4(b) has the measurements behind this, including
 * the live retention check on the relay this deployment actually uses.
 */
export const NOSTR_KIND_DIRECTED = 24859
export const NOSTR_KIND_BROADCAST = 24860

/**
 * Ceiling on an inbound frame, checked before anything is parsed: it is the
 * only size bound this codec controls itself (a relay-side message cap is
 * someone else's config), and without it a hostile peer's megabyte tag arrays
 * get fully JSON-parsed and SHA-256'd per event before any gate rejects them.
 * Protocol payloads top out around an invoice (≤ 2048 chars) plus envelope
 * plus NIP-44 expansion, far under this.
 */
const MAX_FRAME_CHARS = 32_768

export interface NostrIdentity {
  /** 32-byte secret, signing events and deriving NIP-44 conversation keys. */
  secretKey: Uint8Array
  /** x-only hex of `secretKey` — the pubkey RFQ traffic is addressed to. */
  pubkey: string
}

/**
 * The wallet identity as a Nostr identity: the SAME key the registry card
 * advertises as `discovery_pubkey` and the SDK identity signs with —
 * BIP86 at `m/86'/{0|1}'/0'/0/0`, untweaked, exactly as the SDK's
 * SeedIdentity derives it. Production entry points bind it through
 * {@link nostrCodecForWallet}, which asserts the derived pubkey equals the
 * wallet identity's — the check this derivation must never run without.
 */
export const deriveNostrIdentity = (mnemonic: string, isMainnet: boolean): NostrIdentity => {
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(`m/86'/${isMainnet ? 0 : 1}'/0'/0/0`)
  if (!node.privateKey) throw new Error('BIP86 derivation yielded no private key')
  return { secretKey: node.privateKey, pubkey: bytesToHex(schnorr.getPublicKey(node.privateKey)) }
}

/**
 * The NIP-01 event envelope. Scoped here deliberately: `src/wire/payloads.ts`
 * owns RFQ *payloads* and says so — this is the transport frame around them.
 * `tags` is validated to its element type, which the old hand-written
 * `Array.isArray` check left entirely unasserted.
 */
const NostrEvent = z.object({
  id: z.string(),
  pubkey: z.string(),
  kind: z.number(),
  created_at: z.number(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string(),
})

/**
 * The value of the FIRST tag with this name — first match wins, and a match
 * carrying no value yields undefined rather than scanning on to a later one.
 * That is deliberate: every caller treats undefined as "drop the event", so a
 * peer sending `[['p'], ['p', <us>]]` is silently ignored instead of having a
 * malformed tag quietly skipped in its favour. The schema already guarantees
 * the elements are strings, so undefined here means the tag had no value.
 */
const firstTag = (tags: string[][], name: string): string | undefined => tags.find((tag) => tag[0] === name)?.[1]

/** A frame field when it is a string, else undefined. Relay frames are loose. */
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** A `since` as NIP-01 carries it: whole unix seconds. */
const sinceOnWire = (sinceMs: number): number => Math.floor(sinceMs / 1000)

/**
 * A relay frame as an array, or null — size-capped and never throwing.
 *
 * Shared by both decoders so the {@link MAX_FRAME_CHARS} ceiling cannot apply
 * to one and not the other. It could before: the connection hands every frame
 * `decodeEvent` rejected to `decodeNotice`, so an oversized frame took the
 * early return and was then fully parsed anyway — exactly the parse the cap
 * exists to prevent.
 */
const parseFrame = (raw: string): unknown[] | null => {
  if (raw.length > MAX_FRAME_CHARS) return null
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Codec for the wallet identity, with the drift gate built in: derives the
 * BIP86 key from the mnemonic and REFUSES unless it equals `expectedPubkey`
 * (the wallet identity the registry card advertises). The check lives here so
 * no entry point can construct a wallet-bound codec without it — a drifted
 * key would sign as, and decrypt for, a key nobody addresses, silently,
 * forever.
 */
export const nostrCodecForWallet = (mnemonic: string, isMainnet: boolean, expectedPubkey: string): WireCodec => {
  const identity = deriveNostrIdentity(mnemonic, isMainnet)
  if (identity.pubkey !== expectedPubkey) {
    throw new Error(
      `nostr identity ${identity.pubkey} does not match the wallet identity ${expectedPubkey}; ` +
        'the BIP86 derivation in src/relay/nostr.ts has drifted from the SDK',
    )
  }
  return nostrCodec(identity)
}

/** NIP-01 codec bound to one identity. */
export const nostrCodec = (identity: NostrIdentity): WireCodec => {
  // NIP-44 conversation keys are deterministic per counterparty but cost an
  // ECDH + HKDF each; an RFQ negotiation exchanges several messages with one
  // peer. Bounded, insertion-order-evicted, so a flood of distinct pubkeys
  // cannot grow it.
  const conversationKeys = new Map<string, Uint8Array>()
  const conversationKey = (peer: string): Uint8Array => {
    const cached = conversationKeys.get(peer)
    if (cached) return cached
    const key = getConversationKey(identity.secretKey, peer)
    if (conversationKeys.size >= 256) conversationKeys.delete(conversationKeys.keys().next().value!)
    conversationKeys.set(peer, key)
    return key
  }

  return {
    // NIP-01 carries `created_at` in whole seconds, so a `since` loses its
    // sub-second part on the way out. Reported here and APPLIED below from the
    // same function, so the filter the connection matches against locally
    // cannot drift from the one it actually sent.
    effectiveFilter: (filter: RelayFilter): RelayFilter =>
      filter.sinceMs === undefined ? filter : { ...filter, sinceMs: sinceOnWire(filter.sinceMs) * 1000 },

    encodeSub: (id: string, filter: RelayFilter): string => {
      const nostrFilter: Record<string, unknown> = {}
      if (filter.recipient !== undefined) {
        nostrFilter.kinds = [NOSTR_KIND_DIRECTED]
        nostrFilter['#p'] = [filter.recipient]
      } else if (filter.topic !== undefined) {
        nostrFilter.kinds = [NOSTR_KIND_BROADCAST]
        nostrFilter['#t'] = [filter.topic]
      } else {
        // An unconstrained REQ on a public relay is a firehose nothing here
        // could want; refusing loudly beats subscribing to the world.
        throw new Error('nostr subscription needs a recipient or a topic')
      }
      if (filter.sinceMs !== undefined) nostrFilter.since = sinceOnWire(filter.sinceMs)
      return JSON.stringify(['REQ', id, nostrFilter])
    },

    encodeUnsub: (id: string): string => JSON.stringify(['CLOSE', id]),

    encodeEvent: (event: RelayEvent): string => {
      // The wire pubkey is whoever signs — us. An author field claiming anyone
      // else would publish a lie; refuse instead.
      if (event.author !== identity.pubkey) {
        throw new Error(`refusing to sign an event authored by ${event.author} with key ${identity.pubkey}`)
      }
      const createdAt = Math.floor(event.createdAtMs / 1000)
      const payloadJson = JSON.stringify(event.payload)
      let template
      if (event.recipient !== undefined) {
        template = {
          kind: NOSTR_KIND_DIRECTED,
          created_at: createdAt,
          tags: [['p', event.recipient]],
          content: encrypt(payloadJson, conversationKey(event.recipient)),
        }
      } else if (event.topic !== undefined) {
        template = {
          kind: NOSTR_KIND_BROADCAST,
          created_at: createdAt,
          tags: [['t', event.topic]],
          content: payloadJson,
        }
      } else {
        // Nothing in the protocol publishes an event that is neither addressed
        // nor topiced; reaching this is a bug upstream, not a wire case.
        throw new Error('nostr event needs a recipient or a topic')
      }
      return JSON.stringify(['EVENT', finalizeEvent(template, identity.secretKey)])
    },

    /**
     * NIP-01's out-of-band frames, the ones that carry every reason a relay
     * refuses to work with us: `OK` (was our event stored?), `CLOSED` (the
     * relay tore down a REQ we still think is live), `NOTICE` (free text).
     *
     * These exist because a relay's rejections are otherwise completely
     * silent. strfry, for one, answers every EVENT with an `OK` whose reason
     * string names the policy that refused it — `blocked:`, `rate-limited:`,
     * `invalid:` — and a deployment that discards them presents "the relay
     * accepted everything and the market is quiet" and "the relay is refusing
     * every event we publish" as the same observation.
     *
     * Only frames about US: `EVENT` and `EOSE` are normal traffic, not news.
     */
    decodeNotice: (raw: string): RelayNotice | null => {
      const message = parseFrame(raw)
      if (!message) return null
      const [type, first, second, third] = message
      if (type === 'OK') {
        // ["OK", <event id>, <true|false>, <reason>]
        return { kind: second === false ? 'rejected' : 'accepted', ref: text(first), message: text(third) }
      }
      if (type === 'CLOSED') return { kind: 'subscription-closed', ref: text(first), message: text(second) }
      if (type === 'NOTICE') return { kind: 'notice', message: text(first) }
      return null
    },

    decodeEvent: (raw: string): RelayEvent | null => {
      const message = parseFrame(raw)
      if (!message || message[0] !== 'EVENT') return null
      // ["EVENT", subId, event] from a relay; a peer echo without subId is not
      // a shape NIP-01 delivers, so the event is strictly at index 2. PARSED,
      // not asserted: an `as` cast would be unfounded until hand-written
      // typeof guards backed it up, and every field added later would need a
      // matching guard remembered separately — add to the type, forget the
      // check, and the new field is silently trusted. verifyEvent would reject
      // most bad shapes too, but relying on that makes a third-party library's
      // internal robustness load-bearing for our correctness.
      const parsed = NostrEvent.safeParse(message[2])
      if (!parsed.success) return null
      const event = parsed.data

      // The cheap gates run before the signature: an event of a foreign kind,
      // or sealed to someone else, is dropped without paying a schnorr verify.
      // Anything that survives is verified BEFORE its payload is used.
      let recipient: string | undefined
      let topic: string | undefined
      if (event.kind === NOSTR_KIND_DIRECTED) {
        recipient = firstTag(event.tags, 'p')
        if (recipient !== identity.pubkey) return null
      } else if (event.kind === NOSTR_KIND_BROADCAST) {
        topic = firstTag(event.tags, 't')
        if (topic === undefined) return null
      } else {
        return null
      }
      try {
        if (!verifyEvent(event as Parameters<typeof verifyEvent>[0])) return null
      } catch {
        return null
      }

      try {
        const plaintext =
          recipient !== undefined ? decrypt(event.content, conversationKey(event.pubkey)) : event.content
        const payload: unknown = JSON.parse(plaintext)
        return {
          id: event.id,
          author: event.pubkey,
          ...(recipient !== undefined ? { recipient } : { topic }),
          createdAtMs: event.created_at * 1000,
          payload,
        }
      } catch {
        return null
      }
    },
  }
}
