# The RFQ transport: what is actually slow, and what to build

**Status: analysis + decision record.** Written against a live deployment
(`wss://nostr.arkade.sh`, strfry 1.0.4) and the strfry source at
`9acdaeb`. Every number below was measured, not estimated; where something is
inferred it says so.

The question this answers: the RFQ bus "does not work with strfry" and feels
slow, so should the transport become a bespoke WebSocket bus with its own
encryption, or a custom relay that stays NIP-compliant?

The short version: **the two options were never mutually exclusive, and the
thing making it feel slow is neither the wire format nor the crypto.**

---

## 1. Why it did not work

Not a strfry incompatibility. Probed directly (`scripts/probe-relay.mjs`):

| check | result |
| --- | --- |
| relay accepts kind 4859 (directed, NIP-44) | `OK accepted=true` |
| relay accepts kind 4860 (broadcast, `t`-tagged) | `OK accepted=true` |
| relay accepts ephemeral-range 24859 / 24860 | `OK accepted=true` |
| our request delivered to a subscriber shaped exactly like the solver's filter | yes |
| full production stack round trip (`webSocketRelayConnection` + `nostrCodec`, client → solver → reply → client) | **~460 ms, working** |
| events ever authored by the card's `discovery_pubkey` on that relay | **zero** |

The relay works, the wallet's framing works, and the solver's own transport
stack works end to end against it. What the relay has never seen is the
solver. An `authors:[<solver>]` query over strfry's whole retained history
returns nothing, so the process is not connected there — wrong `RELAY_URL`,
a different `ARK_MNEMONIC` than the card advertises, or simply not running.

The reason that took so long to establish is the real defect, and it was in
our code: `WireCodec.decodeEvent` returned `null` for every frame that was
not a delivered `EVENT`, which is exactly where NIP-01 puts the diagnosis.
`OK` (was the event stored, and if not why), `CLOSED` (the relay tore down a
subscription we still believe is live) and `NOTICE` were all discarded. A
relay refusing every publish and an idle market produced byte-identical
output: silence. That is fixed — codecs decode notices, the connection
forwards them, `cli relay` logs them.

Two other faults were live on that path, both now fixed and both measured:

- **The directed subscription asked for the archive.** `{kinds,#p}` with no
  `since` and no `limit` made strfry replay every stored request addressed to
  the solver on every connect *and every reconnect*, bounded only by its
  advertised `max_limit` of 500. Measured: 12 published, 12 replayed; with
  `limit:0` or `since:now`, zero. The ingress answers every well-formed
  request, so each reconnect signed and published a burst of replies to
  negotiations whose clients gave up long ago — roughly 8 ms of blocked CPU
  per replayed request, and up to 500 unsolicited events at the relay.

- **A sub-second dead window.** Nostr's `created_at` is whole seconds, so
  `since` went out floored while the local filter compared the reconstructed
  `created_at * 1000` against unfloored milliseconds. Every event in the
  subscribe second was dropped *after* the relay correctly delivered it — up
  to 999 ms of blindness after every subscribe and reconnect, landing exactly
  on § 4.6's few-second bid window.

---

## 2. Where the time actually goes

The hypothesis under test was that time is lost between "websocket connection
→ serialization → encrypt/decrypt". Measured on the RFQ hot path with
realistic payloads (`rfq_open` 195 B, `rfq_request` 557 B, NIP-44 ciphertext
944 B, full wire frame 1379 B):

| stage | cost | share of codec |
| --- | ---: | ---: |
| `JSON.stringify` + `JSON.parse` + zod `safeParse` | **7.3 µs** | 0.1 % |
| NIP-44 encrypt (conversation key cached) | 174 µs | 4 % |
| NIP-44 decrypt (conversation key cached) | 110 µs | 3 % |
| schnorr **sign** (`finalizeEvent`) | **4 011 µs** | 87 % of encode |
| schnorr **verify** (`verifyEvent`) | **3 099 µs** | 92 % of decode |
| ECDH + HKDF (`getConversationKey`, uncached) | **5 036 µs** | — |
| `encodeEvent` total | 4 614 µs | |
| `decodeEvent` total | 3 352 µs | |
| **4 codec passes per RFQ round trip** | **15.9 ms** | |
| **measured live round trip** | **~460 ms** | |
| **codec share of wall clock** | | **3.5 %** |

Two conclusions, both against the hypothesis:

**Serialization is not the cost.** JSON plus schema validation is 7.3 µs per
message — 0.0016 % of the round trip. A binary wire format (CBOR, protobuf,
length-prefixed frames) can remove at most that. It is not a rounding error
on the budget; it is below the noise floor of the budget.

**Encryption is not the cost either — signing is.** Symmetric NIP-44 is
~140 µs. What costs milliseconds is asymmetric: schnorr sign, schnorr verify,
and ECDH. Those are not Nostr's overhead. They are the price of
non-repudiation (a signed quote the client can later prove) and end-to-end
confidentiality (bids the relay operator cannot read). A bespoke bus that
keeps both properties pays exactly the same; one that drops them is a
different security model, not a faster transport.

Caveat, stated plainly: these are pure-JS `@noble` numbers on a 4-core
sandbox. Native libsecp256k1 bindings are roughly an order of magnitude
faster, and a real server is quicker still. That moves the absolute figures,
not the ratios — and it makes the case *stronger*, since the only part a
bespoke format could optimise is the part already at 0.1 %.

The one crypto finding worth acting on: **the conversation-key cache is
load-bearing and the protocol is defeating it.** An uncached
`getConversationKey` is 5 ms — larger than encode and decode combined. The
cache is 256-entry FIFO, and § 4.6 tells clients to use a fresh transport key
per open RFQ, so on the broadcast path the hit rate tends to zero and every
first message from a new peer costs a full ECDH. That is the single largest
per-message cost in the system and it is a *protocol* interaction, not an
implementation bug.

So the real budget is: **one relay round trip (~100 ms per hop here)
dominates, and everything else is noise.** Latency work means removing round
trips and moving the relay closer, not changing the format.

---

## 3. The dialectic

### Thesis — build a bespoke WebSocket bus

The RFQ bus is a latency-critical, confidential, permissioned matching venue.
Nostr is a general-purpose public publishing protocol. Using one for the
other is an impedance mismatch: you inherit JSON, base64, tag indexing,
persistence and public archival you never wanted, and relay semantics tuned
for social feeds rather than auctions. Build what you actually need — binary
frames, Noise or TLS-terminated confidentiality, server-side bid aggregation
so a thin client gets one best price instead of N sealed envelopes.

**What it gets right.** The storage and retention semantics of a general
relay are genuinely wrong for an auction, and this was not theoretical. Kind
4860 was in NIP-01's *regular* range, so an `rfq_open` — **plaintext trade
intent, pair and size** — was written to LMDB and served to any subscriber
who asked, forever. Directed traffic is NIP-44 sealed so its content was
safe, but the metadata (who negotiated with whom, when, how often) was
permanently archived and publicly queryable. For a venue whose §4.6 design
goal is *sealed* bidding, a permanent public record of every intent is a real
leak, and no amount of client-side care fixes it. This is what § 4(b) below
fixed by moving both kinds to the ephemeral range; the diagnosis stands as
the reason. The thesis is also right that
server-side aggregation could remove a round trip, and round trips are the
budget.

**What it gets wrong.** It misdiagnoses the cost. The measurements say the
format is 0.1 % and the expensive crypto is the part a bespoke bus must
reimplement identically or abandon. And it quietly destroys the property
§ 3.1 names as load-bearing: *no URLs appear anywhere in the protocol, which
is what makes a fleet of solvers a config change rather than a rewrite.*
Parties are addressed by pubkey; rendezvous is data in a signed card. A
bespoke protocol means every solver implements our wire format, our
handshake, our encryption — and the bus operator stops being a swappable
rendezvous and becomes a singular, trusted intermediary. Server-side
aggregation makes that worse in the specific way § 12 already flags: the bus
picking the winner requires public signed bids for auditability, which is the
opposite of sealed. NEAR Intents is the honest comparison here — its solver
bus is exactly this design, authenticated and centrally operated, forwarding
each request to all connected solvers and returning every quote after a
3000 ms window. That works, and it is one company's endpoint.

### Antithesis — keep Nostr, own the relay

Keep NIP-01 on the wire and make the *implementation* bespoke. Compliance is
nearly free and buys real things: any solver with an off-the-shelf Nostr
library can join, event signatures give non-repudiation with no extra
machinery, multiple relays give redundancy and censorship resistance for
free, and the registry card's transport map already names `nostr` as its
protocol key.

**What it gets right.** NIP-01 is a wire format, not an implementation. Every
cost measured above that is actually attributable to the transport belongs to
*strfry's policy* — what it stores, how long it keeps it, what it replays on
reconnect — not to the framing. Those are knobs on a relay you run.

**What it gets wrong, if taken naively.** "Use a faster relay" does not fix
the archive, and it does not give admission control or aggregation. Moving to
NIP-01's *ephemeral* kind range (20000 ≤ n < 30000) is the obvious protocol
answer, and it only half-works on strfry — which is worth knowing before
betting on it. strfry **writes ephemeral events to LMDB anyway** and deletes
them from a 9-second cron once they pass `ephemeralEventsLifetimeSeconds`
(default 300 s), while refusing ephemeral events older than
`rejectEphemeralEventsOlderThanSeconds` (default 60 s).

Confirmed live rather than read off the source — one kind 4860 and one kind
24860 published together under the same tag, then re-queried from cold
connections:

| elapsed | retained on `nostr.arkade.sh` |
| --- | --- |
| immediately | 24860, 4860 |
| ~2 min | 24860, 4860 |
| ~5 min | **4860 only** — the ephemeral event is gone |

So ephemeral kinds turn a permanent public archive into a five-minute one and
structurally delete the backlog-replay bug class — a large win, available on
the relay we already run — but they do not remove the disk write from the hot
path. Getting that requires a relay that honours the semantics, which is to
say: owning the relay.

### Synthesis

The two positions never actually disagreed about the wire format. Neither one
has an argument for changing it — the thesis assumed the format was the cost
and the measurements say it is 0.1 %. What they disagree about is **who sets
relay policy**, and that is a deployment question, not a protocol one.

Every real cost is (a) round trips and (b) retention and replay policy.
Neither is a property of NIP-01. Both are properties of the relay you run. So
the resolution is to keep NIP-01 — free interoperability, free
non-repudiation, already the card's transport key — **and own the relay**, so
retention, admission and fanout are yours. That is simultaneously bespoke and
compliant. "Custom relay" and "NIP-compliant" were presented as a trade-off
and are not one.

This also preserves the exit. Because rendezvous is keyed by protocol in the
card (`transports: { nostr: { relays } }`, `additionalProperties: false`), a
genuinely different bus is a new key plus a new `WireCodec` — the seam that
already exists in `packages/solver-transport/src/relay/connection.ts` and is already exercised by two
dialects. If measurement later shows a bespoke protocol earns its keep,
nothing above the codec has to move. Nothing measured so far says it does.

---

## 4. What to do, in order

**(a) Already landed — unblocks diagnosis today.** Surface `OK`/`CLOSED`/
`NOTICE`; bound subscription replay to a two-minute lookback that advances
with the newest event seen; declare wire-stamp granularity so the local
filter cannot drop what the relay correctly delivered; escalate reconnect
backoff only after a connection has held; encode events only when there is a
socket. Plus `scripts/probe-relay.mjs`, which answers "is the solver
reachable, and which side is at fault" in one command.

**(b) Landed on this side — the RFQ kinds are in the ephemeral range.** 4859 →
24859, 4860 → 24860 (`packages/solver-transport/src/relay/nostr.ts`). This is pure NIP-01, works on
strfry today (verified: accepted and delivered), and it was the highest-value
change available because it fixes a *privacy* defect and a *correctness*
defect at once: plaintext trade intent stops being permanently archived, and
there is no backlog to replay so the whole reconnect-storm class disappears
structurally rather than by client-side care. The kinds were marked
provisional in § 12, so this was the moment. The cost, stated honestly —
ephemeral means no store-and-forward, so a request sent while the solver is
disconnected is lost rather than replayed, which the 30-second client timeout
and retry already cover.

**This is a WIRE BREAK, and only half of it is done.** A solver on the new
kinds and a client on the old ones do not see each other at all: they subscribe
to disjoint `kinds` filters, so there is no error to read, just silence. The
counterparties still to move are the wallet (`src/lib/nostrRfq.ts`,
`RFQ_DIRECTED_KIND`) and the ts-sdk client side. Until they land, either
deploy both ends together or have the clients subscribe to old and new kinds
at once and drop the old filter afterwards — this repo publishes on the new
kinds only, deliberately, because dual-publishing plaintext `rfq_open` to a
regular kind would keep the archive this change exists to remove.

**(c) Then, if and only if the numbers justify it: run the relay.** The
measurements do not support a bespoke *protocol*; they do support owning the
*implementation*, for retention and admission rather than for speed. Build it
as a compliant NIP-01 relay — [khatru](https://github.com/fiatjaf/khatru) is
a Go framework designed for exactly this, with pluggable event stores and a
policy package — and the optimisations worth having are:

- **no persistence for RFQ traffic** (the disk write ephemeral kinds do not
  remove on strfry);
- **O(1) fanout** indexed by `p` tag and `t` tag, since RFQ traffic is keyed
  by exactly those two, instead of a general filter scan per subscription;
- **pre-serialised fanout** — serialise the event body once and concatenate
  the per-subscriber `["EVENT","<subid>",` prefix, rather than re-stringifying
  per recipient;
- **verify once at ingest**;
- **TCP_NODELAY on, permessage-deflate off** for sub-kilobyte frames;
- **admission control** — NIP-42 AUTH and per-pubkey rate limits, with the
  allowlist derived from the solver registry.

Expected gain: this removes relay-side work measured in single-digit
milliseconds against a ~100 ms network hop. **Co-locating the relay with the
solvers is worth more than all of it**, and should be done first.

**(d) Do not do these.**

- *Do not replace JSON with a binary format for speed.* Measured ceiling:
  7.3 µs per message, 0.0016 % of the round trip.
- *Do not drop signatures to save the 4 ms.* They are what makes a quote
  provable and a bid a commitment (§ 4.6); losing them costs the enforcement
  model, and reputational enforcement is all § 12 leaves us.
- *Do not move confidentiality from end-to-end to transport-level.* NIP-44 is
  ~140 µs and it is why a bus operator cannot read bids. Sealed-bid is the
  design.
- *Do not have the bus pick the winner* without first resolving § 12's
  auditability question — a matcher that chooses needs public signed bids,
  which contradicts sealed bidding.

**Open, and worth measuring next:** the conversation-key cache (§ 2). A
5 ms ECDH on every first contact, with § 4.6 driving clients to a fresh key
per trade, is now the largest single per-message cost in the system. Options
are a native secp256k1 binding, an LRU rather than FIFO with a longer
horizon, or reconsidering whether per-trade key rotation is worth its price
on the directed path.
