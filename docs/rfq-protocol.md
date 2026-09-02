# RFQ protocol v1 — quote negotiation for Arkade swaps

**Status: draft, v1.** Self-contained: everything an external team needs to
build a solver bot in any language is in this document. Where a rule is
implemented today, the reference implementation file is cited as ground truth;
where a profile is forward-looking, it is marked as such. Nostr event kind
numbers are **provisional** (see [Open questions](#12-open-questions)).

RFQ (request-for-quote) is the standard negotiation layer for **all** swap
corridors: Lightning, cross-chain, and arkade-to-arkade. The older idea of
discovering open offers on the arkd transaction stream (mempool-style, no
negotiation) is rescoped to **liquid spot pairs** only (e.g. BTC/USD) and is
out of scope for this spec — the Lightning legs use RFQ permanently.

---

## 1. Conventions

- **MUST / SHOULD / MAY** as in RFC 2119.
- **Client** — the party asking for a quote and (in HTLC-class swaps) funding
  the settlement contract. **Solver** — the party quoting and filling.
- All wire amounts are **integers in atomic units** of the named asset,
  encoded as canonical decimal strings (§ 2.1). No floats, no msats, anywhere,
  and no JSON numbers.
  - Earlier drafts of this spec required amounts to fit in `2^53 − 1` "for
    JSON interoperability", on the assumption that an asset would register
    decimals such that realistic amounts fit. That assumption does not hold:
    an ERC20's precision is fixed by its own contract, not by this registry,
    and at 18 decimals `2^53 − 1` is 0.009 tokens. The constraint was
    describing a limitation of the encoding, so the encoding changed.
- All payload timestamps are **unix seconds** (integers). Transport-level
  stamps (a Nostr event's `created_at`, the dev broker's `createdAtMs`) belong
  to the transport, not the protocol; never read protocol deadlines from them.
- Binary values are lowercase hex unless a field says otherwise. Public keys
  are 32-byte x-only, hex (64 chars).
- **Directed requests are strict**: a directed request containing unknown
  fields MUST be rejected with refusal reason `unsupported_payload`.
  Broadcasts are never refused at all (§ 4.6). **Responses are tolerant**:
  clients MUST ignore unknown fields in quotes, bids, refusals and statuses,
  so solvers can extend responses without a version bump.

## 2. Corridors, assets, pairs

A **leg** is `<corridor>:<asset>`. A **pair** is directional:
`<from-leg>-><to-leg>`. Direction matters — `arkade:BTC->lightning:BTC` and
`lightning:BTC->arkade:BTC` are different pairs with different settlement
profiles.

Initial corridor registry:

| corridor    | meaning                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `arkade`    | the Arkade offchain corridor (canonical name — not "offchain", which becomes ambiguous the moment a second offchain system exists) |
| `lightning` | BOLT11 Lightning payments                                                                                                          |
| `onchain`   | Bitcoin L1                                                                                                                         |
| `ethereum`  | Ethereum L1                                                                                                                        |

Initial asset registry:

| asset   | id (canonical) | decimals | atomic unit |
| ------- | -------------- | -------- | ----------- |
| `BTC`   | `btc`          | 8        | sat         |
| `USDT`  | `usdt`         | 6        | micro-USDT  |
| `USDC`  | `usdc`         | 6        | micro-USDC  |
| `DePix` | `depix`        | 8        | —           |

`id` is the canonical asset identity — `btc` for bitcoin, and the serialized
Arkade AssetId in lowercase hex (68 chars, network-scoped) for every other
asset; the same identity rule the solver-registry uses
(`^(btc|[0-9a-f]{68})$`, `schema/card.schema.json`). The non-BTC ids in the
table above are protocol-local placeholders standing in for those AssetIds,
not registry-valid ids. It appears wherever this spec says "asset id" (the
open-RFQ tag above all); `asset` tickers appear in the directional `pair`
strings.

Those 68 characters are not opaque, and an implementation that treats them as
opaque will not be able to build a covenant over the asset. An Arkade AssetId
is always the **pair** `(genesis txid, group index)` — the transaction that
minted the asset, and the index of the asset group inside it — serialized as:

```
AssetId := { txid: bytes32, gidx: u16 LE }    # 34 bytes = 68 hex characters
```

Two properties are load-bearing for anyone implementing against this, and
neither is guessable from the character count:

- **`gidx` is little-endian**, per Arkade Assets' rule that multi-byte integer
  fields follow Bitcoin's convention. Reading it big-endian does not fail — it
  silently names a _different_ asset (group `1` becomes group `256`).
- **`txid` is a byte string, so the endianness rule above does not apply to
  it — but a script inspecting the asset must still REVERSE it.** The id's
  leading 64 characters are the genesis txid as the SDK reports it; the
  ArkadeScript introspection opcodes match against those 32 bytes **reversed**.
  Push them unreversed and `OP_INSPECTOUTASSETLOOKUP` reports the asset absent
  (`0 0`) — the covenant then fails with nothing in the error naming the cause.
  Verified on regtest against a real minted asset.

The pair form is also what the ArkadeScript asset-introspection opcodes consume
(`OP_INSPECTOUTASSETLOOKUP` takes `o asset_txid asset_gidx` as three separate
stack items), so a script binding an asset must split the id rather than push
it whole.

### 2.1 Amount encoding *(specified; NOT yet implemented — the solver ingress

still declares these fields as JSON numbers in `src/wire/payloads.ts` and its
three sibling schemas, and the ts-sdk client does the same in
`packages/swap/src/rfq.ts`. Both sides must change together; this section is
the contract they change against.)*

Every amount in this protocol — `amount`, `from_amount`, `to_amount`, and the
bounds a solver advertises — is **atomic units of one named asset**, encoded as
a **canonical decimal string**.

```json
"amount": "50000"
```

Canonical means: ASCII digits only, no sign, no decimal point, no exponent, no
leading zero unless the value is exactly `"0"`. Formally `^(0|[1-9][0-9]*)$`.
A receiver parses it as an arbitrary-precision integer.

**Why a string, and not a JSON number.** JSON numbers are IEEE-754 doubles in
every mainstream parser, so they are exact only to 2^53 − 1 ≈ 9.007e15. For an
18-decimal asset that ceiling is **0.009 tokens**: a quote for one whole USDT
would be rounded by `JSON.parse` before any validator in either implementation
could see it, and neither side could detect that it had happened. The
protocol's own asset registry already admits assets whose atomic unit makes
this reachable, so the encoding has to carry the range the registry implies.
This is not a hypothetical: at the time of writing both the solver ingress and
the SDK client independently typed these fields as JSON numbers.

**Which asset an amount is in** is never carried beside the amount. It is
determined by the pair and the field:

| field                   | asset                          |
| ----------------------- | ------------------------------ |
| `rfq_request.amount`    | the leg named by `amount_side` |
| `rfq_quote.from_amount` | the `from` leg of `pair`       |
| `rfq_quote.to_amount`   | the `to` leg of `pair`         |

An amount is meaningless without its leg, so a message whose `pair` is
unparseable is refused before any amount is read.

**Decimals are protocol configuration, never chain metadata.** The atomic unit
of an asset is fixed by the § 2 registry. An implementation MUST NOT read an
asset's precision from on-chain metadata to interpret an amount: an ERC20's
`decimals()` is optional in that standard, and an Arkade asset's `decimals` is
a display convention declared at genesis by the minting party. Either can
disagree with the registry, and a disagreement is a silent misprice by a power
of ten rather than a failure.

**Accepting a JSON number.** A `v: 1` receiver MAY accept a JSON number for
backward compatibility, but only where it is provably lossless: the leg's
asset has 8 or fewer decimals **and** the value is a non-negative integer at
most 2^53 − 1. Any other number MUST be refused with `unsupported_payload`
rather than coerced — a rounded amount that settles is worse than a request
that does not. Senders SHOULD emit the string form for every asset. From
`v: 2` the string form is the only accepted encoding.

**Naming an asset that has no ticker.** The table's tickers cover BTC and the
placeholders; an arbitrary Arkade asset has neither a ticker nor a table row,
and it needs neither. In a `pair` string, a leg's asset is therefore **either
a ticker from the table above, or — on the `arkade` corridor only — a literal
asset id** in the same lowercase-68-hex form as the `id` column. Three
consequences, each of which is an error rather than a silent acceptance:

- **The literal form is `arkade`-only.** An Arkade asset id names a group on
  the Arkade ledger and means nothing on `lightning`, `onchain`, or
  `ethereum`. Accepting it there would yield a well-formed market key that no
  counterparty can ever subscribe to.
- **Lowercase only**, per the identity rule above. Hex is case-insensitive, so
  normalising instead is tempting — but a `pair` is also compared byte for
  byte (`decideOpenRfqBid` against the served pair), so a spelling normalised
  in one layer and not the other derives the right market key and is then
  refused as `unsupported_pair`.
- **A registered ticker wins.** The table is explicit configuration; the
  literal form is the open-ended fallback, so a name someone put in the table
  can never be shadowed by one that merely matches the shape.

A pair may therefore be as long as two full asset legs
(`arkade:<68-hex>->arkade:<68-hex>`), which implementations must accept.

A solver that does not serve a directed request's pair refuses with
`unsupported_pair` (a broadcast for an unserved pair is ignored silently,
§ 4.6). New corridors and assets extend these registries; they do not change
the protocol.

The solver-registry's **market key** is a different string with a different
job: non-directional, it identifies a market, not a trade direction. Its
derivation is normative here, because both sides of § 4.6 must compute the
identical string: each leg is `<corridor>:<asset-id>` — corridors resolved
(an omitted corridor is `arkade`), asset ids from the `id` column, never
tickers — and the two legs join with `/`. Leg order: when exactly one leg is
arkade it comes first (the registry's rule); when both or neither are, the
legs sort lexicographically as strings (this spec's extension — the registry
imposes no order there; § 12). Examples: `arkade:btc/lightning:btc`,
`arkade:btc/arkade:<68-hex-assetid>`, `lightning:btc/onchain:btc`; for a
non-BTC asset the id is the 68-hex AssetId, so a cross-asset market key is
network-scoped. Where this spec needs the market key — the open-RFQ
subscription tag, § 4.6 — it says so explicitly; everywhere else `pair` means
the directional form above.

## 3. Transport

### 3.1 Nostr (production)

The reference solver implements this transport (`src/relay/nostr.ts` behind
the `WireCodec` seam; `RELAY_PROTOCOL=nostr`, the default): NIP-01 framing,
signature verification on every inbound event, NIP-44 v2 on directed
content, and the wallet identity as the transport key — asserted against the
SDK identity at startup.

Both sides are **outbound-only**: client and solver each dial out to relays;
neither listens. Parties are addressed by x-only pubkey. No URLs appear
anywhere in the protocol, which is what makes a fleet of solvers a config
change rather than a rewrite.

Three event kinds. The two negotiation kinds are **ephemeral** (NIP-01's
20000–29999 range); the advertisement is **addressable** (30000–39999, one
current version per solver). Neither negotiation kind is retained by a
conforming relay, which is deliberate: a request nobody answered inside the
client's 30-second patience, and a quote past its `valid_until`, are worthless
to everyone, while a stored copy of either is a permanent public record of
trade intent. See `docs/relay-transport.md` § 4(b) for the measurements.

- **Kind `24859` (provisional) — directed RFQ traffic.** One kind for the
  whole message family. `content` is the NIP-44-encrypted JSON payload
  (§ 4); a `p` tag names the recipient's pubkey. The sender's event signature
  makes every message non-repudiable for free — in particular a quote is a
  solver-signed commitment the client can later prove. Non-repudiation comes
  from the signature and not from relay retention: the party who wants to
  prove a quote is the party holding the signed event.
- **Kind `24860` (provisional) — open RFQ broadcast.** Phase 1 of the
  broadcast-bidding flow (§ 4.6): a **plaintext** `rfq_open` payload with no
  recipient and no `p` tag, tagged with the canonical market key so solvers
  can subscribe by pair. Nothing secret ever rides this kind — § 4.6 defines
  exactly what may appear. Ephemerality matters most here, because this is the
  one kind whose contents are public by design.
- **Kind `38859` (provisional) — solver advertisement.** A replaceable event
  (`d` tag SHOULD be `"rfq1"`), **unencrypted** and **indicative only**:

  ```json
  {
    "v": 1,
    "type": "solver_ad",
    "pairs": [
      {
        "pair": "arkade:BTC->lightning:BTC",
        "min": "1000",
        "max": "100000",
        "fee_bps_indicative": 30,
        "fee_flat_indicative": "50",
        "quote_validity_s_typical": 900
      }
    ],
    "relays": ["wss://relay.example"]
  }
  ```

  `min`, `max` and `fee_flat_indicative` are canonical decimal strings of
  atomic units (§ 2.1) on the same legs their `rfq_bid` counterparts use;
  `fee_bps_indicative` is a rate and stays a JSON number. An ad is
  indicative, but it is the surface a client filters on, so an ad that
  rounded its bounds would hide a solver from exactly the large requests it
  wanted.

  Nothing in an ad is binding; only an `rfq_quote` binds (an `rfq_bid`,
  § 4.6, is a per-request price commitment, but settlement terms still bind
  only through a quote). Clients use ads for discovery and pre-filtering,
  then confirm terms by requesting a quote.

  Both price components appear, for the same reason the bid carries both
  (§ 4.6): pre-filtering on the spread alone would rank a solver with a flat
  fee ahead of a cheaper one, and non-binding is not the same as free to
  mislead. `fee_flat_indicative` is atomic units of the from leg and MAY be
  omitted, which means zero — an ad is a hint, not a schema to conform to.

In practice discovery today runs primarily through the **solver-registry
corridor card** rather than the kind-38859 ad: a git-reviewed, BIP340-signed
listing carrying the solver's `discovery_pubkey`, its **transport map**, and
per-market `fee_bps`, `fee_flat` and limits (`schema/card.schema.json` in
`arkade-os/solver-registry`; this deployment emits its own card from live
config via `cli card` — `src/core/registryCard.ts`). Card and ad share the
same key model — the card's `discovery_pubkey` is the pubkey RFQ traffic is
addressed to — and both are **indicative**: rendezvous data, never terms.

A card's `fee_flat` is OPTIONAL — omitted means `"0"` — and is denominated
in **quote-asset** atomic units to match the card's own `min_quote_amount` /
`max_quote_amount`, not in the from-leg units a bid uses (§ 4.6). Optional
rather than required so that adding the field breaks no existing card and
forces no coordinated release: `card.schema.json` carries
`additionalProperties: false`, so until the registry schema lists
`fee_flat` a card that sets it is rejected outright, and until then a solver
charging a flat fee simply cannot publish a card that says so. On a
same-asset corridor market the two denominations coincide; on a
cross-asset one they are different assets, so a card's `fee_flat` and a
bid's are not comparable numbers. That costs nothing today precisely
because the card is indicative: the bid and the quote carry the terms.
Where a card advertises one market standing for both directions of a
corridor, its `fee_bps` and `fee_flat` are each the **maximum** across the
directions it stands for — overstating a fee is the safe direction, and a
client expects worse than it gets; understating one is a card that lies.

Rendezvous is keyed by **protocol**, not by a bare list of URLs:

```json
{ "transports": { "nostr": { "relays": ["wss://relay.example"] } } }
```

`nostr` is the only key v0 admits, and it is required within the map. This
matters beyond bookkeeping — it is the seam a second transport would arrive
through. A non-Nostr bus is a new key here plus a new `WireCodec`, and
nothing above the codec moves; the card schema is `additionalProperties:
false`, so the retired top-level `relays` array is now rejected outright
rather than silently ignored.

### 3.2 Dev transport (integration testing)

The reference implementation also speaks a minimal generic broker framing —
`{op: "sub"|"unsub"|"event", …}` over WebSocket — defined in one codec pair,
`encodeFrame`/`decodeFrame` (`src/relay/connection.ts`). Its event shape
(`id`, `author`, `recipient`, `payload`) is deliberately Nostr-shaped; moving
to Nostr is a codec swap (`REQ`/`EVENT`/`CLOSE` + NIP-44 on the payload) and
nothing above the codec changes. Teams MAY use the dev framing against
`scripts/mock-relay.mjs` for integration tests.

Transport requirements that are load-bearing regardless of codec (all
implemented and tested in `src/relay/connection.ts`):

- Reconnect MUST arm on **both** `error` and `close` — a connect that fails
  outright fires only `error`, so retrying solely from `close` stops forever
  exactly when the relay is down.
- Live subscriptions MUST be **replayed** onto each new socket.
- Outbound events published while disconnected MUST be queued (bounded; the
  reference bounds at 256 and drops the oldest — a client that never got a
  reply retries, and the retry re-enters the queue).

The open-RFQ flow (§ 4.6) adds one thing to this framing: a topic —
`topic?: string` on both the event shape and the subscription filter, exact
string match, carrying the § 2 canonical market key; the broker analogue of
the kind-24860 `t` tag (implemented: `src/relay/connection.ts`,
`scripts/mock-relay.mjs`).

## 4. Message family

Every payload carries the envelope `{"v": 1, "type": …}`. Types:

| type                 | direction                        | class                    |
| -------------------- | -------------------------------- | ------------------------ |
| `rfq_request`        | client → solver                  | all                      |
| `rfq_quote`          | solver → client                  | all                      |
| `rfq_refusal`        | solver → client                  | all                      |
| ~~`rfq_fill`~~       | —                                | **not used — see § 7.2** |
| `rfq_status_request` | client → solver                  | all                      |
| `rfq_status`         | solver → client                  | all                      |
| `rfq_open` (§ 4.6)   | client → all solvers (broadcast) | all                      |
| `rfq_bid` (§ 4.6)    | solver → client                  | all                      |

An inbound event whose payload `type` is a known request type but fails
validation MUST be answered with `rfq_refusal` reason `unsupported_payload` —
except the broadcast kind: on kind 24860 nothing is ever refused; a malformed
or unserved `rfq_open` is ignored silently (§ 4.6). An `rfq_open` payload
arriving on the **directed** kind is out of place; the reference ingress
ignores it silently along with any other unrecognised payload type (a refusal
here is specified but not yet implemented — `src/ingress/relay.ts` refuses
only a malformed `rfq_request` or `rfq_status_request`).
Any other unparseable or unaddressed event MUST be ignored silently — on a
shared relay, scolding every stray event is noise. (This is exactly the
behaviour of the reference ingress, `src/ingress/relay.ts`.)

**There is NO accept message in any class.** Acceptance is an action, not a
message: the client accepts a quote by funding the settlement contract it
derived locally (§ 6). The atomic class was long described here as the
exception, sending an `rfq_fill` — it is not, and no such message exists. It
funds an offer covenant instead, which a solver then fills (§ 7.2), so
funding-is-acceptance is the rule with no exceptions rather than a rule with
one.

### 4.1 `rfq_request`

```json
{
  "v": 1,
  "type": "rfq_request",
  "rfq_id": "9f2c…64 hex chars…a1",
  "pair": "arkade:BTC->lightning:BTC",
  "amount_side": "to",
  "amount": "50000",
  "profile": { "…": "per-profile fields, § 7" }
}
```

- `rfq_id` — **client-chosen**, 32 bytes hex. The idempotency and correlation
  key for the whole negotiation (§ 4.5).
- `amount_side` — `"from"` (exact-in: the client fixes what it pays) or
  `"to"` (exact-out: the client fixes what it receives). On an exact-out
  request the solver solves the from-amount UP from the requested payout
  against its corridor fee — the quote's `to_amount` is the request by
  construction, and the rounding correction (sub-sat) lands in the give.
- `amount` — atomic units of the leg named by `amount_side`, as a canonical
  decimal string (§ 2.1).
- Profiles where the client supplies a BOLT11 invoice force exact-out: the
  invoice amount is authoritative, `amount_side` MUST be `"to"`, and `amount`
  MAY be omitted (if present it MUST equal the invoice amount, else
  `unsupported_payload`).

### 4.2 `rfq_quote`

```json
{
  "v": 1,
  "type": "rfq_quote",
  "rfq_id": "9f2c…a1",
  "pair": "arkade:BTC->lightning:BTC",
  "from_amount": "50000",
  "to_amount": "50000",
  "solver_pubkey": "ae75…64 hex…09",
  "valid_until": 1800000900,
  "refund_locktime": 1800605184,
  "profile": { "…": "per-profile fields, § 7" }
}
```

- A quote resolves **both** `from_amount` and `to_amount`. The solver's fee
  lives in the spread between them; there is **no separate fee field**.
  Both are canonical decimal strings of atomic units (§ 2.1), each in the
  asset of its own leg — so on a cross-asset pair they are denominated in
  different assets and are not comparable as numbers.
- `solver_pubkey` — the solver's settlement key (x-only). In v1 it SHOULD
  equal the transport identity key that signed the event.
- `valid_until` — § 5.
- `refund_locktime` — HTLC-class quotes only (absent for atomic class): the
  absolute unix-seconds time the client's refund path opens.
- The top-level fields `solver_pubkey`, `valid_until`, `from_amount`,
  `to_amount` and `refund_locktime` are the **binding fields** — the only
  fields a client trusts (§ 6). Everything in `profile` is compare-only or
  informational.

### 4.3 `rfq_refusal`

```json
{ "v": 1, "type": "rfq_refusal", "rfq_id": "9f2c…a1", "reason": "exposure_cap" }
```

`reason` is from the closed set in § 10. A `detail` string MAY be attached
for humans; clients MUST NOT branch on it. `rfq_id` echoes the offending
request's; when that request carried no usable `rfq_id` (an `open_id` is
not one), the field is omitted.

### 4.4 `rfq_status_request` / `rfq_status`

```json
{ "v": 1, "type": "rfq_status_request", "rfq_id": "9f2c…a1" }
```

The solver answers with the current lifecycle state (§ 8) and per-profile
receipt fields:

```json
{
  "v": 1,
  "type": "rfq_status",
  "rfq_id": "9f2c…a1",
  "state": "settled",
  "updated_at": 1800003600,
  "profile": { "preimage": "…", "…": "receipts, § 7" }
}
```

Receipts that prove settlement (a preimage above all) MUST appear **only** in
the `settled` state — before that a preimage is the solver's leverage, and on
a failed swap it never exists. A status request for an `rfq_id` the solver has
no negotiation for is answered with `rfq_refusal` reason
`unsupported_payload`. Status is best-effort: over a pure relay transport a
client can always fall back to observing the settlement contract on-chain (a
claim spending the lockup is the ground truth and carries the preimage in its
witness).

### 4.5 Idempotency

Relays redeliver, clients retry, and networks duplicate. The rules:

- The client-chosen `rfq_id` plus the profile's **natural key** (for
  Lightning legs: the payment hash; a profile without one — the atomic
  class today — is identified by `rfq_id` alone) identify a negotiation. A duplicate
  `rfq_request` (same `rfq_id`, same content) MUST re-emit the **existing**
  quote — byte-identical terms, never a second swap, never a re-price. The
  reference implementation derives this from a UNIQUE constraint on the
  natural key plus a deterministic re-emit (`src/ingress/relay.ts`,
  `src/db/swaps.ts`).
- Re-emission applies only while the negotiation is still in `quoted`. Once
  the contract is funded — or the swap has otherwise progressed
  (`funded`/`filling`/`filled`/`settled`/`stuck`) — a repeated `rfq_request`
  gets `rfq_refusal` reason `quote_conflict`; `rfq_status_request` is the tool
  from then on. A negotiation that ended in `refused`/`expired`/`refunded`
  releases the natural key and is quoted fresh.
- The same `rfq_id` bound to a **different natural key** is `quote_conflict`
  (`src/ingress/rfq.ts`). Content matters beyond the natural key, too: a
  repeat re-emits the existing quote only while it is still live AND the
  request's client-binding fields match it — the send profile's
  `client_refund_pubkey` and `refund_address` pin the covenant, so a retry
  carrying different ones gets `quote_conflict`, not the first attempt's
  lockup. A payment hash may be
  re-quoted only after every prior swap on it is `refused`/`expired` without
  exposure (a hash whose preimage the solver may already know is burned
  forever).

### 4.6 Open RFQ — broadcast bidding _(solver side implemented — `src/core/openRfq.ts`, `src/ingress/relay.ts`; the client side lives in the ts-sdk, tracked in issue #4)_

Directed negotiation (§ 4.1–4.5) presumes the client has already picked a
solver from discovery data. When several solvers serve a pair — and
especially once an independent party runs a **shared RFQ bus relay** (a
vanilla relay every solver lists in its registry card; admission control is
relay policy, not protocol) — the client can instead publish **one open RFQ
with no solver chosen in advance**, collect competing sealed bids, and close
with the winner over the unchanged directed flow. Both modes coexist,
permanently: an open RFQ publishes trade intent (pair + size) to everyone on
the relay, where a directed request leaks it to one solver only, so clients
choose per trade.

This cannot be "just remove the `p` tag": two properties of the directed
flow are load-bearing. Directed content is encrypted _to somebody_, and an
open RFQ has nobody to encrypt to — whatever it carries is public. And the
send profile's request carries a BOLT11 whose publication would leak the
payment destination and invite griefing (anyone can pay it, burning the hash
outside the swap). The open flow therefore never carries an invoice or an
address. Three phases:

**Phase 1 — `rfq_open` (public broadcast, kind `24860`).** Plaintext, no
recipient. The event carries a `t` tag (provisional) whose value is the
**canonical corridor-qualified market key** under the § 2 derivation —
corridors resolved, canonical asset ids, deterministic leg order:
`arkade:btc/lightning:btc` — never the card's display label and never an
unordered variant; a subscription keyed to any other form silently misses
every event. Solvers subscribe by this tag, one subscription per served
market, alongside their directed subscription.

```json
{
  "v": 1,
  "type": "rfq_open",
  "open_id": "9f2c…64 hex chars…a1",
  "pair": "arkade:BTC->lightning:BTC",
  "amount_side": "to",
  "amount": "50000",
  "bids_until": 1800000030
}
```

- `open_id` — client-chosen, 32 bytes hex; correlates bids. It is not an
  `rfq_id` and creates no negotiation — § 4.5 is untouched by this flow.
- `pair` — the directional § 2 string; the tag is the non-directional
  market key. Direction lives in the payload.
- Size: exactly one of `amount` (§ 4.1 semantics) or `size_bucket` —
  `{"min": …, "max": …}`, canonical decimal strings of atomic units (§ 2.1)
  of the `amount_side` leg —
  MUST be present. Buckets soften intent leakage; they SHOULD come from a
  coarse shared ladder (decades: 10³–10⁴, 10⁴–10⁵, …) so the bucket choice
  itself does not fingerprint the client.
- `bids_until` — OPTIONAL absolute unix seconds: when the client stops
  collecting (recommended window ~2–5 s). A solver MAY skip a lapsed open
  RFQ or MAY still bid on one observed slightly late — a late bid just gets
  dropped. As always (§ 1) the payload field is the deadline, never the
  transport stamp. But subscription replay (§ 3.2) re-delivers relay
  backlog, so solvers SHOULD subscribe with a transport `since` of roughly
  now and, when `bids_until` is absent, MAY treat a broadcast older than a
  local bound — by transport stamp — as stale. That use of the stamp is
  sanctioned: broadcast freshness is a relevance filter, not a protocol
  deadline.
- A malformed or unserved `rfq_open` is **ignored silently — never
  refused**. This inverts the § 4 refusal rule deliberately: on a shared
  bus, answering every stray broadcast is a spam amplifier. An `rfq_open`
  creates no solver state.

**Phase 2 — `rfq_bid` (directed, sealed).** A solver serving the pair
replies on kind `24859`, NIP-44-encrypted **to the open RFQ's author
pubkey** — right there on the event. The solver MUST publish the bid to at
least the relay the `rfq_open` arrived on; the client listens for events
p-tagged to the open's author key on every relay it broadcast to.
Encrypting bids to the client makes this a **sealed-bid auction**:
competitors cannot read each other's prices, which resists undercutting
races and collusion alike.

```json
{
  "v": 1,
  "type": "rfq_bid",
  "open_id": "9f2c…a1",
  "pair": "arkade:BTC->lightning:BTC",
  "fee_bps": 25,
  "fee_flat": "50",
  "min": "1000",
  "max": "100000",
  "valid_until": 1800000900
}
```

- `fee_bps` — the solver's price as a spread in basis points. A JSON number,
  not a string: it is a rate bounded by `10⁴`, not an amount, so it carries
  no asset and cannot exceed what a double represents exactly. The
  conformance inequalities below multiply by it, and both sides must round
  the product identically — which is why they name ceiling and floor
  explicitly rather than leaving it to the implementation. On a
  same-asset pair this is the whole of the size-proportional price (the
  § 4.2 rule stands: in the eventual quote the fee lives in the spread
  between the resolved amounts); `fee_flat` below carries the rest. On a
  cross-asset pair it is a spread over the market reference price, and
  only the quote fixes amounts.
- `fee_flat` — OPTIONAL; a canonical decimal string (§ 2.1), **atomic units
  of the from leg** (what the client pays). Omitted means `0`, so a corridor charging no flat component
  sends nothing and every bid written before this field existed still reads
  correctly. The part of
  the price that does not scale with size: an onchain corridor broadcasts a
  transaction and pays for it whether the swap is worth a thousand atomic
  units or a million. Note the leg: `min`/`max` below are the **to** leg, and
  this is deliberately the other one — the conformance inequalities add the
  fee to `from_amount`, so denominating it there keeps the check evaluable by
  the client without a reference price. On a cross-asset pair the two legs are
  different assets and the distinction is load-bearing.
- `min` / `max` — REQUIRED (conformance is undefined without them);
  canonical decimal strings (§ 2.1), atomic units of the **to** leg (what
  the solver pays out) — the
  registry card's per-side-bounds convention. Conformance is always
  evaluated on the to leg: for an exact-out request that is `amount`
  itself; for an exact-in request it is the `to_amount` the solver's quote
  resolves — so against exact-in sizes the bounds are indicative pre-quote
  and exact at quote time.
- `valid_until` — the § 5 absolute-time convention, at SHOULD strength (a
  bid gates when a request can claim a price; it is not § 5's
  MUST-refuse-late-funding): a conforming directed `rfq_request` — same
  pair, to-leg size within `[min, max]`, first observed before
  `valid_until` — SHOULD be answered with a quote no worse than the bid.
  "No worse", concretely, on a same-asset pair:
  `from_amount ≤ ceil(to_amount · (1 + fee_bps/10⁴)) + fee_flat` for
  exact-out, `to_amount ≥ floor((from_amount − fee_flat) · 10⁴ / (10⁴ +
fee_bps))` for exact-in — ceiling and floor chosen so a boundary quote
  conforms, and `fee_flat` outside them because it is exact. Worked, at
  `fee_bps` 25 and `fee_flat` 50: an exact-out request for 25 000 permits
  `from_amount` up to `ceil(25 062.5) + 50 = 25 113`, and an exact-in
  request of 25 113 requires `to_amount` of at least 25 000 — the same
  boundary from either side. A request whose `from_amount` does not exceed
  `fee_flat` is unquotable, not mispriced: the solver refuses it with
  `pricing_unavailable` rather than quoting a non-positive payout. On a
  cross-asset
  pair no reference price is client-verifiable in v1; comparing concurrent
  bids and quotes is the defense there, and the § 12 bonding question is
  the eventual answer.
- The close carries no bid reference and MAY come from a key the solver
  has never seen (see phase 3), so a bid's reach is wider than one client:
  until `valid_until`, a solver SHOULD price **every** conforming directed
  request on that pair no worse than the **lowest total fee** implied by any
  of its own unexpired bids covering that to-leg size — it cannot know which
  open RFQ, if any, a request descends from, and must not need to. A bid's
  implied fee at to-leg size `S` is `ceil(S · fee_bps/10⁴) + fee_flat`.
  Solvers size `valid_until` accordingly.
- Two components mean **cheapness depends on size**, which one did not.
  A bid at `fee_bps` 25 / `fee_flat` 50 is dearer than one at `fee_bps` 45 /
  `fee_flat` 0 at small sizes and cheaper at large ones — both imply 113
  atomic units at a to-leg size of 25 000. The switch is not a clean
  crossing: because each implied fee rounds up independently, the two trade
  places repeatedly through a band either side of that size (equal at 24 667
  and 24 889, the 45-bps bid cheaper again at 24 801). So neither a solver
  ranking its own commitments nor a client ranking solvers may order bids by
  `fee_bps` alone, nor by picking a representative size — the comparison is
  defined only at the size actually being priced, and an implementation that
  sorts on the spread is correct exactly until two bids differ in
  `fee_flat`.
- A bid is a **response**: tolerant parsing (§ 1), no refusal for a bad one
  — the client just drops it. The client MUST verify the event signature
  and MUST drop bids for an unknown `open_id`. A solver MAY revise its bid
  by publishing a new one under the same `open_id`; the client keeps one
  bid per solver per `open_id`, ordered by the transport event's
  `created_at` with event id as tiebreak — a sanctioned § 1 exception (no funds-relevant deadline
  is read from it), which is also what makes relay redelivery harmless.
  Revision cannot retract a commitment: any unexpired signed bid the
  client holds remains presentable evidence, so revisions effectively bind
  only downward — a solver that may need to reprice sizes `valid_until`
  short instead.
- The bid's author pubkey is the solver identity the close is addressed to
  (v1 key model, § 4.2; splitting keys is the § 12 question). Solver-signed,
  a bid is a **non-repudiable per-request price commitment** — strictly
  stronger than the indicative kind-38859 ad — but enforcement is
  reputational: the client's recourse against a reneging solver is
  publishable evidence (signed bid + worse signed quote), not a bond
  (§ 12).

**Phase 3 — close (the existing directed flow, unchanged).** The client
picks the best bid and runs the class's normal path against the winner —
§ 4.1 → § 4.2, then acceptance BY FUNDING — the settlement contract for the
HTLC class, the offer covenant for the atomic one (§ 7.2). A fresh
`rfq_id`; the profile's
sensitive inputs — the send profile's invoice, the receive profile's
`payment_hash` and sealed `claim_packet` — reaching **only** the winner,
encrypted; local contract derivation; idempotency by the profile's natural
key (§ 4.5) — every § 4–§ 7 rule applies verbatim, and no directed message
gains new fields. A quote inconsistent with the winning bid is grounds to
walk away — decline to fund, or to fill — holding both signed artifacts as
evidence (§ 6 unchanged). Losing bids simply expire; v1 sends no loser
notification.

Client privacy: the client SHOULD use a fresh transport key per open RFQ —
bids seal to it, and negotiations stay unlinkable across trades. The
directed close MAY come from any key; nothing in phase 3 depends on the
phase-1 identity.

Spam: an open RFQ costs every subscribed solver a bid computation — but
only that. Bids are config-priced (no invoice to decode at bid time), and
solvers SHOULD rate-limit bidding per pair. Admission control on a shared
bus (proof-of-work, rate limits) is the relay operator's concern.

The § 6 trust model needs no amendment: the client still derives every
contract locally and funds only its own derivation, so neither a bus relay
nor a lying bidder can redirect funds — a malicious bus can censor, or
misdirect into silence, the same failure class as a wrong registry
rendezvous.

## 5. Quote validity — `valid_until`

Every quote carries `valid_until`, the solver-chosen absolute time during
which the quoted terms are **binding if the client's funding (or fill) is
observed in time**. This is the tolerance parameter of the whole protocol:

- **Cross-asset / fiat-referenced pairs** (anything where the solver is short
  the market during the window): windows on the order of **~30 seconds**.
- **Same-asset pairs** (`…:BTC->…:BTC`): windows of **minutes**. The
  reference implementation's 15-minute `DEFAULT_LOCKUP_TIMEOUT`
  (`src/core/send.ts`) maps directly onto it, as an UPPER bound: on the
  Lightning send leg the window is also clipped to the invoice's own expiry
  (`lockupDeadlineFor`), so a short invoice yields a correspondingly short
  `valid_until` rather than a refusal.

Late funding — a lockup first observed after `valid_until` — MUST be refused
and refunded at the contract's refund path. Never silently filled, never
silently re-priced. (Reference: the lockup deadline is a hard precondition
enforced the moment funding is first observed, including by crash recovery —
not only while a watcher happens to be running.)

For quotes that mint an invoice (receive-direction Lightning), the invoice's
own expiry SHOULD equal `valid_until`.

An `rfq_bid` (§ 4.6) carries its own `valid_until` with the same
absolute-time semantics: it bounds when a conforming directed request can
still claim the bid's price.

## 6. Trust model

Universal across profiles and corridors:

> **The client trusts only the binding fields of a quote** —
> `solver_pubkey`, `refund_locktime`, `valid_until`, `from_amount`,
> `to_amount` — **and derives the settlement contract locally from its own
> data.** Any address, script or contract identifier the solver sends is
> compare-only: the client checks it against its own derivation and a
> mismatch means **refuse to fund**. A wrong or malicious solver can only
> produce terms the client declines, never a contract that traps funds.

Corollaries:

- The client's own inputs (its invoice, its refund destination, the Arkade
  server key from its own connection, the emulator key from its own fetch)
  never come from the solver.
- **Preimages are receipts.** They are emitted only in the `settled` state,
  and only because settlement itself published them (a claim witness, a
  settled HTLC). No message in this protocol ever transports a preimage from
  client to solver — for the receive direction it travels sealed to a
  separate service the solver cannot read (§ 7.1.2).
- Quote non-repudiation comes free from the transport (§ 3.1): a quote is a
  signed solver statement.

## 7. Settlement profiles

A profile defines the `profile` objects of request/quote/status, the funding
and settlement mechanics, and the per-profile natural key. Two classes.

### 7.1 HTLC class (cross-system)

One side locks funds behind a hash `H`; revealing the preimage `P` settles
both sides atomically-in-effect. No accept message exists: **funding the
locally-derived contract is acceptance.**

RFQ is therefore only the _negotiation_; everything after the quote is
**non-interactive filling**. The **client** — the trader
submitting the intent — has one action: funding its own derivation before
`valid_until`; then it may go offline. The **solver** fills by
**observing the funding on-chain**, never by being told: it claims
with `P`, which appears publicly in the claim witness as the receipt, and a
failed swap refunds by covenant with no client keys, messages or state. (The
atomic class is NOT an exception, though this document long said it was: it
funds an offer covenant rather than sending a message, and its refund is
`cancel` — a 2-of-2 of the funder and the Arkade Service, needing no solver
signature and carrying no timelock. § 7.2.)

#### 7.1.1 `arkade:BTC->lightning:BTC` — implemented today

The client pays a BOLT11 invoice out of an Arkade balance. The reference
implementation **serves this profile natively on both transports**:
`rfq_request` over `POST /v1/swap` or the relay, `rfq_status_request` over
the relay, `GET /v1/rfq/<rfq_id>` over HTTP (`src/wire/payloads.ts`,
`src/ingress/rfq.ts`). A JavaScript trader library implements this profile
end to end (`examples/lib/`, `docs/integration-js.md`); the reference clients
`examples/send-client.mjs` (HTTP) and `examples/send-client-relay.mjs`
(relay) are thin consumers of it.

- **request.profile**: `invoice` (the BOLT11, ≤ 2048 chars), `refund_address`
  (the client's Arkade address, ≤ 200 chars), `client_refund_pubkey`
  (the client's own x-only key, hex, for the covenant's client-side refund
  leaves — required). Natural key: the invoice's payment hash.
  Exact-out (§ 4.1).
- **quote.profile**: `payment_hash` (echo), `lockup_address` (compare-only —
  the solver's derivation of the swap contract's address), `receiver_pk_script`
  (compare-only — the solver's own claim destination, hex P2TR pkScript; the
  covenant's `nonInteractiveClaim` leaf pins to it, so the client's local
  reconstruction needs the exact value to compute a matching address. A wrong
  value here only makes that one leaf unusable for the solver — see § 7.1.1.1).
- **status.profile**: `payment_hash`, `lockup_address`, settlement txids as
  the corridor defines them, `failure_reason`, `payment_evidence` and
  `payment_failure_reason` (both optional), and — in `settled` only —
  `preimage`.

  `payment_evidence` is what the rail KNOWS about the outbound fill, as opposed
  to where the fill got to: `no_record` (the rail never heard of it, so the sats
  provably never left), `in_flight`, or `terminal`. `no_record` is the one the
  § 8 state cannot express — it reports as a failure exactly like a fill that
  was attempted and died.

  `payment_failure_reason` is the rail's verdict on WHY: `rejected_by_destination`,
  `insufficient_balance`, `pathfinding_timeout`, `route_not_found`, `canceled`,
  `unknown`. Distinct from `failure_reason`, which is the solver's own account of
  the swap; the two are facts about different things and may disagree.
  `rejected_by_destination` is the one that earns its keep — it is how an invoice
  a third party has already settled comes back, otherwise indistinguishable from
  any other terminal failure.

  Both are diagnostic and advisory. Neither is a licence to refund: an htlc
  already locked in cannot be cancelled by anyone (BOLT #2), so a fill that is
  merely unresolved may still settle. Both are omitted whenever the rail does
  not report them, so absence is never itself a verdict, and clients must treat
  unknown values as unknown.

  Note there is deliberately no "stalled" value. A stalled fill and a healthy
  in-flight one are not distinguishable from what a rail reports, so claiming
  otherwise would be a guess dressed as a fact.

Flow: the client decodes the invoice itself, requests, receives the quote,
derives the covenant swap script locally — eight leaves, or nine once the
solver has deployed the timelocked non-interactive refund leaf (§ 7.1.1.1) —
refuses on any address mismatch, gates (invoice live, ≥ 90 min headroom to
`refund_locktime`), funds its own derivation before `valid_until`, and goes
offline. The solver observes funding, gates again at action time (§ 9),
pays the invoice, learns `P`, claims. Failure refunds by covenant with no
client keys and no client state on the cooperative path — or, if the Arkade
server and the emulator are ever both unavailable, by the client's own
unilateral broadcast using `client_refund_pubkey`'s key, which is state the
client itself now holds by design (see `docs/integration-js.md`).

The client-side leaves' CSV delays (`unilateral_refund_delay`,
`unilateral_refund_without_receiver_delay`) are not carried on the wire: they
derive purely from the Arkade operator's own public `/v1/info`, the same
source `unilateral_claim_delay` already comes from, so both sides reach the
same numbers independently.

##### 7.1.1.1 The covenant script: eight leaves, nine with the timelocked non-interactive refund leaf

Every RFQ-family quote commits to the extended tree — `VHTLC.ScriptV2` from
`@arkade-os/sdk`, the same class `@arkade-os/swap`'s reference client builds,
so the client's and the solver's derivations are byte-identical by
construction GIVEN THE SAME PARAMETERS — same class, so there is no
independent-reimplementation drift to worry about for how a leaf is built,
only for which leaves are included (below). Roles below are named for THIS
corridor: the solver is the VHTLC `receiver` (it claims with `P`), the client
is the `sender` (it is refunded if the swap fails). The receive corridors
(§ 7.1.2, § 7.1.4) carry the same leaves with the roles inverted — the client
is `receiver` there, the solver `sender` — so "who refunds whom" flips with
them; see `src/arkade/covenant.ts`'s role-inversion note.

A NINTH leaf, **timelocked non-interactive refund** (below), is additional to
the original eight and changes the tree — and therefore `lockup_address` —
for every quote once a solver has deployed it. It is NOT a per-quote choice
the client requests or declines: whether a given quote carries it is fixed by
the solver's own build, and NOTHING on the wire names it — no
`rfq_request`/`rfq_quote` field says whether this particular quote's covenant
includes it.

**The rule this leaves a client with:** derive BOTH the eight- and nine-leaf
shapes, and accept whichever one matches `quote.profile.lockup_address`;
refuse only if NEITHER does. This is still compare-only and adds no trust —
both shapes pin the refund to the client's own `refund_address` (that is what
`nonInteractiveRefund`/`nonInteractiveRefundWithoutReceiver` both commit to),
so a solver gains nothing by choosing which one it quotes, and a client loses
nothing by accepting either. Deriving only the eight-leaf shape (what
`@arkade-os/swap`'s reference client does today — it predates this leaf) means
hard-refusing every quote from a solver that has deployed the ninth, for a
reason that has nothing to do with that swap.

**Precondition to build the nine-leaf candidate at all:** this needs
`@arkade-os/sdk` ≥ **0.4.67**, the first published release carrying the
per-leaf covenant options (`VHTLC.Options.nonInteractiveRefund.withoutReceiver`
and siblings). A single `nonInteractiveParameters` opt-in group replaces those
per-leaf options once `arkade-os/ts-sdk#818` ships; the reference solver maps
between the two in `src/arkade/covenant.ts` until then, so the minimum
published version is 0.4.67 either way. This is not merely "upgrade before
you can use the feature": an `@arkade-os/sdk` that predates 0.4.67 accepts
`withoutReceiver: true` silently and ignores it rather than rejecting it, so
the "nine-leaf" candidate such a client builds is actually still eight-leaf —
its two candidates collapse into one, indistinguishably, with nothing that
errors to reveal it. A client stuck on a pre-0.4.67 SDK that meets a solver
which HAS deployed the real ninth leaf therefore hard-refuses every quote
from it, with no code-level fix available short of upgrading that dependency —
the same "derives eight leaves against a solver now quoting nine" failure the
rule above exists to prevent, just moved one level down: from a client's OWN
LOGIC being stale to its SDK DEPENDENCY being stale.

Lockups already funded before a solver deployed it stay eight-leaf
permanently — the leaf cannot be retrofitted onto an address already
committed on Arkade — so which shape is correct for a given LOCKUP depends
on when the quote underlying it was
issued, not on which client library version reads it back; trying both
candidates on every quote is what makes that history irrelevant to the
client.

- **claim** — preimage + solver + Arkade server. The collaborative fill:
  the solver reveals `P` (learned by paying the invoice) and collects.
- **non-interactive refund** — Arkade server + solver + emulator covenant
  key, **immediate, no timelock, no client signature**. The covenant pins
  the spend's output to the client's `refund_address` with value ≥ input,
  so the moment the solver and server agree the swap has failed the refund
  can be pushed — by anyone holding the script — and the money can only go
  one place. This is the leaf the reference solver's automatic refund sweep
  spends, and because it has no deadline to wait for, the sweep pushes it as
  soon as a swap is refused rather than at `refund_locktime`. (A swap quoted
  with no client refund key gets the three-leaf script instead, whose refund
  IS timelocked — there the sweep still waits.) The same leaf is what the
  self-payment exception uses to refund a terminally failed payment the moment
  it fails.
- **timelocked non-interactive refund** — Arkade server + emulator covenant
  key ONLY, after `refund_locktime`. Neither the client NOR the solver signs —
  the only refund tier needing no participant at all. Same covenant-tweaked
  cosigner key as **non-interactive refund** above (derived once, shared by
  both leaves, so the two always agree on where the refund goes), but
  timelocked rather than immediate and reachable without the solver's
  cooperation. THE NINTH LEAF — see the note above this list for when it is
  and is not present on a given quote.
- **refund without receiver** — client + Arkade server, after
  `refund_locktime`. The timelocked backstop: no solver signature, no
  emulator — just the trader's own key and the server. (Roles inverted on
  the receive corridors, this same leaf is the SOLVER's recourse, and it is
  what the reference solver's receive-leg refund actually spends.)
- **refund collaborative** — client + solver + Arkade server, immediate, no
  timelock. All three agreeing to cancel right now rather than waiting out
  `refund_locktime`.
- **refund without server** — client + solver, behind a CSV, no server. The
  middle rung: the Arkade server is gone or censoring, but the solver is
  still reachable and willing to cooperate.
- **refund unilateral** — the client alone, behind its own (longest) CSV.
  Needs nobody — not the server, not the emulator, not the solver. The
  client's last-resort recourse if everything else is unavailable or
  censoring.
- **non-interactive claim** — preimage + Arkade server + emulator covenant
  key, pinned to the solver's own `receiver_pk_script` instead of the
  client's refund destination. Lets a claim be pushed without the solver
  being online. Marginal for this corridor's always-on solver — but it is
  exactly the leaf the receive corridors need, where the claiming party is
  the (possibly offline) client: covclaimd spends this leaf on the client's
  behalf there.
- **unilateral claim** — preimage + solver alone, behind a CSV. The solver's
  recourse if the Arkade server disappears after paying the invoice. (The
  leaf exists; the unroll/exit flow to spend it is not yet implemented — a
  censoring Arkade server after payment is the one unmitigated loss.)

Any client reconstructing the address must derive all eight (nine once the
solver has deployed the leaf above) identically (the merkle root commits to
every one, spent or not), or the address will not match. The reference
client's derivation is `examples/lib/swap-client.mjs`'s `deriveLockup`.

Rows quoted without a client refund key — the reference CLI's own
`quote`/`send` self-test commands take this path, no wire family does —
commit to the older three-leaf program instead: **claim**, **unilateral
claim**, and a timelocked **refund** (server + covenant key, anyone can
push, after `refund_locktime`). None of the client-cooperative leaves exist
there.

#### 7.1.2 `lightning:BTC->arkade:BTC` — implemented today

The client is paid over Lightning and the sats land on Arkade
(`src/receive/orchestrator.ts`, `src/wire/lightningReceivePayloads.ts`).

- **request.profile**: `payment_hash` (`H = sha256(P)`, client-chosen — the
  client generates `P` and never sends it), `payout_address` (the client's
  Arkade address — where the funds land when the lockup is claimed),
  `payout_pubkey` (the client's own x-only key — the covenant's `receiver`
  role on this leg, so the client can spend the collaborative claim leaf
  itself), and `claim_packet` — the preimage ECIES-sealed **to the covclaimd
  service, not to the solver**. The solver carries the packet blindly and
  cannot decrypt it. Sealing (verified against the reference stack,
  `docs/environment.md`): ephemeral secp256k1 key, ECDH, HKDF-SHA256 with
  info `covclaimd/preimage/v1` and the ephemeral public key as salt, AES-GCM
  with the same key as additional data; wire layout
  `ephPub(33) || nonce(12) || ciphertext`.
- **quote.profile**: `payment_hash` (echo), the hold `invoice` on `H` (its
  expiry SHOULD equal `valid_until`), `lockup_address` (compare-only — the
  solver's derivation of the funding contract) and `solver_refund_pk_script`
  (compare-only — where the solver's OWN refund pins to; a client
  reconstructing the full tree needs it). Amounts: the client pays the
  invoice in full (`from_amount`); the solver funds the lockup with
  `to_amount` — the amount minus this corridor's fee, fixed at quote time.
- **Fill**: a payer pays the invoice; the incoming HTLC is now **held**, not
  settled. The solver reads `E` — the real deadline by which the held HTLC
  must be settled — **from its Lightning backend for this payment hash. It
  MUST NOT assume a default**: the backend picks `E` and may pick one shorter
  than its documented norm; a hardcoded guess that runs long is exactly the
  case where the solver pays out and cannot collect
  (`src/core/receive.ts`).
- **Settlement**: the solver funds the Arkade side under a covenant that
  **pins the payout to the client's script** — the same `enforcePayTo`
  covenant proven on the send leg's refunds — so neither the solver nor
  covclaimd can redirect the funds. covclaimd decrypts `P` and pushes the
  claim through the non-interactive claim leaf; `P` becomes public in the
  claim witness; the solver settles the held HTLC with it and collects. The
  solver never handles `P` before it is already public. covclaimd is
  OPTIONAL: the client holds the covenant's `receiver` key (`payout_pubkey`)
  and can always push the collaborative claim itself — the reference
  deployment runs without covclaimd today, at the cost of the client needing
  to be online.
- Funding gates and the refund locktime derivation for this profile are the
  § 9 receive-side invariants.

#### 7.1.3 `arkade:BTC->onchain:BTC` — implemented today

The client locks Arkade balance; the solver funds a Bitcoin L1 Taproot HTLC
the client claims on-chain (`src/send/onchainOrchestrator.ts`,
`src/wire/onchainPayloads.ts`). Same flow shape as 7.1.1: the client derives
BOTH contracts locally (the Arkade covenant is the same tree as § 7.1.1.1 —
eight leaves, nine once the solver has deployed the timelocked non-interactive
refund leaf; the onchain HTLC is a two-leaf claim/refund P2TR,
`src/onchain/htlc.ts`), funds
only its own derivation, and goes offline. The client reveals `P` by
claiming the onchain HTLC — unlike Lightning, nothing reveals it
automatically — and the solver reads `P` off that witness to claim the
Arkade lockup.

- **request.profile**: `payment_hash` (`H`, client-chosen), `payout_pubkey`
  (the client's x-only key — the onchain HTLC's claim leaf), `refund_address`
  (the client's Arkade address, for the covenant's refund leaves),
  `client_refund_pubkey` (the client's own x-only key for those leaves).
  Natural key: `payment_hash`.
- **quote.profile**: `payment_hash` (echo), `htlc_pubkey` (the solver's
  onchain refund key), `htlc_locktime` (the HTLC's CLTV deadline, absolute
  unix seconds — the solver's own refund path), `min_confirmations`,
  `lockup_address` and `htlc_address` (both compare-only, kept distinct),
  `receiver_pk_script` (compare-only — the § 7.1.1.1 role it plays on the
  covenant). Amounts: the client locks `from_amount`; the solver funds the
  HTLC with `to_amount` — the amount minus this corridor's fee, fixed at
  quote time. A quote whose payout would be below the onchain dust floor is
  refused (`pricing_unavailable`), never funded.

#### 7.1.4 `onchain:BTC->arkade:BTC` — implemented today

The mirror: the client funds the onchain HTLC (holding its refund role) and
receives Arkade (`src/receive/onchainOrchestrator.ts`,
`src/wire/onchainReceivePayloads.ts`). The solver watches for the client's
funding output, waits `min_confirmations`, funds the Arkade lockup pinned to
the client's payout script, and claims the onchain HTLC once `P` is public.

- **request.profile**: `payment_hash` (`H`, client-chosen), `claim_packet`
  (as § 7.1.2), `refund_pubkey` (the client's x-only key — the onchain HTLC's
  refund role), `payout_address` and `payout_pubkey` (the client's Arkade
  destination and covenant `receiver` key — the same two the Lightning
  receive profile asks for, because both receive corridors carry the same
  Arkade covenant).
- **quote.profile**: `payment_hash` (echo), `claim_pubkey` (the solver's
  onchain claim key), `htlc_locktime` (the CLIENT's onchain refund deadline
  here — role-reversed from § 7.1.3), `min_confirmations`, `lockup_address`
  and `htlc_address` (both compare-only), and `solver_refund_pk_script` — the
  § 7.1.2 field, for the same reason: it is the one covenant parameter nothing
  else on the wire determines, and a client reconstructing the full tree cannot
  check `lockup_address` without it. The top-level `refund_locktime` is
  the SOLVER's own Arkade refund deadline on this leg. Amounts mirror §
  7.1.2: the client funds `from_amount` on-chain; the solver funds the
  lockup with `to_amount`, the amount minus this corridor's fee, subject to
  the same dust-floor refusal.

**Normative timelock-ordering invariant** for every client-funded HTLC-class
profile:

> The client's refund path opens **last**. The cross-side timeout, plus a
> safety margin, MUST fall strictly before the client's `refund_locktime`.

This is the generalisation of the send leg's rule (worst-case Lightning HTLC
lifetime + margin before the Arkade refund opens, `refundLocktimeFor` in
`src/core/send.ts`; the onchain send leg's `htlcLocktimeFor` /
`onchainRefundLocktimeFor` in `src/core/onchainSend.ts` are the same rule
with the onchain HTLC's CLTV standing in for the Lightning lifetime): the
solver is exposed between paying the cross side and claiming the client's
lockup, and the client's escape hatch must not open while the solver's
outbound commitment can still be live. For solver-funded contracts the
mirror applies (§ 9: the solver's refund opens before the cross-side
deadline `E`, minus a settle margin — the onchain receive leg's
`arkadeRefundLocktimeFor` in `src/core/onchainReceive.ts`).

#### 7.1.5 `arkade:BTC<->ethereum:<asset>` — forward spec

Same flow shape as 7.1.1–7.1.4: hash-locked contract on each side, the client
derives locally, funding is acceptance, the preimage settles both.

**Contract.** Boltz `ERC20Swap` (`BoltzExchange/boltz-core`). Chosen because it
is deployed and running at volume, has **no owner and no fee mechanism** — so
neither side must trust an admin key — and its `claim` takes a **`bytes32`**
preimage, hashed `sha256(abi.encodePacked(preimage))`. That is the same digest
Lightning uses, which is what lets one preimage span both legs, with no text
encoding anywhere on the path.

Not chain-specific: the contract is addressed by configuration, so any
EVM-compatible chain that hosts a deployment can serve this profile.

**No on-chain lock record.** `ERC20Swap` stores `mapping(bytes32 => bool)` — a
bare flag keyed by the hash of every lock parameter, in this order:

```
keccak256(abi.encode(preimageHash, amount, tokenAddress,
                     claimAddress, refundAddress, timelock))
```

`abi.encode`, so addresses are LEFT-padded to 32 bytes; `encodePacked` yields a
plausible key that matches nothing. **Both sides must retain all six values** —
neither party can recover a lock from the chain without them, and a lock that
cannot be addressed can be neither claimed nor refunded.

**The two directions do not carry the same fields**, because every role
reverses with them. Natural key: the payment hash. Common to both quotes:
`payment_hash` (echo), `evm_contract_address`, `evm_chain_id`,
`min_confirmations` and `min_age_seconds` (see acceptance), and
`lockup_address` (compare-only — the solver's derivation of the Arkade
covenant).

`arkade:BTC->ethereum:<asset>` — **the client funds the Arkade covenant**, so
it holds that side's refund role and names where it takes the tokens:

- **request.profile**: `payment_hash` (client-chosen), `evm_claim_address`
  (the client's own EVM address — the only party `ERC20Swap.claim` will pay),
  `refund_address` (the client's Arkade address) and `client_refund_pubkey`
  (its x-only key, for the covenant's client-side refund leaves).
- **quote.profile**: adds `evm_timeout_block` (a **block height**, see below) and
  `receiver_pk_script` (compare-only, the § 7.1.1.1 role: the client's local
  reconstruction must fill in the `nonInteractiveClaim` leaf to compute a
  matching merkle root, and only the solver knows that value).
- Exact-in only (`amount_side: "from"`): the two legs are different assets, so
  exact-out would mean inverting a fetched, rounded, directional rate.

`ethereum:<asset>->arkade:BTC` — **the solver funds the Arkade covenant**, so
the client must hand over the keys that pin the payout to it, exactly as
§ 7.1.2 and § 7.1.4 do:

- **request.profile**: `payment_hash`, `evm_amount` (atomic units of the token
  the client locks — the amount lives in the profile rather than the
  envelope's `amount`, because it is not denominated in sats), `evm_timeout_block`,
  `evm_refund_address` (where the client's own EVM refund goes), and the
  Arkade-side claim keys **`payout_address`** (the client's Arkade
  destination) and **`payout_pubkey`** (the covenant's `receiver` signing key
  — the same pair the other two receive profiles ask for, because all three
  carry the same covenant). The token is named by the `pair`, so it is not
  repeated in the profile. There is deliberately **no `claim_packet`**: this
  profile does not offer the covclaimd non-interactive path § 7.1.2 describes,
  so the client must be online to claim its own Arkade payout. Adding it later
  is additive — the covenant leaf is already there.
- **quote.profile**: adds `evm_claim_address` — the SOLVER's EVM address, and
  a value the client MUST use as `claimAddress` when it locks — and
  `solver_refund_pk_script` (compare-only), which is the leaf this direction's
  client cannot supply for itself: the roles are exchanged, so what it cannot
  know is where the solver's own refund goes.
- Exact-in only here too, and the envelope carries it differently: `amount_side`
  is `"from"` and the envelope's **`amount` is omitted entirely**, because what
  the client gives is a token quantity and `amount` is a JSON number — exact
  only to 2^53−1, which at 18 decimals is 0.009 tokens, rounded inside
  `JSON.parse` before any validator could see it. `evm_amount` carries it as a
  decimal string instead (§ 2.1). This is the one place an EVM profile is
  narrower than its § 7.1.2 / § 7.1.4 siblings, which accept **either**
  `amount_side` and always carry `amount`: on those corridors both legs are
  sats, so exact-out is a subtraction, while here it would mean inverting a
  fetched, rounded, directional rate.
- **status.profile** (both directions): `payment_hash`, the EVM lock's
  transaction hash, the Arkade lockup txid, `failure_reason`, and — in
  `settled` only — `preimage`.
- **request.profile**: `refund_address` (the client's Arkade address),
  `client_refund_pubkey`, and — for the `ethereum:<asset>->arkade:BTC`
  direction — the client's `evm_refund_address` and the `token_address` it is
  locking. Natural key: the payment hash.
- **quote.profile**: `payment_hash` (echo), `evm_contract_address`,
  `evm_chain_id`, `evm_timeout_block` (a **block height**, see below),
  `evm_claim_address` (whichever side claims on the EVM leg),
  `min_confirmations` and `min_age_seconds` (see acceptance), plus the Arkade
  side's usual `lockup_address` / `receiver_pk_script` for the direction that
  has one.
- **status.profile**: `payment_hash`, the EVM lock's txid, the Arkade lockup
  txid, `failure_reason`, and — in `settled` only — `preimage`.

**Timeouts are block heights, and the ordering is directional.** `ERC20Swap`
denominates its timeout in `block.number` while every deadline in this protocol
is unix seconds. Converting requires a per-chain block cadence, and the safe
direction differs by use: reading someone's timeout assumes the FASTEST cadence
(never believe there is more time than there is), sizing your own assumes the
SLOWEST (expire no later than intended). A single averaged constant is wrong for
one of the two.

The `_block` suffix carries that difference in the field name because the two
units sit **adjacent** in the same quote profile, and nothing else distinguishes
them. A client that reads `evm_timeout_block` as unix seconds — the reasonable
guess, since every other deadline here is — measures its recourse window against
a ~5-million-block integer, concludes it has centuries in hand, and skips the
check protecting it. This is the only block-denominated field in the protocol;
treat an unsuffixed deadline as seconds.

Whichever side locks **second** puts its own money at risk and must therefore
hold the **earlier** deadline, with a margin large enough to observe the
counterparty's claim and get its own confirmed:

```
arkade:BTC->ethereum:<asset>   evm_timeout_block + margin <= refund_locktime
ethereum:<asset>->arkade:BTC   refund_locktime   + margin <= evm_timeout_block
```

A quote whose deadlines cannot satisfy both that margin and a usable client
claim window is unserveable and MUST be refused rather than narrowed.

**Who funds first — and therefore whose deadline `evm_timeout_block` is.** The
ordering above is not a preference; it follows from the funding order, which is
fixed per direction and is the single most load-bearing thing an external client
implementer needs from this section:

- `arkade:BTC->ethereum:<asset>`: **the client funds the Arkade covenant
  first**, and funding is acceptance (§ 5). The solver observes that lockup,
  waits out `min_confirmations` and `min_age_seconds`, and only then calls
  `ERC20Swap.lock`. A solver MUST NOT lock before the Arkade lockup is funded
  for the quoted amount. `evm_timeout_block` is therefore the SOLVER's own deadline,
  chosen by the solver and carried in the **quote**; the client reads it to
  check the ordering above and to size its own claim window.
- `ethereum:<asset>->arkade:BTC`: **the client funds `ERC20Swap` first**, with
  the deadline it chose. `evm_timeout_block` is therefore the CLIENT's own deadline,
  carried in the **request**: the solver validates it, derives its own
  `refund_locktime` from it, and refuses outright if the ordering cannot hold
  (an `evm_timeout_block` already inside the margin is not narrowed, it is refused).
  The solver funds the Arkade lockup second, after the same depth-and-age wait.

Note the asymmetry against § 7.1.4, where the solver dictates the client's
onchain refund deadline in the quote. Here the deadline governs the client's own
refund, on a chain whose cadence the client is the party funding against, so the
client declares it and the solver only holds the power to refuse — which is all
the ordering invariant needs, since the solver picks `refund_locktime` freely
underneath whatever it accepts.

**Acceptance is depth AND age, not depth alone.** A solver MUST NOT treat a
cross-side lock as funded on confirmation count by itself. On a rollup the
sequencer issues a receipt in 1–2 seconds and a lock may be many confirmations
deep in that sequence while the L1 posting it depends on has not finalised —
twelve confirmations on a 250 ms chain is three seconds of protection. The quote
therefore carries both `min_confirmations` and `min_age_seconds`, and the
observing side waits for the **later** of the two.

**The claim is the receipt, as elsewhere in this class**, but it is an event
rather than a witness: claiming emits
`Claim(bytes32 indexed preimageHash, bytes32 preimage)`, and the counterparty
learns `P` by watching for that log. A log is untrusted input — anyone may emit
that shape from another contract, and the indexed topic is attacker-chosen — so
the observer MUST verify `sha256(preimage)` against the hash it locked against
before acting on it.

**Gas on the claiming side.** A client receiving tokens frequently holds none of
the chain's native asset and so cannot claim at all, which would resolve every
such swap by timeout. Two mechanisms are compatible with this profile:
`lockPrepayMinerfee`, which forwards native currency to the claim address in the
same transaction that locks, or a solver-operated claim address that claims and
forwards. A solver serving the `arkade:BTC->ethereum:<asset>` direction SHOULD
implement one and say which.

### 7.2 Atomic class (`arkade:X->arkade:Y`) — forward spec

Both assets live in the same Arkade, so nothing can be half-done. But the
settlement is **not a co-signed transaction**, which is what an earlier revision
of this section assumed — and that assumption is what left § 12 asking for a
partially-signed-transaction encoding. There is no such encoding.

**The offer IS the contract, and the CLIENT funds it.** The package calls this
_Arkade Intents_, and states the flow plainly: _"The user funds this contract; a
solver fills it through `fulfill`."_ So acceptance here is funding, exactly as it
is for the HTLC class — the client deposits into an `ArkadeProgramScript`
covenant that binds what any spend of it must deliver, and the solver takes the
deposit only by delivering.

The `maker*` argument names below are the FUNDING side's position in the script,
not a product role — the funder is the client here, not a market maker.

**Both ways out are asymmetric, and neither is a bare unilateral broadcast.**

- **`fulfill`** is signed by the **Arkade Service alone**, co-signed only after
  it has executed the covenant — which constrains the spend to pay output 0 at
  least `wantAmount` to `makerWP`. A solver cannot take the deposit without
  delivering. No client signature and no client availability are required,
  which is the sense in which the fill is non-interactive.
- **`cancel`** is a **2-of-2 of the funder and the Arkade Service**. No solver
  signature is involved, so the refund never depends on the counterparty being
  reachable — but it is cooperative, and it RACES a fill rather than
  pre-empting one. An offer being filled in the same moment is spent by
  `fulfill` first, and the cancel then fails with "no spendable VTXO at the swap
  address", which means the swap completed rather than that anything broke.

**Neither program carries a timelock.** An unfilled deposit keeps its place at
the swap address instead of expiring: no deadline to miss and no `expired` state
to unwind, at the cost of the refund being something the funder asks for rather
than something a clock delivers. That is why this class has no `refund_locktime`
— not because nothing can be refunded.

`@arkade-os/swap`'s `offerVtxoScript` builds it from `swapPrograms.wantBtc` or
`swapPrograms.wantAsset`, bound to:

| argument                                | what it binds                                                               |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `makerWP`                               | the client's witness program — `makerPkScript` minus its 2-byte prefix      |
| `wantAmount`                            | what the spend must pay the client                                          |
| `wantAssetTxid` / `wantAssetGroupIndex` | asset wants only; the txid is pushed **REVERSED**, into internal byte order |
| `server`, `user`                        | the Arkade Service key, and the client's own key                            |

So the covenant enforces _"whoever spends this pays `wantAmount` to `makerWP`"_.
That is why there is nothing to unwind: an unfilled offer was never
half-anything.

- **The solver's spend is the acceptance**, not a countersignature — the same
  shape as funding-is-acceptance in the HTLC class (§ 5), reached differently.
- **The client learns the outcome from the chain.** `classifySpend` reads a
  spend of the offer output as `fulfilled`, `cancelled`, or `indeterminate` —
  the literals as the SDK exports them (`SpendKind`), not the verb forms, so a
  `switch` written against this paragraph has no unreachable branch. No message
  from the solver is required for the client to know what happened.
- **`cancelOffer` is the client's reclaim path**, which is what this class has
  instead of a refund timelock. The quote still carries no `refund_locktime`,
  but the reason is not "nothing can be refunded" — it is that the client can
  withdraw an unfilled offer at will.
- **A registered offer resolves its outputs from the contract repository**
  rather than a direct indexer query; `cancelOffer` documents exactly that, with
  the indexer left as a fallback for offers predating registration. Anything
  reading an offer's funding must go through the same registration or it is
  holding a second view of the chain that nothing else in the process shares.
- The quote's binding fields remain the amounts, `solver_pubkey` and
  `valid_until`, and `offerTermsFromQuote` derives the offer's `wantAmount` from
  the quote's `to_amount` — so the quote precedes the offer rather than
  describing a transaction.
- This class is where the ~30-second `valid_until` windows apply: for a
  cross-asset pair the solver is short the market for the whole window.

**The offer is published by the funding transaction that creates it.** There is
no separate delivery step and no message: `createOffer` returns an EXTENSION
alongside the address, and the funder embeds it in the same send that deposits —

```ts
const o = await createOffer(wallet, ARK, { wantAmount: 1000n, wantAsset })
await wallet.send({ address: o.address, amount: 1000, extensions: [o.extension] })
```

— so the TLV packet rides on chain with the deposit, and a solver reads offers
off the transaction stream with `decodeOffer`. The restore scan does exactly
that, reading the same bytes back off the funding tx.

Two consequences worth stating for an implementer. `createOffer` broadcasts
nothing and is pure derivation, so **nothing exists on chain until the deposit
lands** — and identical offers derive an identical address, which is why the
FUNDING TXID rather than the address identifies a deposit. And the covenant is
registered with the funder's own contract manager before the address is returned,
so the deposit is watched from the moment it arrives.

**Confirmed against `@arkade-os/swap@0.0.9` as shipped** —
`swapPrograms`, `offerVtxoScript`, `classifySpend`, `cancelOffer`,
`offerTermsFromQuote` — rather than designed in this document. The offer packet
is TLV, type `3`, with tagged fields for `swapPkScript`, `wantAmount`,
`wantAsset`, `makerPkScript`, `makerPublicKey`, `emulatorPubkey` and
`offerAsset`; `encodeOffer` refuses a packet naming both a want asset and an
offer asset, or neither.

## 8. Lifecycle

One state vocabulary for all profiles:

```
refused    terms declined pre-contract; no exposure ever existed
quoted     binding terms issued; awaiting funding/fill until valid_until
expired    valid_until passed with no conforming, in-time fill — nothing funded, funded too late, or funded incompletely (any funds observed take the refund path)
funded     the settlement contract is funded (HTLC class only)
filling    the solver's outbound fill is in flight
filled     the outbound fill is no longer in flight; solver collecting (the receipt may not be on disk yet)
settled    both sides done; receipts (preimage) published
refunded   the contract's refund path executed
stuck      exposure exists and progress is impossible without a human
```

Mapping to the reference implementation's store states. Each corridor keeps
its own state machine (its own table, its own names); the mappers live in
`src/wire/*.ts` (`rfqStateFromRow` and siblings). The send leg
(`SendSwapState` in `src/db/swaps.ts`):

| RFQ state  | send-leg state                                      | note                                                                                                                                          |
| ---------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `refused`  | `refused`                                           |                                                                                                                                               |
| `quoted`   | `quoted`                                            |                                                                                                                                               |
| `expired`  | `refused` (free-text reason, e.g. `lockup timeout`) | the store folds expiry into `refused`, distinguished by the reason                                                                            |
| `funded`   | `funded`                                            |                                                                                                                                               |
| `filling`  | `paying`                                            | Lightning payment in flight                                                                                                                   |
| `filled`   | `paid`, `claiming`                                  | outbound fill no longer in flight, solver collecting; preimage on disk from `claiming` onward (`paid` = payment id known, preimage maybe not) |
| `settled`  | `claimed`                                           | preimage published in the claim witness                                                                                                       |
| `refunded` | `refused` + refund outcome recorded                 | the refund is an outcome fact on the terminal row, not a state                                                                                |
| `stuck`    | `stuck`                                             |                                                                                                                                               |

The other three corridors (`src/db/receiveSwaps.ts`, `src/db/onchainSwaps.ts`,
`src/db/onchainReceiveSwaps.ts`):

| RFQ state             | Lightning receive                                 | onchain send                           | onchain receive                      |
| --------------------- | ------------------------------------------------- | -------------------------------------- | ------------------------------------ |
| `quoted`              | `quoted`                                          | `quoted`                               | `quoted`                             |
| `funded`              | `armed` (client's HTLC held)                      | `funded` (client's lockup seen)        | `awaiting_confirmations`             |
| `filling`             | `funded` (solver's lockup broadcast), `refunding` | `funding_onchain`, `refunding_onchain` | `funding_arkade`, `refunding_arkade` |
| `filled`              | `claimed`                                         | `awaiting_claim`, `claiming`           | `awaiting_claim`, `claimed`          |
| `settled`             | `settled`                                         | `claimed`                              | `settled`                            |
| `refunded`            | `refunded`                                        | `refunded`                             | `refunded`                           |
| `refused` / `expired` | `refused` (reason-refined)                        | `refused` (reason-refined)             | `refused` (reason-refined)           |
| `stuck`               | `stuck`                                           | `stuck`                                | `stuck`                              |

Normative solver invariants (both are load-bearing in the reference
implementation and MUST hold in any implementation):

- **Single-writer CAS transitions.** Every state change is a
  compare-and-swap on `(id, expected_from_state)` over a **closed** edge set;
  exactly one writer wins a race, anything outside the edge set fails loudly.
  This is what stops two workers double-paying one invoice and stops any
  retry tool walking a swap backwards into re-paying
  (`LEGAL_EDGES` + `transition()` in `src/db/swaps.ts`).
- **Stuck-over-silence.** A swap in an exposed state (`filling` onward) that
  cannot make progress MUST escalate to `stuck` — visibly, for a human — and
  MUST NOT be flattened into a generic failure state or silently retried
  forever. `refused` is reserved for swaps that never created exposure.

## 9. Safety invariants

These are **invariants, not tunables**. A deployment that could switch them
off could lose money, so there is no switch (`src/core/send.ts`,
`src/core/receive.ts`, `src/core/onchainSend.ts`,
`src/core/onchainReceive.ts`). Every gate is **re-evaluated at action time** —
immediately before the irreversible step it guards; quoting, funding and
filling are separated by network waits, and a check that passed at quote time
can be false by the time money moves. A quote-time pre-check is permitted and
the reference does one (`evaluateSendAcceptance`, `src/core/send.ts`), but it is
never sufficient. Note how narrow that pre-check is: the ONLY expiry a quote is
refused for is an invoice with no fundable window left at all. A solver SHOULD
NOT impose a quoting floor on invoice expiry beyond that. Shorten `valid_until`
to fit the invoice instead (`lockupDeadlineFor` does exactly this — the funding
window is `min(quotedAt + DEFAULT_LOCKUP_TIMEOUT, invoice_expiry -
MIN_INVOICE_WINDOW)`), because the invoice clock bounds one thing only: whether
the PAYEE still accepts the payment. What guards the money is the payee's CLTV
delta held against `refund_locktime`, and no term of that reads invoice expiry.
A floor there only refuses invoices the solver could have served — the reference
carried two such floors (17 min, and before it 92 min, the latter derived from
`MIN_CLAIM_WINDOW`, which bounds `refund_locktime - now` and says nothing about
the invoice) and both refused ordinary payee invoices.

| invariant                      | value                     | guards                                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIN_CLAIM_WINDOW`             | 90 min                    | never fill within 90 min of the client's refund path opening. 90 because the refund CLTV matures against **median-time-past** (BIP-113), which lags wall clock by ~1 h on mainnet — a wall-clock margin smaller than the MTP lag is no margin at all. The same figure is the client-side funding gate ("headroom ≥ 90 min") |
| `MIN_INVOICE_WINDOW`           | 2 min                     | never pay a BOLT11 that could lapse mid-attempt                                                                                                                                                                                                                                                                             |
| `MIN_SETTLE_WINDOW`            | 90 min                    | receive direction: never fund unless ≥ 90 min remain before `E`                                                                                                                                                                                                                                                             |
| `SETTLE_SAFETY_MARGIN`         | 15 min                    | receive direction: the funder's refund opens at least this long before `E`, so funds are recoverable while settlement is still possible                                                                                                                                                                                     |
| `MAX_REFUND_HORIZON`           | 2 h                       | receive direction: cap on how long one swap may park solver capital (`refund_locktime ≤ now + 2 h`)                                                                                                                                                                                                                         |
| `REFUND_SAFETY_MARGIN`         | 2 h                       | send direction: margin on top of the worst-case cross-side HTLC lifetime before the client's refund opens                                                                                                                                                                                                                   |
| route CLTV budget              | 432 blocks @ 10 min/block | conservative over-estimate of route-added CLTV when deriving `refund_locktime` from an invoice's final CLTV delta                                                                                                                                                                                                           |
| `ONCHAIN_CLAIM_MARGIN_SECONDS` | 90 min                    | onchain send: the client's claim-window floor, doubled into `htlcLocktimeFor` so the client's own `claim_window_too_short` guardrail passes with margin                                                                                                                                                                     |
| `ONCHAIN_ORDER_MARGIN_SECONDS` | 2 h                       | onchain corridors: the timelock-ordering margin — the client's Arkade refund opens at least this long after the onchain HTLC's deadline (send), and the solver's Arkade refund opens before the HTLC deadline minus margin (receive)                                                                                        |
| `MAX_MIN_CONFIRMATIONS`        | 6                         | cap on the `min_confirmations` a quote may carry                                                                                                                                                                                                                                                                            |
| `ONCHAIN_DUST_SATS`            | 330                       | onchain corridors: a payout below the taproot dust floor is unquotable (`pricing_unavailable`) and a claim/refund spend that would leave a sub-dust output is refused rather than broadcast                                                                                                                                 |

Additionally:

- `refund_locktime` for a client-funded Lightning send is
  `max(now + (final_cltv + 432) · 600 + 2 h, now + unilateral_claim_delay + 2 h)`
  — the second bound covers the solver's server-independent recourse window.
- **Exposure cap.** The solver bounds the sum of amounts across all
  non-terminal swaps and refuses new quotes above it with reason
  `exposure_cap`. This is the only invariant with **no action-time
  counterpart** — it is enforced once, at quote time (each quote is capacity
  the solver may have to honour).
- **Per-corridor policy.** Amount ranges and fees are per corridor in the
  reference implementation (`<CORRIDOR>_MIN_SATS`/`_MAX_SATS`,
  `<CORRIDOR>_FEE_BPS`/`_FEE_FLAT_SATS`, and `<CORRIDOR>_ENABLED` to darken a
  corridor entirely — an unserved corridor refuses `unsupported_pair`); the
  fee lives in the quote's two amounts per § 4.2 and is fixed at quote time.

## 10. Refusal reasons

Closed set. Solvers MUST emit only these; clients MUST treat any unknown
reason as a generic decline (no retry semantics inferred).

| reason                | meaning                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unsupported_pair`    | pair not served (includes wrong network for the asset)                                                                                                                                                       |
| `unsupported_payload` | malformed request, unknown fields, or a profile input the solver cannot serve (e.g. a zero-amount invoice, an undecodable refund address)                                                                    |
| `amount_out_of_range` | outside the solver's min/max for the pair                                                                                                                                                                    |
| `exposure_cap`        | solver at aggregate capacity right now                                                                                                                                                                       |
| `invoice_expired`     | the supplied invoice is expired or expires too soon to swap safely                                                                                                                                           |
| `quote_conflict`      | the `rfq_id` or natural key is already bound to a different or already-progressed negotiation (§ 4.5)                                                                                                        |
| `pricing_unavailable` | the solver cannot price this swap — no market data, or the corridor's configured fee leaves nothing servable at this size (the fee consumes the amount, or the payout would be under the onchain dust floor) |
| `rate_limited`        | the requester has opened too many quotes recently — back off and retry later                                                                                                                                 |

The reference implementation's internal refusal names map onto the closed set
(`toRfqReason`, `src/wire/payloads.ts` — anything unrecognised degrades to
`unsupported_payload` rather than leaking a non-spec string):

| internal                     | RFQ v1                |
| ---------------------------- | --------------------- |
| `wrong_network`              | `unsupported_pair`    |
| `zero_amount_invoice`        | `unsupported_payload` |
| `invalid_refund_address`     | `unsupported_payload` |
| `invalid_payout_address`     | `unsupported_payload` |
| `unsupported_payload`        | `unsupported_payload` |
| `invoice_expired`            | `invoice_expired`     |
| `invoice_expires_too_soon`   | `invoice_expired`     |
| `amount_out_of_range`        | `amount_out_of_range` |
| `fee_consumes_swap`          | `pricing_unavailable` |
| `payout_below_dust`          | `pricing_unavailable` |
| `recourse_window_unservable` | `pricing_unavailable` |
| `duplicate_swap`             | `quote_conflict`      |
| `provider_at_capacity`       | `exposure_cap`        |
| `rate_limited`               | `rate_limited`        |

`recourse_window_unservable` is the one mapping that is a judgement rather than
a rename. It means the operator's Arkade exit delay is too long for any invoice
to carry a final CLTV delta a stock payer will route, so no request on that
corridor can be served until the deployment changes. The closed set has no name
for "unservable as configured"; `pricing_unavailable` is used because the two
alternatives are actively misleading — `unsupported_payload` blames a request
that was well-formed, and `unsupported_pair` contradicts a registry card that
still advertises the pair, inviting a client to drop the solver permanently.
A client seeing it should back off, not rewrite its request.

## 11. Solver implementation checklist

What a from-scratch solver bot needs, in dependency order. Items marked (ref)
have a tested reference in this repo.

1. **Transport** — outbound WebSocket to relays; reconnect arming on **both**
   `error` and `close` with backoff; subscription replay on every reconnect;
   bounded outbound queue for events published while disconnected (ref:
   `src/relay/connection.ts`, killed-and-restarted-broker test in
   `test/relay/websocket.test.ts`).
2. **NIP-44** — encrypt/decrypt kind-24859 content; validate event signatures;
   address by `p` tag.
3. **Strict parsing** — schema-validate requests, reject unknown fields with
   `unsupported_payload`; ignore stray events silently (ref:
   `src/ingress/relay.ts`).
4. **Idempotent store** — UNIQUE on the natural key; duplicate request →
   re-emit the existing quote while `quoted`, `quote_conflict` once the swap
   has progressed; a `refused`/`expired`/`refunded` prior releases the key
   (ref: `src/db/swaps.ts`, `src/ingress/relay.ts`).
5. **Pricing & validity sizing** — resolve both amounts, fee in the spread;
   size `valid_until` to the pair class (~30 s cross-asset, minutes
   same-asset).
6. **Gates at action time** — the § 9 invariants, each checked immediately
   before the step it guards, clock injected for testability (ref:
   `src/core/send.ts`, `src/core/receive.ts` — pure functions, no I/O).
7. **State machine** — closed edge set, single-writer CAS transitions,
   crash recovery by re-reading rows (the row is the truth; commit intent
   before every irreversible side effect), stuck-over-silence (ref:
   `src/db/swaps.ts`, `src/send/orchestrator.ts`).
8. **Per-profile settlement** — the § 7 mechanics for each pair served;
   derive-locally/compare-only on every contract; preimages only ever read
   from public settlement artifacts.
9. **Solver ad** — publish and refresh kind 38859; keep it honest and
   indicative. In practice, also file the solver-registry corridor card
   (§ 3.1) — today it is the discovery path clients actually use.
10. **(Optional) Open-RFQ bidding** (§ 4.6) — a second subscription per
    served market keyed by the canonical market-key tag; a bid handler that
    prices from config (no invoice decode) and seals `rfq_bid` to the
    broadcast's author; a per-pair rate limit. The directed path is
    untouched (ref: `src/core/openRfq.ts`, `src/ingress/relay.ts`,
    `test/core/openRfq.test.ts`).

## 12. Open questions

- **Kind numbers.** `24859`, `24860` and `38859` are provisional; final
  numbers — and the open-RFQ `t`-tag convention — need coordination (and
  possibly a NIP). The RANGES are settled and should survive whatever numbers
  are agreed: negotiation is ephemeral, the advertisement is addressable. Only
  the digits are open.
- **Quote bonding.** A quote is signed but costless; whether solvers should
  bond against reneging on observed-in-time funding (and how slashing would
  work) is open. The same question covers bids (§ 4.6): a reneged bid today
  costs only reputation.
- **Atomic-class fill format — the encoding question was the wrong question.**
  There is no partially-signed transaction and no `rfq_fill` — the message does
  not exist, and `@arkade-os/swap@0.0.9` never constructs one. The CLIENT funds
  an `ArkadeProgramScript` covenant binding `makerWP` and `wantAmount`,
  publishing the offer packet as an extension on that very funding transaction;
  a solver reads it off the transaction stream and fills it through `fulfill`,
  which the Arkade Service signs alone after executing the covenant. Refund is
  `cancel`, a 2-of-2 of the funder and the Service, with no timelock (§ 7.2).
  Still open: whether a solver should publish offers of its own rather than only
  filling them.
- **Atomic-class fill format.** The exact partially-signed Arkade transaction
  encoding for `rfq_fill` (and who broadcasts) is unspecified.
- **Canonical Ethereum HTLC contract — RESOLVED for 7.1.5**: Boltz
  `ERC20Swap`, addressed by configuration so any EVM chain can serve it. Still
  open: whether a published third-party audit is required before mainnet.
  Neither surveyed candidate has one — Boltz is battle-tested by volume, the
  alternative ships only automated analysis and says itself that it "should
  undergo professional security audit before use in production with significant
  funds". **This one is gated, not deferred**: an operator MAY enable an EVM
  corridor on mainnet before the question is answered, but only with the
  corridor's `_MAX_SATS` bound (§ 9) set to an amount it would accept losing
  outright to a contract defect, because the aggregate exposure cap does not
  distinguish a corridor's contract risk from any other's. Raising that bound is
  the decision this entry gates, and answering the audit question is what closes
  it. Also open: per-chain `min_confirmations` / `min_age_seconds` norms, which
  cannot be a single figure across chains.
  funds". Also open: per-chain `min_confirmations` / `min_age_seconds` norms,
  which cannot be a single figure across chains.
- **Multi-solver fan-out** is resolved by the open-RFQ flow (§ 4.6):
  broadcast, sealed bids, directed close; losing bids expire with no
  notification. Still open from that design: whether a shared bus may
  itself pick the winner (thin-client UX) — that variant needs
  public-and-signed bids so the pick is auditable, i.e. the registry spec's
  dormant v1 quote layer plus a matcher — and the exact granularity of the
  § 4.6 size-bucket ladder. The § 2 leg-ordering rule for markets the
  registry leaves unordered (both or neither side arkade) is this spec's
  extension and should be upstreamed so the two documents cannot drift.
- **Key separation.** v1 assumes one solver key for transport identity and
  settlement; splitting them (hot Nostr key, cold settlement key) needs a
  binding proof in the ad or quote.
- **Cross-corridor asset identity.** § 2 gives each asset one canonical id,
  but the same economic asset has a different native identity on every
  corridor it exists on: an ERC20 contract address on `ethereum`, an Arkade
  AssetId on `arkade`, a 32-byte id on a Liquid-like corridor. Nothing in this
  spec binds those together, so `ethereum:USDT->arkade:USDT` asserts "same
  asset" on the strength of a shared ticker. What is needed is an explicit
  equivalence registry — one canonical asset, a per-corridor native id, and a
  per-corridor decimals — maintained as configuration by whoever operates the
  registry, never derived from chain metadata (§ 2.1). Until that exists a
  solver serving a cross-corridor same-asset pair is trusting its own config,
  and a wrong-issuer id is a swap into a worthless lookalike rather than a
  refusal.
- **Routing.** § 2 says new corridors and assets extend the registries without
  changing the protocol. That holds for EDGES and not for ROUTES. Every
  message here names exactly one `pair`, so a trade that transits an
  intermediate asset — `ethereum:USDT -> arkade:USDT -> <other>:USDT` — has no
  representation: no route field, no per-leg amounts, no composed
  `valid_until`, and no statement of which party holds an intermediate asset
  if one leg settles and the next does not. Note that a solver holding
  inventory on both edges settles such a trade as TWO contracts, one inbound
  and one outbound, with the middle as a book entry — in which case the
  existing single-pair messages suffice and only the quoting layer needs to
  know a route existed. A representation is needed only where an intermediate
  leg is sub-contracted to a third party, and that case also imports a
  decreasing timelock ladder whose per-hop cost on an Arkade leg is bounded
  below by the operator's own unilateral exit delay. Neither the
  representation nor the ladder is specified here.
