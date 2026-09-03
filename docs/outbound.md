# The outbound approach — a provider with zero listening ports

This is the end-state transport: the provider (solver) runs behind NAT with no
public endpoint and no open ports. It does not accept connections — it *opens*
one, to a relay, and reads swap requests off it. Every side effect the container
has is outbound: quote ingestion (relay), Lightning payment, the Arkade claim,
the covenant refund, and lockup polling are all connections the provider itself
initiates.

Verified end to end on regtest: `scripts/e2e-relay.sh` (see the run at the
bottom).

## Why outbound at all

A solver that is only reachable by URL can never sit behind NAT, and the design
intent (`docs/architecture.md`) is a fleet of solvers that each subscribe
outward. HTTP was always the scaffold; the relay is the destination. The seam
that makes the swap is `SwapIngress` — the money path (`SendSwapService`) only
ever sees `quote(invoice, refundAddress)`, so swapping the inbound HTTP host for
an outbound relay connection changes the transport and nothing downstream.

## The pieces

| Piece | Role | Direction |
|---|---|---|
| relay | pub/sub broker (Nostr, or any broker) | both parties dial IN to it |
| `cli relay` | provider: relay ingress + the watch loop, one process | outbound only |
| `examples/send-client-relay.mjs` | reference client | outbound only |
| `scripts/mock-relay.mjs` | a ~60-line dev broker for local runs | — |

The relay's specific wire protocol lives behind ONE codec seam. The default
dialect is Nostr (`packages/solver-transport/src/relay/nostr.ts`, `RELAY_PROTOCOL=nostr`): NIP-01
`REQ`/`EVENT`/`CLOSE`, NIP-44-sealed directed traffic, wallet identity as the
transport key. The minimal generic broker framing (`{op:'sub'|'unsub'|'event',
...}`, `encodeFrame`/`decodeFrame` in `packages/solver-transport/src/relay/connection.ts`) stays
available behind `RELAY_PROTOCOL=dev` for local runs against
`scripts/mock-relay.mjs`. Nothing above the codec changes between the two.

## The flow

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (outbound)
    participant R as Relay
    participant P as Provider `cli relay` (outbound, no ports)
    C->>R: publish rfq_request { rfq_id, pair, profile: { invoice, refund_address } }, addressed to P
    R-->>P: delivered (P is subscribed to events addressed to its pubkey)
    P->>P: quote() — persists the swap, builds the covenant address
    P->>R: publish rfq_quote { solver_pubkey, refund_locktime, valid_until, profile.lockup_address, ... }
    R-->>C: delivered (addressed to C)
    C->>C: derive the script LOCALLY; refuse if it ≠ lockup_address
    C->>C: gate (invoice live, ≥90min headroom)
    C->>P: fund the lockup (Arkade send from C's own wallet)
    Note over P: watch loop (running alongside the ingress) sees the lockup
    P->>P: pay the invoice → learn preimage → claim the lockup
    C->>C: lockup vtxo spent on-chain → swap complete
```

Two properties worth calling out:

- **Both parties address by pubkey.** The client sends its request to the
  provider's x-only pubkey (logged at provider startup); the provider replies to
  the client's. No URLs anywhere in the protocol — which is exactly what makes a
  future move to a per-pubkey solver fleet a config change, not a rewrite.
- **Redelivery is safe.** Relays redeliver. A re-sent request for a payment hash
  the provider already quoted re-emits the EXISTING quote (never a second swap),
  so a client that missed the first reply recovers by asking again. The store's
  `UNIQUE(payment_hash)` is the backstop.

## What the client trusts

Identical to the HTTP client (`examples/send-client.mjs`) — the transport does
not change the trust model. From an `rfq_quote` the client trusts only the
binding fields — `solver_pubkey`, `refund_locktime`, `valid_until` and the
amounts — and derives everything else itself (payment hash from its own
invoice, Arkade server key from its own connection, emulator key from its own
fetch, refund script from its own wallet). `profile.lockup_address` is
compare-only; a mismatch means refuse-to-fund. Status is available over the
relay via `rfq_status_request`, and completion is always observable
**on-chain**: when the provider claims, the lockup vtxo is spent and
disappears.

## Running it

```bash
# stack + two funded wallets (see runbook § "Replicating end to end on regtest")
#   .env.regtest         provider wallet
#   .env.regtest.client  a DISTINCT client wallet, funded the same way
node scripts/mock-relay.mjs &   # dev broker :7447 — requires RELAY_PROTOCOL=dev on both ends
RELAY_URL=ws://localhost:7447 RELAY_PROTOCOL=dev \
  node --experimental-eventsource --env-file=.env.regtest packages/solver-app/dist/cli.js relay &   # provider, no ports

# client: request over the relay, fund own derivation, watch on-chain
invoice=$(node --experimental-eventsource --env-file=.env.regtest packages/solver-app/dist/cli.js invoice 1000 | tail -1)
node --experimental-eventsource --env-file=.env.regtest.client \
  examples/send-client-relay.mjs ws://localhost:7447 <providerPubkey> "$invoice"
```

Or the whole thing as one assertion:

```bash
scripts/e2e-relay.sh      # PASS/FAIL, orchestrates relay + provider + client
```

## Verified run (regtest, 2026-08-04)

Provider `cli relay` up with pubkey `ae7541ac…`, **no listening ports**; a
DISTINCT client wallet (`tark1qr34…kv3q30v5…`, funded separately) drove the swap:

```
provider pubkey: ae7541ac452cd804453cfbbac2984787f798f734052ab0a629f53a3721aed409
sending 1000 sats, payment hash 8120f10a…
funded 1000 sats at own derivation, arkTxid 73d83005…
lockup spent — the provider claimed it. Swap complete.
```

Provider's durable record: the swap reached `claimed` with claim txid
`dccef7bc…`, driven by the watch loop that runs alongside the relay ingress — no
inbound connection at any point.

## Production notes

- **Reconnect is load-bearing.** `webSocketRelayConnection` reconnects on drop
  and REPLAYS its subscriptions on the new socket, arming on both `close` and
  `error` (a failed connect fires only `error`) — otherwise a relay blip
  silently stops swap requests. Tested in `test/relay/websocket.test.ts` by
  killing and restarting the broker.
- **The mock relay is dev-only.** It speaks the same frames but is not a real
  relay; production points the codec at a hardened broker.
- **This is the image's default.** `CMD` is `relay`, so a platform that just
  builds the Dockerfile (`packages/solver-app/Dockerfile`, built with the repo
  root as its context) gets the outbound mode with no command override — and
  `swap-provider` in `docker-compose.yml` is that same default. Health is the
  mtime of `RELAY_HEALTH_PATH`, refreshed only while the relay socket is up: a
  process check would report a disconnected solver healthy for as long as it
  stayed deaf, which is exactly how one shipped.
