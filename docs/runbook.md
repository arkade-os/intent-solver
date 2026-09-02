# Runbook — deploying and operating the swap provider (send leg)

Everything here has exactly one implementation of the money path
(`SendSwapService`); the pieces below are hosts around it. Two supported
deployment shapes, one hybrid.

## Pieces

| Piece                   | What it does                                         | Where it can run                                                           |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| API (`buildApp`)        | quotes + status, bus-shaped payloads                 | Node (`serve`) or Cloudflare Workers (`fetch`)                             |
| Ingress (`SwapIngress`) | how swap requests REACH the provider                 | HTTP (`serve`, inbound) or relay (`relay`, outbound-only)                  |
| Money-mover             | drives swaps: fund-watch → pay → claim; refund sweep | Node (`watch`/`serve`/`relay`) or Workers `scheduled`+`queue` (see caveat) |
| Store                   | durable swap state, compare-and-swap transitions     | better-sqlite3 file (Node) or D1 (Workers)                                 |
| CLI                     | every operation by hand; the reproducibility surface | Node                                                                       |

**Workers caveat, read before choosing:** `fetch` + D1 is test-proven. The
`scheduled`/`queue` handlers additionally require the Lightning and Arkade SDKs to
run inside a Workers isolate, which is NOT yet verified (both hold long-lived
connections). Until verified, run the money-mover as the Node process and only
the API on Workers if you want Workers at all.

## Configuration (environment)

| Var                                  | Required                                                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SWAP_NETWORK`                       | yes (`bitcoin`\|`signet`\|`mutinynet`\|`regtest`)            | selects the network profile (limits, prefixes, emulator)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `LN_BACKEND`                         | yes, unless all four BTC corridors are off                   | `lnd` = talk to a real LND node's gRPC directly; `fake` = forge-and-pay-own-invoices backend for regtest E2E, refused on `bitcoin`. A rail a consumer registered through `registerLightningRail` is accepted by name too. **No default.** A rail is a PAIR — one wallet answers both the Lightning and the onchain port — so all four BTC corridors take their backend from this one value, and it may be left unset only where every one of them is switched off (`<CORRIDOR>_ENABLED=false`). An unrecognised value throws and names the accepted set |
| `LND_SOCKET`                         | yes if `LN_BACKEND=lnd`                                      | `host:port` of the LND node's gRPC listener                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `LND_CERT` / `LND_CERT_PATH`         | yes if `LN_BACKEND=lnd` (exactly one)                        | LND's `tls.cert`, inline base64 or a file path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `LND_MACAROON` / `LND_MACAROON_PATH` | yes if `LN_BACKEND=lnd` (exactly one)                        | LND's macaroon, inline base64 or a file path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `FAKE_LN_STATE_PATH`                 | no (`<DB_DIR>/fake-ln.json`)                                 | the fake backend's preimage map                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ARK_MNEMONIC`                       | yes                                                          | Arkade wallet. Secret — never logged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ARK_SERVER_URL`                     | yes                                                          | arkd endpoint; startup refuses a server reporting a different network than `SWAP_NETWORK`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DB_DIR`                             | no (`.data`; `/data` in the image)                           | directory for every database file; the two below override it per file                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ARK_DB_PATH`                        | no (`<DB_DIR>/ark.sqlite`)                                   | Arkade wallet state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SWAP_DB_PATH`                       | no (`<DB_DIR>/swaps.sqlite`)                                 | swap rows — one file, or five on an older deployment; see Backups                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `EMULATOR_URL`                       | no on `bitcoin` (defaults to the known emulator), else yes   | covenant co-signer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `MAX_SWAP_SATS`                      | no                                                           | narrows the per-swap cap (can never widen)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MAX_EXPOSED_SATS`                   | no (3 × maxSats)                                             | aggregate exposure cap across concurrent swaps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `LOCKUP_TIMEOUT_SECONDS`             | no (`900`)                                                   | UPPER bound on the funding window a Lightning-send quote grants, before the sweep abandons the swap; clipped to the invoice when that expires first (`lockupDeadlineFor`), so it sets no minimum invoice life. Integer in `[60, 7200]`, the ceiling derived from `REFUND_SAFETY_MARGIN` — the window is spent out of the claim margin, so a longer one only yields swaps that refuse themselves                                                                                                                                        |
| `LN_SEND_HINT_SCID_DENYLIST`         | no (empty)                                                   | comma-separated lowercase hex `short_channel_id`s whose route hints are not priced, so the refund deadline is not sized against a route nobody can take. Ships EMPTY and with no example: add an entry ONLY on authoritative confirmation (vendor, node operator, recipient) that the channel cannot route. A scid's shape is not confirmation — `option_scid_alias` values are unrelated to any real height. **A wrong entry is a fund-risk, not a lost swap**: see "Denylisting an unroutable route hint"                            |
| `PORT` / `HOST`                      | no (`8787` / `127.0.0.1`)                                    | `serve` binding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ADMIN_PORT`                         | no (off)                                                     | admin console port. Unset means no console and no new socket. **No authentication — see "The admin console"**                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ADMIN_HOST`                         | no (`127.0.0.1`)                                             | admin console binding. A non-loopback value is ALLOWED (the container needs it); access control is a reverse proxy's job                                                                                                                                                                                                                                                                                                                                                                                                               |
| `RELAY_URL`                          | yes for `relay` (the default command)                        | outbound relay WebSocket URL (e.g. `wss://nostr.arkade.sh`) — `wss://`, not `https://`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `RELAY_HEALTH_PATH`                  | no (`.data/relay-health`; `/data/relay-health` in the image) | `relay` refreshes this file's mtime every 10s while the relay socket is up; the image's HEALTHCHECK reads it                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `RELAY_PROTOCOL`                     | no (`nostr`)                                                 | relay wire dialect; `dev` speaks the mock-relay broker framing                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `OPEN_RFQ_MAX_BIDS_PER_MIN`          | no (`30`)                                                    | open-RFQ bidding rate cap (`relay` mode); `0` disables bidding                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ARK_UNILATERAL_EXIT_DELAY`          | no (believe the server)                                      | seconds. Overrides the unilateral exit delay arkd advertises, for a server that enforces a shorter minimum than it announces. Sets the CSV timelocks in every covenant — too LOW writes a script rejected at SPEND, with money already in it. See "The recourse window on mainnet"                                                                                                                                                                                                                                                     |
| `LN_RECEIVE_ACCEPT_UNILATERAL_GAP`   | no (`false`)                                                 | `true`/`false` exactly. Serves `lightning:BTC->arkade:BTC` when the solver's solo recourse opens after the htlc's `E` — **required for the corridor to run on mainnet at all**, see "The recourse window on mainnet" below. Accepts a bounded loss; `bitcoin` additionally requires `LN_RECEIVE_MAX_SATS` to be set explicitly                                                                                                                                                                                                         |
| `<CORRIDOR>_ENABLED`                 | no (`true`)                                                  | `false` darkens that corridor (`LN_SEND`, `LN_RECEIVE`, `ONCHAIN_SEND`, `ONCHAIN_RECEIVE`): never constructed, and its pair is refused `unsupported_pair` at the ingress. Rows already on disk stay readable and refundable                                                                                                                                                                                                                                                                                                            |
| `PAYEE_MNEMONIC`                     | test-only                                                    | payee wallet for `invoice` self-tests, which mint from a wallet of their own                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Shape 1 — single Node process

```
pnpm install && pnpm build
node --experimental-eventsource --env-file=.env dist/cli.js serve
```

One process = API + recovery + tick loop + refund sweep. Restart-safe: on boot
it re-drives every non-terminal row (`findRecoverable`), resuming mid-payment
swaps via the payment-hash idempotency key. Run under systemd or similar with
`Restart=always`; nothing else is needed for crash safety — the row is the
truth.

**Backups**: the money-critical databases, plus each one's `-wal`/`-shm`. A
funded script whose row is lost is unclaimable AND unrefundable by us (clients
can still be refunded by anyone reconstructing the script, but do not rely on
it). Snapshot at least every few minutes; SQLite online backup or litestream
both work. `ARK_DB_PATH` is wallet cache + state; back it up too, it is cheap.

WHICH files those are depends on when the deployment was first started, and the
service picks whichever it finds — it never moves rows between them.

**Started fresh on this version or later — one file.** Every corridor's tables
live in `SWAP_DB_PATH` itself. Back up that one file and you have everything.

**Started earlier — five files.** Each corridor opened its own database, named
off `SWAP_DB_PATH` by suffix. At the default `<DB_DIR>/swaps.sqlite`:

| file                           | holds                          |
| ------------------------------ | ------------------------------ |
| `swaps.sqlite`                 | Lightning-send rows            |
| `swaps-onchain.sqlite`         | onchain-send rows              |
| `swaps-receive.sqlite`         | Lightning-receive rows         |
| `swaps-onchain-receive.sqlite` | onchain-receive rows           |
| `swaps-admin.sqlite`           | settings overrides + audit log |

**Back up ALL of them.** Copying only `swaps.sqlite` loses three corridors'
worth of funded swaps — the mistake this table exists to prevent. litestream
replicates one database per stanza, so it needs an entry per file rather than
the single-file one-liner.

Losing `swaps-admin.sqlite` alone strands no money, but it silently reverts
every override — a corridor an operator DISABLED comes back on at the next boot.

To tell which layout you have, look for a suffixed file next to `SWAP_DB_PATH`:
any one of them means the five-file layout. Moving an existing deployment onto
the single file is deliberately not automatic — it would mean copying funded
rows between databases at startup, and a half-finished copy is worse than the
files it replaced.

## Shape 1a — the same thing as a Docker image (recommended)

```
docker compose up -d          # Dockerfile + docker-compose.yml in the repo root
```

One container = Shape 1 (`serve`), with `/data` as the volume carrying every
SQLite file — the swap database(s) and the Arkade wallet. CI builds and smoke-tests the image on every push.

- **Outbound-only by default.** No ports are published; the API is reached over
  a private network (VPN, or an outbound tunnel like cloudflared, which keeps
  zero open ports on the VPS). This deliberately matches the end-state
  architecture in which the solver only subscribes outward — when the bus
  transport replaces HTTP, the last inbound path disappears and nothing about
  the container changes.
- **Scaling is capital, not compute.** The loop is O(non-terminal swaps) with a
  few outbound RPCs each; a 1-vCPU box runs hundreds of concurrent swaps, and
  `MAX_EXPOSED_SATS` caps the workload long before CPU does. Scale by raising
  exposure and inventory.
- **One wallet = one process — never replicate the container.** Two processes on
  the same `ARK_MNEMONIC` cannot see each other's funding reservations — those
  live in a process-local ledger — so one can spend a coin out from under the
  other's in-flight funding. Horizontal scale is N solver identities: N
  containers, N mnemonics, N volumes. That maps one-to-one onto the future bus
  model where each solver is a pubkey.
- **Backups**: the litestream sidecar in the compose file (commented) streams
  the swap DB to any S3-style bucket continuously. Turn it on for real funds —
  and on a five-file deployment keep every database in its config, since one
  stanza covers one file and a corridor left out of it is a corridor whose
  funded rows are not backed up.
- **The image defaults to `relay`**, not `serve` — a platform that just builds
  the Dockerfile (Dokploy, Railway, Fly, plain `docker run`) gets the mode that
  actually serves traffic. Any other command needs its HEALTHCHECK overridden
  too: the default probes the relay heartbeat, which only `relay` writes.
  `serve` has `/healthz` instead (the compose file carries the override);
  `watch` has neither and wants no healthcheck at all.

## Shape 1b — purely outbound (the end-state)

**Full write-up, flow diagram and the verified E2E: [`outbound.md`](./outbound.md).**

```
RELAY_URL=wss://your-relay ... dist/cli.js relay      # or just: docker compose up
```

The `relay` command replaces the HTTP ingress with an outbound relay
connection: the provider subscribes (outbound WebSocket, no port) for
`rfq_request` events addressed to its own pubkey, quotes each through the
same corridor services, and publishes the quote back to the relay. Everything
the container does — quote ingestion, LN payment, claim, refund, fund-watch
polling — is now an outbound connection. **Zero listening ports.** Proven end to
end on regtest with a distinct client wallet: `scripts/e2e-relay.sh`.

That script defaults to `scripts/mock-relay.mjs`, which needs no relay running
but speaks a broker framing (`{op:'sub'}`) that only it understands. To prove
the flow against a REAL Nostr relay — which is the only way the framing is
actually tested — bring up arkade-regtest's `nostr` profile (strfry on
`ws://localhost:7777`) and point the script at it:

```bash
SKIP_MOCK_RELAY=1 RELAY_URL=ws://localhost:7777 RELAY_PROTOCOL=nostr scripts/e2e-relay.sh
```

Both halves must speak the same dialect. The provider already did; the
reference client gained `nostrRelayTransport` (`examples/lib/swap-client.mjs`)
for exactly this, since the dev framing earns `bad msg: unparseable message`
from a real relay and the request never reaches the solver. On Git Bash, a
`docker run -v /app/...` mount needs `MSYS_NO_PATHCONV=1` or the path is
rewritten and strfry silently loads its own config and binds to loopback.

That covers the send direction. The receive direction has its own ingress arm,
and `scripts/e2e-relay-receive.sh` drives it — a `lightning:BTC->arkade:BTC`
request over strfry, answered with a real hold invoice and lockup address:

```bash
scripts/e2e-relay-receive.sh
```

Quote only, deliberately: paying the invoice, funding the lockup and claiming
with `P` are already covered by `test/e2e/receiveLightning*.e2e.test.ts` against
the orchestrator, and the leg those cannot reach is the one that arrives off the
wire. It needs the `nostr` profile and covclaimd (:7271) but no LND — the
default `.env.regtest` runs `LN_BACKEND=fake`, whose hold-invoice half is a full
`LightningBackend`. `ENV_FILE=.env.regtest.lnd` drives the same leg against a
real LND; both are verified.

- Clients address offers to the provider's x-only pubkey (logged at startup).
  The payloads on the wire are byte-for-byte the HTTP bodies, so a client is
  the same client with a different send target.
- Redelivery-safe: a re-sent request for a payment hash already quoted re-emits
  the EXISTING quote (never a second swap), so a client that missed the first
  reply recovers by asking again.
- The wire dialect lives behind the `WireCodec` seam in
  `packages/solver-transport/src/relay/connection.ts`. Two ship: the Nostr codec (`packages/solver-transport/src/relay/nostr.ts`,
  the default, `RELAY_PROTOCOL=nostr`) and the dev broker framing
  (`RELAY_PROTOCOL=dev`, for `scripts/mock-relay.mjs`). Nothing above the
  codec changes between them.
- **What is proven:** the ingress loop (subscribe → quote → publish, refusals,
  redelivery recovery) and the frame codec against an in-memory relay; the
  concrete `webSocketRelayConnection` against a real WebSocket broker in tests —
  including reconnect with subscription replay, and specifically the case where
  the relay is STILL DOWN on a reconnect attempt (a failed connect fires only
  'error', never 'close'; retrying solely from 'close' stops forever). The full
  loop also ran live on regtest: mock relay + `cli relay` + `relay-client.mjs`.
- The arkd tx stream (`subscribeForScripts` + `getSubscription`) is a real,
  outbound push channel that can later replace fund-watch polling for lower
  latency. Not required for "purely outbound" — polling is already an outbound
  HTTPS call, no port — so it is left as an optimisation, not a dependency.

## Shape 2 — Cloudflare Workers (API today; money-mover when SDK-verified)

Wrangler sketch (the repo ships the code, not the wrangler config — bindings
are deployment-specific):

```jsonc
// wrangler.jsonc
{
  "name": "swap-provider",
  "main": "src/entry.ts", // your ~10-line file, see below
  "compatibility_date": "2026-08-01",
  "d1_databases": [{ "binding": "SWAPS_DB", "database_name": "swaps" }],
  "triggers": { "crons": ["* * * * *"] }, // scheduled drive
  "queues": {
    "producers": [{ "binding": "DRIVE_QUEUE", "queue": "swap-drive" }],
    "consumers": [{ "queue": "swap-drive", "max_retries": 10 }],
  },
  // secrets via `wrangler secret put`: ARK_MNEMONIC, ...
}
```

```ts
// src/entry.ts — the deployer owns this file; it is the only wiring
import { makeWorkerEntry, SwapStore, d1Driver /*, ...service deps */ } from 'lightning-swap-service'

export default makeWorkerEntry(async (env: Env) => {
  const store = await SwapStore.open(d1Driver(env.SWAPS_DB))
  // Build SendSwapService exactly as src/cli.ts createServices does, from env
  // secrets. This is the unverified-in-isolate part for the money-mover; for
  // an API-only worker, a service wired with quote-time deps suffices.
  return { service, store, network: 'bitcoin', driveQueue: env.DRIVE_QUEUE }
})
```

How the handlers divide the work:

- `fetch` — the same Hono app as Node. D1 via `d1Driver` (null→undefined and
  `meta.changes` normalisation live in the driver; the store is identical).
- `scheduled` (cron) — replaces the Node loop's "every 3s". Every firing either
  drives all swaps inline (no queue binding) or enqueues one `tick_swap` job
  per non-terminal swap plus one `refund_sweep` job.
- `queue` — one message = one swap tick. Failures `retry()` (redelivery resumes
  from the row — a dropped tick for an exposed swap is a forgotten claim);
  successes `ack()`.

Concurrency is safe in every combination (Node watch + cron + queue consumers
simultaneously): the store's compare-and-swap decides exactly one winner for
the transition that spends money, and the payment-hash idempotency key makes
even a double `payInvoice` submission single-pay.

## Hybrid (recommended today)

API on Workers + D1 is fine **only if** the money-mover shares the same store —
which today means D1 access from Node, which is not wired. So the practical
hybrid until the SDK-in-isolate question is settled: run Shape 1 whole
(cheapest, proven), or put a dumb proxy/Worker in front of Shape 1's `serve`
for edge/TLS/rate-limiting.

## The admin console

An operator console — swaps, quotes, settings, wallet, backend status, audit —
on **its own port**, served from inside the running provider.

```bash
ADMIN_PORT=8788 pnpm cli relay     # or serve, or watch
# then http://127.0.0.1:8788
```

Off unless `ADMIN_PORT` is set. A deployment that sets nothing opens no new
socket and behaves exactly as before.

### There is no authentication on this port

**Anything that can reach it can move money.** It can push covenant refunds,
reclaim L1 HTLCs and spend the float. That is a deliberate decision: access
control belongs to a reverse proxy in front of it (basic auth, mTLS, an SSO
proxy — whatever the deployment already runs), not to a second half-implemented
auth system in this codebase.

What follows from that:

- `ADMIN_HOST` defaults to `127.0.0.1`. On a host you have shell access to,
  leave it there and reach the console over an SSH tunnel:
  `ssh -L 8788:127.0.0.1:8788 <host>`.
- In Docker, loopback is unreachable from outside the container, so
  `ADMIN_HOST=0.0.0.0` is required — and then publishing the port without a
  proxy in front exposes every action above to anything that can route to it.
  Publish it to the proxy's network, never to the world.
- The app does **not** refuse a non-loopback bind. Every other ambiguous knob
  in `config.ts` refuses rather than guessing; this one cannot, because the
  container case legitimately needs the wider bind. The check that matters is
  in your proxy config, not here.

### Why it runs inside the provider process

Arkade coin reservations live in a **process-local** ledger
(`packages/solver-arkade/src/arkade/reservations.ts`). A separate admin process could not see what the
running provider has reserved and would spend coins out from under an in-flight
funding. So the console shares the live wallet, stores and reservations — and
is only up while the provider is.

The console is a strict _reader_ of the money layer: it polls the stores and
diffs them for live updates rather than instrumenting any orchestrator. The one
exception is actions, which call the same `src/ops/` functions the CLI calls.

### Actions, and the confirmation they require

Safe actions (`tick`, `pool-plan`) are one click. The rest require a `confirm`
field matching an expected value, **checked by the server** before anything
runs — the browser dialog is a convenience, and bypassing it with a bare
`fetch` gets refused the same way.

| action               | confirm with       |
| -------------------- | ------------------ |
| `refund-now`         | the swap id        |
| `onchain-refund-now` | the swap id        |
| `reclaim-l1-htlc`    | the swap id        |
| `pool-mint`          | the literal `MINT` |

`onchain-refund-now` deserves the caution it asks for: for a `stuck` row it is
correct in some cases and **a double-payout in others**, because the solver may
already have paid out on the onchain leg. Read the row and the onchain HTLC
first.

Every action is written to an audit log — successes and failures both — in
`<SWAP_DB_PATH>-admin.sqlite`, alongside settings overrides. Separate from the
swap databases on purpose: losing that file loses preferences and history,
losing a swap database loses funds.

### Settings changes need a restart

The console stores overrides for corridor fees, per-corridor amount ranges,
corridor on/off and the global exposure cap, in `<SWAP_DB_PATH>-admin.sqlite`.

`createServices` resolves them **once at startup** and hands the result to
every service, so an override takes effect **at the next restart** — not
before. Nothing re-reads a running service's policy. The Settings view shows
what THIS process is quoting; a pending override is what the next one will.
Every API response says so and the UI badges it.

Everything that has to agree with what gets quoted reads the same resolved
policy: the ingress corridor gate, the open-RFQ bidder, and the registry card.
A card advertising a fee the corridor does not charge would be a listing that
lies, so `cli card` reads overrides too.

Overrides **replace** what the environment allowed, in either direction. A
console override may raise a corridor's maximum or the global exposure cap
above the deployment's own environment, as well as lower it. `narrow()` still
governs the env layers themselves (`MAX_SWAP_SATS` and the per-corridor
variables can only narrow the network default), but it no longer constrains
this one — so the environment bounds what a _restart without overrides_ would
quote, not what this solver can be made to quote.

> **The admin API has no authentication of its own.** A reverse proxy is
> expected to supply it and `adminHost` decides what the port is even reachable
> from — see "Admin console" above. With overrides able to widen, whatever
> reaches that port can raise this solver's per-swap and total exposure caps.
> Treat the proxy's auth and the bind address as the controls that matter.

Fees move freely too, within the same bounds `config.ts` validates. A corridor
the environment disabled cannot be enabled here at all: no service was
constructed for it. A minimum and maximum that cross fall back to the
environment's range for that corridor rather than leaving it quoting nothing.

Secrets are not shown. Not redacted — absent, so there is no field for a bug to
un-redact.

## Operating notes

- **`stuck` rows are the pager.** They mean "money may have left and needs a
  human": payment terminally failed after exposure, a claim failing past the
  refund deadline, or an empty script at/after the deadline (possible client
  refund of a paid swap). `cli status <id>` + the event history is the record.
  The one terminal payment failure that never reaches the pager: a
  **self-payment** (the invoice was minted by this deployment's own node —
  e.g. the same solver on both ends of a swap). Our own node is the payee,
  so its "never paid" record is proof the sats never left; the lockup is
  refunded non-interactively at once and the row lands in `refused` with
  `refund_outcome: pushed` (a legacy three-leaf row waits for the ordinary
  deadline sweep instead — still no human). Both backends here implement the
  probe; one whose invoice lookup cannot tell an unknown payment hash from an
  unpaid one must not guess, and keeps the old behaviour. **Working one: see
  "Working a `stuck` row" below.**
- **`claimed` with `claim_ark_txid: null`** = claim landed but a crash ate the
  txid (only recorded as success BEFORE the refund deadline, where nobody else
  could spend). Verify once by hand if you care about the txid.
- **`settled` with `onchain_claim_txid: null` on onchain-receive** is the
  RECOVERY path, not a missing write. The solver crashed after broadcasting its
  L1 claim and before recording it; on the next tick it found the HTLC already
  spent, recognised its own preimage in the witness, and settled on that
  evidence. `findSpendWitness` returns the witness stack and never the spending
  txid, so there is nothing truthful to put in the column — the state is the
  record. To find the transaction, look up the spend of the row's
  `funding_txid`:`funding_vout` on a block explorer rather than expecting a
  txid in the row.
- **Refund sweep needs no keys** and is safe to run anywhere, even many times
  concurrently: the covenant only lets the money go to the client. Push errors
  are retried next sweep. `FORFEIT_CLOSURE_LOCKED` = locktime not yet matured
  against MEDIAN-TIME-PAST (lags wall clock ~1h) — normal, not an incident, and
  every rejected push writes an error line in the emulator operator's logs, so
  keep retry cadences slow.
- **Emulator key rotation** breaks covenant refunds only for swaps quoted
  before the rotation (the key is snapshotted per row). If the emulator
  operator announces a rotation, drain: stop quoting, let in-flight swaps
  finish, then resume.
- **Provider key rotation** (`ARK_MNEMONIC`) is a drain-first operation too:
  swaps quoted under the old key refuse to pay (the lockup takes the covenant
  refund back to the client), and a swap already paid can only be claimed by
  the OLD key — keep it until every in-flight swap is terminal.
- **Gate the emulator at the network level.** This service only ever calls
  out to `EMULATOR_URL` — it is external Arkade-ecosystem infrastructure,
  not something this repo hosts, so there is no application-level fix here.
  The covenant itself is the correctness boundary (the emulator co-signs
  based on script satisfaction, not caller identity), but an emulator open
  to the whole internet is unnecessary surface — a reverse proxy or
  firewall rule restricting it to known solver egress IPs is a reasonable
  operator hardening step, out of this repo's scope to enforce.
- **CLTV maturity is median-time-past**, not wall clock (BIP-113). Anything
  that "should have matured 20 minutes ago" and hasn't is MTP lag, not a bug.
- **Every corridor refusing `insufficient_unreserved_balance` while
  `cli balances` shows a healthy total = the float is behind an asset.** Recover
  with `cli pool --mint`, which makes it spendable again immediately.

  The cause is a loop rather than a one-off, so expect it back after the next
  renewal. A no-argument `settle()` sweeps every coin the wallet can select into
  ONE output, and settle carries Arkade assets onto the output matching the
  wallet's own script. So if any coin holds an asset, the next renewal puts the
  WHOLE float on that one coin — and an asset-bearing coin may not fund a sats
  lockup, because spending it as sats would destroy the asset. Measured on
  regtest: nine coins (eight of them plain sats) became one 8,550,951-sat
  asset-bearing coin after a single settle, with no swap traffic at all.

  `cli pool --mint` works because the split isolates the asset: it lands on
  exactly one piece and the rest come out clean. It is a recovery, not a fix —
  nothing re-splits automatically after a renewal consolidates. Tracked in
  arkade-os/lightning-swap-service#123.

  The refusal reason is true (there really are no spendable sats) but names the
  wrong cause, which is why this is worth recognising by its signature: a large
  `total` beside a dead corridor. `cli balances` prints `assets` separately, so
  an asset in the float is visible there.

- **Exposure**: `cli balances` shows current exposed sats vs the cap. The cap
  counts every non-terminal swap including bare quotes, and quote creation is
  metered per requester (5 per 15-minute window, keyed by socket IP on `serve`,
  author pubkey on `relay`) so squatting the cap takes a distributed effort,
  not one script. Raising `MAX_SWAP_SATS`/`MAX_EXPOSED_SATS` is a deliberate
  operator act — and since console overrides may now widen as well as narrow,
  so is anything with access to the admin port. The env value is a starting
  point, not a ceiling; see "Settings changes need a restart".
- **Known limits** (details in `environment.md`): no server-independent claim
  is implemented yet (a censoring Arkade server after payment is an unmitigated
  loss — the script has the leaf, the unroll flow is TODO); the _cooperative_
  covenant refund still needs Arkade server + emulator both alive, but a
  client-unilateral fallback leaf now exists for when they aren't (RFQ-family
  quotes only — see `docs/rfq-protocol.md`); a truly-failed payment can
  sit `pending` until an operator looks (deliberate allowlist).

## Working a `stuck` row

`stuck` means **the payment was already exposed when it failed** — the solver may
or may not have paid out, and the row cannot tell on its own. It is the only
state that waits for a person.

**Nothing will retry it.** `stuck` is terminal: `step()` has no case for it, the
sweep skips it, and `findRefundable` excludes it by name. That is deliberate,
not an oversight — a backend's "failed" verdict is trusted there, and a false
negative plus an automatic refund is a **double payout**. So the row sits until
someone works it, however long that is. One sat for four days holding 50,151
sats before anyone noticed.

The console now says so: the count sits in the status bar and the rows on the
overview, newest first, each linking to its detail.

### The procedure

1. **`read payment`** on the detail dialog (any Lightning-send row — it is not
   gated on a payment id, because a row without one is the `never-submitted`
   answer). It asks the backend over the running solver's own connection and
   answers with a verdict:

   | verdict                      | meaning                                                                                                                        |
   | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
   | `not-paid-refund-is-safe`    | terminal failure, and our own node is not holding an htlc for it. The sats never left.                                         |
   | `paid-do-not-refund`         | settled, or a preimage exists. **You paid.**                                                                                   |
   | `self-payment-do-not-refund` | the payer side failed, but **our own node holds an armed or settled htlc** for this invoice. The payee side may still collect. |
   | `undecided-push-nothing`     | neither — including a backend that has no record of the payment id. Do not act on it.                                          |
   | `never-submitted`            | no payment id on the row; nothing was ever sent.                                                                               |

   The response also carries `ownInvoice`, which says how the self-payment
   question was answered: a hold status, `not-ours`, `probe-failed` (the node
   could not be asked) or `probe-unavailable` (this backend cannot answer it).
   `not-ours` and `probe-failed` both allow the refund — but only one of them
   means the question was actually answered, and on a large row that difference
   is worth a look at the node yourself.

2. **Act on the verdict, and only on the verdict.**
   - `not-paid-refund-is-safe` → **`refund-now`**. The client gets their lockup
     back. You are out nothing. The row then leaves `stuck` for `refused`,
     shown as `refunded`: the client is whole and there is nothing left to do,
     so it comes off the queue. It is never shown as `done` — the swap ended
     safely, it did not deliver.
   - `paid-do-not-refund` → **`claim-now`.** Do NOT refund; that is the double
     payout the state exists to prevent. The lockup must be CLAIMED with the
     preimage, and before `refund_locktime` — after which the client can
     reclaim it and you are out the full amount.

     `claim-now` pushes nothing itself. It records the preimage and returns the
     row to `claiming`, so the sweep moves the money through the same path
     every other claim takes. It refuses a row that is not `stuck`, and refuses
     any preimage that does not hash to the row's payment hash. If the row
     carries no preimage and the backend holds none, you must supply one — it
     will not guess.

   - `self-payment-do-not-refund` → **push nothing**, and go and look at the
     invoice on your own node. This is a swap whose payee is you: the payer side
     reporting failure says nothing about whether the payee side will collect,
     and refunding while it still might is the same double payout. It is also
     the reason the automatic refund declined and the row parked here.
   - `undecided` / backend unreachable → **push nothing.** A pending payment is
     not a failed one. Come back when the backend answers.

3. **Check `refund_attempt` on the row** before assuming no refund was tried.
   `pushed` / `nothing-at-script` / `failed: <reason>` / absent (never ran). A
   `failed:` there is the automatic post-failure refund having thrown — the
   client is NOT whole, and step 2 still applies.

   `nothing-at-script` means the lockup was already spent — by your own claim,
   or by the client after `refund_locktime`. No refund happened, so the row
   stays `stuck`: nothing was resolved, and it still wants a human.

4. **If nothing above can move it, `park-swap`.** It stops the sweep touching
   the row and records your reason on it. Reach for it when a swap fails in a
   way retrying cannot fix — before it existed, a row whose every tick threw
   was re-driven indefinitely, and one retried for six days.

   It does NOT refund or claim. Decide that separately, with `read-payment`.

### The other corridors

The procedure above is `arkade:BTC->lightning:BTC`, and `read-payment` is that
corridor's action alone — it asks a Lightning backend what became of a payment,
which is a question the other three do not have. Their resolve actions:

| corridor                    | actions                                                   |
| --------------------------- | --------------------------------------------------------- |
| `lightning:BTC->arkade:BTC` | `receive-refund-now`                                      |
| `arkade:BTC->onchain:BTC`   | `onchain-refund-now`, `reclaim-l1-htlc`                   |
| `onchain:BTC->arkade:BTC`   | `onchain-receive-refund-now`, `onchain-receive-claim-now` |

`recheck` and `park-swap` apply everywhere.

The console orders all of this for you: **1 · look** (moves nothing), **2 ·
resolve** (moves money), **3 · give up**. The sentence above the buttons names
the next step, and an armed button is marked _"not what the read supports"_
when the last verdict disagrees with it.

### What the clock actually is

Two deadlines, and they are not the same one:

- **`invoice_expires_at`** — after this the Lightning payment can no longer
  succeed. If it had not settled by then, it never will.
- **`refund_locktime`** — after this the CLIENT can unilaterally reclaim their
  lockup. This is the one that costs money: if you paid and have not claimed by
  then, they take the lockup back and the payout is gone.

A row whose invoice expired days ago but whose locktime is still a week out is
not urgent — it is decided. Read the payment, refund, move on.

### The case with no good answer

A crash **between** `claimFundLease` and the payment leaves a row nothing can
retry: the lease is held, so no other worker will take it, and re-driving is the
double-spend the lease exists to prevent. If the payment did land,
`findLockups` adopts it on the next tick and the row heals itself. If it did
not, the row stays put.

That one needs wallet-level idempotency to fix properly, which the port does not
have. Until then it is an operator procedure: confirm on the backend that no
payment exists, then treat it as `not-paid`.

## Verifying a deployment

```
cli balances                       # both wallets reachable, caps shown
cli invoice 500 | xargs cli send   # full E2E against yourself (test networks / capped mainnet)
cli test-refund 500                # covenant refund path, matures immediately
```

All three were last proven on mainnet 2026-08-04: funding `831e51ce…`, claim
`0937f4a7…`, covenant refund `99935874…`.

### When a send is refused `cltv_too_large`

```
node scripts/decode-invoice.mjs lnbc21u1p...
```

Pure decode — no SDK, no wallet, no build, no network — so it is safe to run
anywhere, including against an invoice a client pasted into a support thread.

The refusal message carries a TOTAL, and a total cannot say whether one hint is
absurd or several are fine with a bad peer among them. That difference decides
which of two gates fired, and they mean opposite things:

| detail line       | which gate               | what it means                                                                                                                                                                                  |
| ----------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `best-hint floor` | `decodeInvoice`          | even the invoice's most favourable route blows `MAX_CLIENT_CLTV_BLOCKS` (288). No backend can serve it; ask the client for an invoice with ordinary timelocks                                  |
| `worst-hint rule` | `evaluateSendAcceptance` | the invoice offers a good route among bad ones, and only THIS rail is in the way — it cannot cap the route it picks, so it could be made to take the bad one. An LND deployment would quote it |

Route hints are ALTERNATIVES: the payer picks one and owes only its hops. A
Wallet of Satoshi invoice carrying hints of `[40]` and `[40000]` is the second
row — every real payer settles it, and running LND is one fix. Do **not** raise
`MAX_CLIENT_CLTV_BLOCKS` to make the first row go away: it is sized against the
refund deadline on a rail that enforces nothing, so raising it widens the
double-collect window on every deployment.

There is a second fix below, and it applies to both rows — but only where the
offending hint can be CONFIRMED not to name a routable channel: see
`LN_SEND_HINT_SCID_DENYLIST`. How a scid looks is never that confirmation.

### Denylisting an unroutable route hint (`LN_SEND_HINT_SCID_DENYLIST`)

`LN_SEND_HINT_SCID_DENYLIST` is a comma-separated list of `short_channel_id`s
whose route hints this deployment will not price. A hint carrying one is dropped
WHOLE — a hint is a path, and one with a hop cut out of the middle is a path that
does not exist — before either CLTV total is taken, so the gates keep protecting
the routes that remain. Unset or empty prices every hint, which is what the
corridor did before the knob existed.

**It ships empty, and with no example to copy.** The bar for an entry is high
enough that no scid clears it without a conversation, and the section below is
mostly about why.

#### A wrong entry is a fund-risk, not a lost swap

This asymmetry decides everything about how the list is curated, and it does not
run the way "just a filter" suggests.

- An **incomplete** denylist costs nothing new. The invoice is refused, which is
  what happens today.
- A **wrong** entry — one naming a channel that can actually route — reopens the
  double-collect window. The raw BOLT11 is paid verbatim (`submitPayment` reads
  `row.invoice`), a rail that does not enforce a CLTV ceiling drops the
  `maxCltvBlocks` we hand it, and the refund deadline was priced without the hint
  a route can still take. An HTLC that outlives the deadline lets the client
  refund the lockup and then settle the payment, collecting both.

Nothing in the code can catch a wrong entry. The service cannot tell a fictional
channel from one it simply cannot see, so this page is the only control there is.

#### What is NOT evidence

None of these tell you a hint is unroutable, and the first two are actively
misleading:

- **A block height the chain has not reached.** A scid in a route hint may be an
  `option_scid_alias`, and BOLT #2 requires an unannounced channel's alias to be
  "a value not related to the real `short_channel_id`", requires the node to
  "always recognize the `alias` as a `short_channel_id` for incoming HTLCs", and
  permits it in BOLT 11 `r` fields — where, for an `option_scid_alias` channel,
  it is the ONLY thing permitted. An alias is not a confirmation height, so
  decoding one to a future block says nothing at all.
- **The scid looking synthetic** — a round number, a repeated word, a high
  block. LND allocates its aliases from block heights **16,000,000 to
  16,250,000** (`aliasmgr.IsAlias`), so a value in that range is evidence FOR a
  live private channel rather than against one. Other implementations pick from
  ranges of their own.
- **`lncli getchaninfo` answering "edge not found"**, on one node or on ten.
  Private channels are never gossiped (BOLT #7), so their scids are absent from
  every public graph by design. Absence from gossip is what a private channel
  looks like.
- **A large CLTV.** Long private routes are real — a deep JIT channel, an LSP
  path. Refusing them by size is the CLTV threshold this knob was chosen over.

#### What IS evidence

Authoritative confirmation, from someone in a position to know, that the hint
does not name a channel that can route:

- the **wallet vendor** whose invoices carry it, confirming the hint is a
  placeholder or a misconfiguration;
- the **node operator** named by the hint's own pubkey, confirming no such
  channel exists;
- the **recipient**, for a counterparty you can reach directly.

Record which one you got and when, next to the entry. An entry added on
inference is the unsafe case, and inference is what every discarded criterion
above amounts to.

If you cannot get that confirmation, the invoice stays refused. That is the
supported outcome, and there are two better answers than guessing: run LND,
which enforces `max_timeout_height` and so declines the bad route rather than
taking it, or get the rail to cap the route it picks.

#### The procedure

1. **Read the hints**, to see which scid the CLTV is attached to:

   ```
   node scripts/decode-invoice.mjs lnbc21u1p...
   ...
     hop 0: cltv=40000 base=0 ppm=0 scid=f42400f424000001 (block 16000000, tx 16000000, out 1) [LND scid-alias range]
   ```

   The script decodes each scid, flags the alias range, and prints the caveat
   above beneath the hints. The numbers locate the hint and give you something to
   ask about in step 2 — they are not themselves an argument.

2. **Get authoritative confirmation**, per the section above. The hint's first
   hop carries a node pubkey; that node, or the wallet vendor whose invoice it
   is, is who can answer.

3. **Add it and restart.** The list is read once at startup:

   ```
   LN_SEND_HINT_SCID_DENYLIST=<confirmed scid>,<another confirmed scid>
   ```

   Entries are 16 lowercase hex characters; anything else refuses to boot rather
   than silently matching nothing.

4. **Check the log.** Every quote whose hints were filtered says so:

   ```
   quote <payment hash>: dropped 1 denylisted route hint(s) (scid <scid>, 40000 blocks); pricing the worst surviving hint at 40 blocks
   ```

   No line means nothing was dropped — the scid you added is not the one on this
   invoice. The current list is also shown read-only in the admin console.

The list is static, so a newly-observed scid is refused until it is confirmed,
added, and the service restarted. If offenders turn out to rotate, this knob's
premise (a small, stable, CONFIRMABLE set) is wrong and the fix is a route-CLTV
cap from the rail, not a longer list.

### When a send is refused `uncapped_route_deadline_too_short`

The pay-time twin of the `worst-hint rule` row above, and it means the rail
changed under a row that was already quoted. `refundLocktime` is stored on the
row at quote time; `enforcesRouteCltv` is read from whichever backend is running
when the payment goes out, and nothing on the row records which one quoted it
(`payment_backend` is written alongside a payment id, so it exists only after a
payment). A `funded` row has no staleness bound either — the funding deadline is
checked in `quoted`, not after.

So an `LN_BACKEND` change from a rail that enforces a route-CLTV cap to one that
does not inherits rows whose deadlines were sized off the BEST route hint,
because the old rail could decline the worst and the new one declines nothing.
The gate refuses those rows rather than paying them.

What to check, in order:

1. **Did `LN_BACKEND` change recently?** That is the cause, and it clears on its
   own once the rows quoted under the old rail have drained or timed out. Moving
   back to `lnd` until they have is the only way to pay them.
2. **If not, look for a stalled worker.** On a rail that cannot cap, the quoted
   deadline already reserves the whole funding window, so without a rail change
   this fires only when a row was PAID more than `LOCKUP_TIMEOUT_SECONDS` after
   it was quoted — which the ordinary sweep cannot do, since a tick carries a row
   from `funded` through payment in one pass. The reachable path is crash
   recovery, where the gap between quoting and paying is unbounded.

What it never does is eat the claim margin. `REFUND_SAFETY_MARGIN` is the time an
observe-and-claim needs after the preimage arrives, against a deadline maturing
on median-time-past; the gate holds it whole and refuses instead of spending it,
which is why the boundary is the funding window and not the margin.

A row that reaches it from `paying` lands in **`stuck`**, not `refused` — the
crash-recovery path re-submits without re-asking any pay-time gate, so the gate
lives in `submitPayment` too, and a row leaving an exposed state needs a human
rather than the refund sweep. Settle it the usual way (`read-payment`,
`scripts/lookup-htlc.mjs`) before refunding or claiming. From `funded` it lands
in `refused` and refunds on its own.

Never "fix" it by widening the deadline after the fact. The refusal is the gate
holding: on a rail that cannot cap the route, an HTLC longer than the stored
deadline is the double-collect window, and the swap refunds cleanly instead.

## The receive corridor's recourse window, and when it refuses everything

`lightning:BTC->arkade:BTC` will not fund a swap unless the solver's OWN
unilateral recourse opens before the htlc's deadline `E`. The reason is an arkd
outage: with the server unreachable the collaborative paths are all gone, and
the only live paths are the CSV leaves. The trader's `unilateralClaim` opens
before the solver's `unilateralRefundWithoutReceiver` — that ordering is
mandatory and must not be "fixed", since a funder whose refund opened first
could take the money from a claimant holding the preimage. So if `E` passes
first, a trader can let the htlc fail back to the payer at no cost and only
then claim the Arkade payout, taking both sides (issue #69).

Two things follow that an operator will meet in the wild.

**`E` is chosen at quote time, not hoped for.** The invoice's final CLTV delta
is the one part of the deadline that is ours, so the quote asks for a delta
large enough to clear every bound funding will later check — the settle window,
the committed Arkade refund deadline, and the recourse above. On the regtest
ladder the binding bound is the refund deadline, not the recourse: 8100s, 54
blocks.

**Past roughly a 3.5-day exit delay the corridor cannot be served at all.** The
required delta scales with the operator's exit delay, and beyond 2016 blocks
(LND's default `max_cltv_expiry`) a stock payer will not route the invoice.
Every quote is then refused `recourse_window_unservable`. That is a property of
the deployment, not of the request: no retry helps, and the only remedies are a
shorter operator exit delay or a payer population that honours a longer delta.
A mainnet-scale delay of about a week needs 4044 blocks and is therefore out of
reach today.

### The recourse window on mainnet

The paragraph above describes a wall, and mainnet is behind it. arkd reports
`unilateralExitDelay=605184` (7 days, already a whole number of BIP68 units), so
the solver's solo leaf opens at 7.05 days and the corridor asks for **4074
blocks** of final CLTV against a 2016 ceiling. Every quote is refused
`recourse_window_unservable`, before the hold invoice is minted, for every
client — so this looks like a client bug and is not one.

Neither obvious lever helps. Raising `MAX_FINAL_CLTV_BLOCKS` moves nothing real:
4074 blocks is about **28 days of a payer's funds** at nominal block time, and no
routing node holds an htlc that long, so 2016 is reporting the wall rather than
being it. Finishing `TODO(unilateral-exit)` does not help either — it would let
the solver USE the leaf, but the 7-day CSV is unchanged.

There are two ways out, and they are different decisions.

**If arkd enforces less than it advertises, shorten the delay.** The advertised
value is what this service reads, and on mainnet it is not the minimum the server
checks scripts against. `ARK_UNILATERAL_EXIT_DELAY=<seconds>` makes the solver
believe the real number, and **anything at or below 296448s (~3.43 days) serves
the corridor with every gate intact** — no risk accepted, gate (d) untouched. The
cliff is `maxServableExitDelay()`, derived from `MAX_FINAL_CLTV_BLOCKS` rather
than written down, and pinned from both sides by a test.

#### What mainnet actually reports

arkd's own dashboard lists four exit delays, and the field the SDK calls
`unilateralExitDelay` is **not** the one named "Unilateral exit":

| dashboard row          | seconds    | BIP68 units | required delta         |
| ---------------------- | ---------- | ----------- | ---------------------- |
| Unilateral exit        | **259584** | 507         | 1770 blocks — servable |
| Public unilateral exit | 605184     | 1182        | 4074 blocks — refused  |
| Checkpoint exit        | 605184     | 1182        | —                      |
| Boarding exit          | 7776256    | 15188       | —                      |

`info.unilateralExitDelay` reports **605184**, which is exactly the _Public_
unilateral exit. The delay our covenant leaves are actually checked against is
the plain "Unilateral exit", 259584s — 2.33x shorter, and the whole reason this
corridor looked unservable. Every row is a whole 512s unit, so these are exact
timelock parameters rather than rounded display values.

#### The value to set

```
ARK_UNILATERAL_EXIT_DELAY=260096
```

One BIP68 unit **above** the observed floor, and deliberately neither extreme:

| value  | units | delta       | left for route hops | margin over floor |
| ------ | ----- | ----------- | ------------------- | ----------------- |
| 259584 | 507   | 1770 blocks | 246 blocks          | none              |
| 260096 | 508   | 1774 blocks | 242 blocks          | one unit          |
| 296448 | 579   | 2016 blocks | none                | 10.2 h            |

- **Not the floor exactly.** 259584 is precise, not rounded, so it should be
  accepted — but a check written `>` rather than `>=` would reject it, and that
  failure strands money at spend. One unit costs four blocks and removes the
  question.
- **Not the cliff.** `MAX_FINAL_CLTV_BLOCKS` is LND's `max_cltv_expiry`, which
  bounds the WHOLE route's timelock rather than the final hop alone. A 2016-block
  final delta leaves nothing for the hops in front of it and simply will not
  route. What matters is the budget left over, and 242 blocks is a usable one.

The two failure modes are not symmetric, which is what places the value near the
bottom of the range without sitting on it: too low can strand funds in a script
arkd will not let us spend, while too high only means the invoice does not route
and the hold lapses with nothing at risk.

**One assumption remains open**: that arkd validates covenant CSV leaves against
"Unilateral exit" and not "Public unilateral exit". The naming fits — all three
of our leaves are "spend this vtxo alone after a delay" — and the advertised
field matching the _public_ row exactly is strong corroboration. It is still
inference from a dashboard rather than from arkd's validation code, so confirm
the server accepts the script with one 500-sat swap before pointing volume at it,
and remember the override moves the SEND corridors' scripts too. If a spend is
rejected, step up one unit at a time; there are 71 units of room below the cliff.

Be precise about what that swap proves, because it is less than it looks. A
collaborative claim or refund exercises script construction and the server's
willingness to co-sign a vtxo built at the override's delay — which is the thing
that would fail if the value is under arkd's real floor, so it IS the test worth
running. It does not exercise the CSV leaves themselves: those are reachable only
through a unilateral exit, which nothing in `src/` performs
(`TODO(unilateral-exit)`). A green swap therefore says the delay is accepted, not
that the recourse it encodes has ever been executed.

This is the better outcome by a distance, and it carries its own hazard, which
is not symmetric with the one it removes:

- **Too high is wasteful. Too low loses money.** The server accepts any script
  at or above its minimum, so an over-long delay costs only recourse latency. An
  under-short one writes a script the server **rejects at spend, not at
  funding** — `INVALID_VTXO_SCRIPT: exit delay is too short` arrives when there
  is already money in it.
- **It changes every covenant, on all four corridors**, not just Lightning
  receive. The send legs work on mainnet today; this moves their scripts too.
- **Nothing here can check it.** The value being overridden is the only thing
  the server tells us, so there is no truthful comparison available. It is an
  operator assertion, and the only validation is empirical — see above for what
  a small swap does and does not prove.
- **In-flight swaps are safe either way.** Each corridor snapshots its delays
  onto the row at quote time and reconstructs funded scripts from the snapshot,
  so changing this moves new swaps only.

On any other deployment, get the number from whoever runs the server rather than
from an approximation — the margin is thinner than it sounds. A 3.0-day delay
leaves 246 blocks of headroom, 3.4 days leaves 17, and 3.44 is over the cliff.

**Otherwise, accept the window.** `LN_RECEIVE_ACCEPT_UNILATERAL_GAP=true` is the second way the corridor runs. It
drops gate (d) and nothing else: the binding bound falls back to the
collaborative refund deadline, 8100s or **54 blocks**, which routes without
comment. Gates (a)–(c) still refuse an expired invoice, an unarmed htlc, a
settle window too little to use, and a committed refund deadline past `E`.

What you accept, plainly: with the Arkade server **gone or censoring for longer
than its exit delay** AND `E` already passed, a trader can let the htlc fail back
to its payer at no cost and only then claim the Arkade payout unilaterally —
both sides, one preimage (#69). It is bounded by `LN_RECEIVE_MAX_SATS` per swap
and `MAX_EXPOSED_SATS` in aggregate, which is why `bitcoin` refuses to accept the
window unless you have set the former by hand.

**That co-requirement is `bitcoin`-only.** `regtest`, `signet` and `mutinynet`
accept the window with no cap set, and the reason is that demanding the ceremony
where nothing is at risk only teaches people to perform it. The exposure on those
networks is still bounded — by whatever `LN_RECEIVE_MAX_SATS` or the network
profile's own limit already says — but nothing prompts you to choose the number.
Worth knowing before running a signet or mutinynet deployment against
real-value assets, where the default cap is the only thing standing behind the
window and nobody was asked to look at it.

Two things make it a trade rather than a hole. The solver cannot execute that
recourse today anyway (`TODO(unilateral-exit)`), so the window gate (d) reserves
protects an action nothing in `src/` can take. And a same-sized loss on the other
side is already accepted and documented in `packages/solver-arkade/src/arkade/covenant.ts`: with no
unilateral-claim implementation, a censoring server after payment costs the
CLIENT their claim, for exactly the same missing work. Gate (d) was guarding one
leak in a hull with an acknowledged hole of the same size.

The honest summary is that this corridor trusts mainnet arkd not to censor for
as long as its exit delay. Prefer the shorter delay above where the real number
is known — it removes the exposure rather than accepting it — and turn this knob
back off once `ARK_UNILATERAL_EXIT_DELAY` puts the deployment under the cliff.

Two more worth knowing before wiring a deployment:

- **A backend with no final-CLTV parameter on hold invoices cannot serve this
  corridor.** Without one, `createHoldInvoice` throws rather than mint an
  invoice whose `E` silently fails the bound. LND supports it via `cltv_delta`.
- **The recourse is reserved but not yet executable.** `TODO(unilateral-exit)`
  in `packages/solver-arkade/src/arkade/covenant.ts`: the leaf exists in the script and nothing in
  `src/` spends it. The gate keeps the window open; running the exit inside it
  still needs the on-chain unroll flow.

## Self-payment refresh, and what it does to hold invoices

A client may quote `lightning:BTC->arkade:BTC` and then `arkade:BTC->lightning:BTC`
against the bolt11 it was just handed — refreshing Arkade funds through this
solver. The two swaps are recognised as a coupled pair and settled entirely on
Arkade; no Lightning payment happens, because one node cannot pay its own
invoice. Both Lightning corridors must be enabled or the flow is simply refused
as before.

Two operational consequences worth knowing before reading logs:

- **The hold invoice is CANCELLED, not settled**, the moment the coupling is
  recognised. That is deliberate: the bolt11 is ours, anyone can pay a bolt11,
  and a client could otherwise hand it to a third party — leaving us settling
  an htlc AND claiming their lockup off one preimage. A coupled swap therefore
  ends with a cancelled invoice and a `settled` receive row, which is success,
  not a failure to collect.
- **Under LND that cancel can land on an ARMED htlc.** The caller checks
  `getHoldState` first, but the check and the cancel are not atomic: a third
  party who pays in the gap has their htlc failed back immediately rather than
  at `E`. The window is one polling tick. A backend that exposes no cancel at
  all degrades to leaving the invoice to lapse instead. Neither case risks
  solver funds; both are worth recognising in a support conversation.

## Publishing the registry card

Clients discover this solver through
[arkade-os/solver-registry](https://github.com/arkade-os/solver-registry) —
a per-network directory of signed solver cards. The card for THIS deployment
comes from the deployment itself, so the listing can never drift from the
enforced config:

```
cli card <name> > <registry-checkout>/solvers/<network>/<name>.json
```

The card advertises one corridor market (`BTC/lightning:BTC`, quote side
bounded by the live limits: the network profile's minimum
(`packages/solver-core/src/core/networks.ts`, not env-overridable) and the `MAX_SWAP_SATS` cap),
lists `RELAY_URL` (plus any comma-separated `SOLVER_CARD_RELAYS`) as the RFQ
rendezvous, and is BIP340-signed by the wallet identity — the same x-only key
clients already address relay traffic to, which the registry requires for
corridor cards.
Open the file as a PR against the registry; its CI re-validates everything,
including the signature. Regenerate and re-PR after any limits, relay, or
key change — the old card keeps quoting stale bounds until replaced.
(Generated here rather than by `solverd` because its card RPC predates
corridors: arkade-os/solver-registry#13.)

Two gotchas:

- **Submit only after solver-registry PR #12 has merged** — that PR adds
  corridor-market support to the registry's schema and validator; the
  pre-corridor `main` rejects every corridor field this card carries.
- **`RELAY_URL` must be `wss://` to generate a card**, even where the
  service itself tolerates a plaintext `ws://` relay locally (regtest):
  the registry only accepts TLS relay URLs, so `cli card` refuses them
  up front rather than emitting a card CI would bounce.

## Why the stack needs those overrides

A bare `node regtest.mjs start` brings up a stack this service **cannot use at
all**. Four separate floors have to be cleared at once, and three of them fail
late and confusingly rather than at startup, so they are easy to rediscover the
hard way. The numbers below are the smallest legal values, not arbitrary ones.

- **Everything must be denominated in SECONDS, not blocks.** Upstream flipped
  the stack's defaults to block counts. `deriveUnilateralDelays`
  (`packages/solver-core/src/core/timelocks.ts:63`) hard-rejects anything below
  `SEQUENCE_GRANULARITY_SECONDS` (512) as "a block count, not seconds", so the
  service dies at wallet construction — before any swap runs.
- **`ARKD_CHECKPOINT_EXIT_DELAY=1536`, NOT 1200.** BIP68 encodes relative
  timelocks in 512-second units, so 1200s is representable only as
  `floor(1200/512) = 2` units = **1024s**, which is under the SDK's own regtest
  floor (`REGTEST_MIN_CHECKPOINT_EXIT_DELAY_SECONDS = 1200`, pinned SDK
  `dist/chunk-DVOQZAAX.js:2352`). 1536 = 3x512 is the smallest multiple of the
  granularity that clears it.
  **On any non-regtest network that floor is `DEFAULT_MIN_CHECKPOINT_EXIT_DELAY_SECONDS`
  = 86400 (24h)** (same file, line 2351) and `Wallet.create` throws outright
  below it — worth knowing before this configuration is copied toward mainnet.
- **`ARKD_VTXO_TREE_EXPIRY=6144.`** There is a SECOND, independent floor —
  `REGTEST_MIN_BATCH_EXPIRY_SECONDS = 6000` (same file, line 2336) — and it is
  checked at **settle**, not at startup. A smaller value (1024, say) therefore
  brings the stack up perfectly happily and only fails once funds are actually
  settled. Non-regtest equivalent: `DEFAULT_MIN_BATCH_EXPIRY_SECONDS = 86400`
  (line 2335).
- **`COVCLAIMD_IMAGE` must be set explicitly.** `regtest.mjs` silently drops
  covclaimd from the stack when it is unset — no error, the container simply is
  not there.

Three more things that cost time if forgotten:

- **The e2e suite uses a DIFFERENT wallet from the `cli` walkthroughs.** It
  defaults to `E2E_ENV_FILE=.env.regtest.lnd`, whose `ARK_DB_PATH` is
  `.data/ark-regtest-lnd.sqlite` — not `.env.regtest`'s. Funding one does not
  fund the other.
- **A stack rebuild regenerates boltz-lnd's TLS cert and macaroon.** The
  repo-root copies must be re-extracted with the two `docker cp` lines in the
  LND walkthrough below, or both onchain corridors fail in `beforeAll` with
  `14 UNAVAILABLE ... self-signed certificate in certificate chain`.
- **Settle the Arkade wallet before `pnpm test:e2e`.** Unsettled
  (`preconfirmed`) balance makes the per-fork startup balance check racy: it can
  read 0 spendable and fail an unrelated corridor with
  `VTXO_ALREADY_REGISTERED` or "needs 5000". `scripts/regtest-settle.mjs`
  settles without re-funding.
- **The EVM e2e files need two things arkade-regtest does not provide:** an
  anvil container and a flat price feed on `:8088`. Both are started (and the
  container removed) by `node scripts/e2e-stack.mjs`; without them the EVM
  files skip rather than fail, which is why a missing feed can look like
  "e2e passes" on a machine that never ran them.

## Replicating end to end on regtest

Everything above runs against [arkade-regtest](https://github.com/arklabsHQ/arkade-regtest)
with NO Lightning network: `LN_BACKEND=fake` swaps the Lightning vendor for a
file-backed fake that FORGES its own BOLT11 invoices (real, decodable, with
preimages it chose) and "pays" them by revealing the preimage. Everything
Arkade-side — funding, the covenant script, the claim co-signed by arkd, the
refund co-signed by the emulator — is real.

```bash
# 1. the stack (arkd :7070, emulator :7073, bitcoin, miner, esplora :3000)
#    NOTE the environment overrides — a bare `node regtest.mjs start` produces a
#    stack this service cannot use at all. See "Why the stack needs those
#    overrides" below before changing any of these numbers.
git clone https://github.com/arklabsHQ/arkade-regtest && cd arkade-regtest
ARKD_VTXO_TREE_EXPIRY=6144 ARKD_UNILATERAL_EXIT_DELAY=512 \
ARKD_PUBLIC_UNILATERAL_EXIT_DELAY=512 ARKD_BOARDING_EXIT_DELAY=2048 \
ARKD_CHECKPOINT_EXIT_DELAY=1536 \
COVCLAIMD_IMAGE=ghcr.io/arkade-os/covclaimd:v0.0.1-rc.4 \
node regtest.mjs start --clean

# 2. this repo
cp .env.regtest.example .env.regtest       # fill ARK_MNEMONIC with any bip39 phrase
pnpm install && pnpm build

# 3. fund the provider's Arkade wallet (boarding -> faucet -> settle)
node --experimental-eventsource --env-file=.env.regtest scripts/regtest-fund.mjs ../arkade-regtest

# 4. full send E2E: forged invoice -> quote -> fund own derivation -> claim
cli() { node --experimental-eventsource --env-file=.env.regtest dist/cli.js "$@"; }
cli invoice 1000 | tail -1 | xargs -I{} sh -c 'cli send "{}"'

# 5. covenant refund E2E against the local emulator
cli test-refund 1000

# 6. the purely-outbound flow over the mock relay
node scripts/mock-relay.mjs &                                # dev broker, :7447
RELAY_PROTOCOL=dev RELAY_URL=ws://localhost:7447 cli relay & # provider, no ports (mock relay speaks the dev framing)
node scripts/relay-client.mjs <providerPubkey> <bolt11> <refundAddress>
```

Notes from a real run of the above (all four legs green):

- The stack's bitcoind may need its wallet loaded after a restart:
  `docker exec bitcoin bitcoin-cli -regtest -rpcuser=admin1 -rpcpassword=123 loadwallet default`.
- The SDK wallet reads the chain through esplora at `http://localhost:3000/api`
  (the stack's mempool web proxy). If `settle` reports "No inputs", the indexer
  is a block behind the faucet — re-run the fund script.
- `test-refund` matures immediately on regtest: fresh blocks carry fresh
  timestamps, so the 3h-past locktime is already behind the tip's blocktime.
- The fake backend refuses invoices it did not forge (terminal 'failed'), so
  the failure path is exercised too — feed it any real-world bcrt invoice.

## Replicating end to end on regtest, with a real Lightning backend (LND)

The `LN_BACKEND=fake` walkthrough above never sends a real Lightning payment
— it forges and self-settles invoices, so it needs no Lightning node at all and
never touches arkade-regtest's own LND nodes.

`LN_BACKEND=lnd` removes that limitation: arkade-regtest's `boltz` profile
brings up its own `boltz-lnd` node, already funded on-chain and channeled to
a second counterparty `lnd` node by the stack's own setup (`lib/setup/boltz.mjs`
funds it, opens the channel, mines confirmations, and balances it — nothing
extra is needed from this repo). Point this service's LND backend at
`boltz-lnd`, and `cli send` moves a real HTLC across that channel.

```bash
# 1. the stack, including the boltz profile (full `start` brings up everything)
#    Same overrides as the fake walkthrough — see "Why the stack needs those
#    overrides". A bare `start` brings up a stack this service cannot use.
git clone https://github.com/arklabsHQ/arkade-regtest && cd arkade-regtest
ARKD_VTXO_TREE_EXPIRY=6144 ARKD_UNILATERAL_EXIT_DELAY=512 \
ARKD_PUBLIC_UNILATERAL_EXIT_DELAY=512 ARKD_BOARDING_EXIT_DELAY=2048 \
ARKD_CHECKPOINT_EXIT_DELAY=1536 \
COVCLAIMD_IMAGE=ghcr.io/arkade-os/covclaimd:v0.0.1-rc.4 \
node regtest.mjs start --clean

# 2. extract boltz-lnd's TLS cert and macaroon
docker cp boltz-lnd:/root/.lnd/tls.cert ../lightning-swap-service/boltz-lnd-tls.cert
docker cp boltz-lnd:/root/.lnd/data/chain/bitcoin/regtest/admin.macaroon ../lightning-swap-service/boltz-lnd-admin.macaroon

# 3. this repo
cd ../lightning-swap-service
cp .env.regtest.lnd.example .env.regtest.lnd    # fill ARK_MNEMONIC with any bip39 phrase
pnpm install && pnpm build

# 4. fund the provider's Arkade wallet (boarding -> faucet -> settle), same as the fake walkthrough
node --experimental-eventsource --env-file=.env.regtest.lnd scripts/regtest-fund.mjs ../arkade-regtest

# 5. sanity-check the LND connection
cli() { node --experimental-eventsource --env-file=.env.regtest.lnd dist/cli.js "$@"; }
cli balances

# 6. full send E2E: a REAL invoice from the counterparty lnd -> quote -> fund own derivation -> pay over the boltz-lnd<->lnd channel -> claim
cd ../arkade-regtest
INVOICE=$(node regtest.mjs create-invoice --secondary)
cd ../lightning-swap-service
cli send "$INVOICE"
```

`cli send` prints a `terminal:` line with the swap's final row; a successful
run shows `"state":"claimed"` and exits 0 (exit code 2 means it did not
reach `claimed` — the same convention the fake-backend walkthrough uses).

## Replicating end to end on regtest, onchain leg (`arkade:BTC->onchain:BTC`)

Reuses the SAME LND setup as the section above — `OnchainSendBackend`
selection follows `LN_BACKEND` exactly (no separate onchain config knob), so
pointing this service at `boltz-lnd` already gives it a real onchain wallet
(`sendToChainAddress`, `getChainTransactions`, `broadcastChainTransaction` —
`packages/solver-rails-lnd/src/onchain/lnd/adapter.ts`) with no additional setup beyond steps 1-5 above.

```bash
# steps 1-5 as above (stack + boltz profile, cert/macaroon extraction, fund
# the Arkade wallet, sanity-check the LND connection)

# 6. full onchain-send E2E, both roles in one process (src/cli.ts's
#    send-onchain command): quote -> fund the Arkade lockup from our own
#    wallet -> observe the solver fund the onchain HTLC via boltz-lnd's
#    onchain wallet -> sign and broadcast the CLIENT's claim transaction with
#    an ephemeral keypair generated for the self-test -> drive to claimed.
cli send-onchain 50000
```

`cli send-onchain` prints the same `terminal:` convention as `cli send` — a
successful run shows `"state":"claimed"` and exits 0. Unlike the Lightning
leg, this self-test exercises client-side logic too (script derivation,
address verification, claim-transaction signing) that in a real integration
lives in a SEPARATE client package (`arkade-os/ts-sdk`'s `@arkade-os/swap`,
`onchainHtlcScript`/`buildHtlcClaim`) — this CLI command is a reference
implementation of that logic for reproducibility, not this service's own
operational code path; the solver's own responsibility ends at funding the
onchain HTLC and observing the claim, exactly as `packages/solver-corridors/src/send/onchainOrchestrator.ts`
implements it.

**Status**: the MONEY PATH is now proven end to end against a live
`arkade-regtest` + `boltz-lnd` stack — quote, Arkade lockup funding, the
solver's onchain HTLC funding, the client's claim broadcast, the solver
reading `P` back out of that claim witness, and the Arkade-side claim — by
`test/e2e/sendOnchain.e2e.test.ts` (see "Corridor e2e suite" below). That
test drives the same `OnchainSendSwapService` this command drives.

What is still unrun is `cli send-onchain` ITSELF: the e2e builds the client's
claim transaction through `packages/solver-rails/src/onchain/claim.ts`, whereas this command
assembles that one transaction inline. Every other step is shared code that
has now run for real, so the residual risk is confined to that inline
assembly.

### Exercising the solver's own refund-on-timeout

Same stack, no new infrastructure. `whenAwaitingClaim`
(`packages/solver-corridors/src/send/onchainOrchestrator.ts`) refunds the solver's own onchain HTLC
once `htlc_locktime` passes with no client claim — to trigger it manually:
run `cli send-onchain` far enough to reach `awaiting_claim` but skip (or
kill before) the self-test's own claim step, then mine blocks past
`htlc_locktime` (`regtest-fund.mjs`-style block generation against the
local `bitcoind`) and run `cli drive <id>` — the row should move
`awaiting_claim -> refunding_onchain -> refunded`, with `onchainRefundTxid`
set. Signing goes through the same `ArkadeContext.identity` the Arkade-side
claim/refund paths already use — no separate key material to provision.

## Corridor e2e suite (`test/e2e`)

The walkthroughs above, as code, for all four corridors. Same stack, same env
files, but asserting on the swap ROW rather than on grepped stdout — and
covering the two RECEIVE corridors, which have no CLI command and no RFQ
ingress routing to shell out to. For those the test constructs
`ReceiveSwapService` / `OnchainReceiveSwapService` against real adapters and
drives `quote`/`tick` directly, which is what `src/cli.ts`'s self-tests do
internally anyway.

```bash
# steps 1-5 of the LND walkthrough above (stack + boltz profile, cert/macaroon
# extraction, fund AND SETTLE the Arkade wallet), then:
pnpm test:e2e
```

**These never run in CI.** `pnpm test` is `vitest run --exclude test/e2e`, so
the unit suite is unaffected by anything here; `pnpm test:e2e` is the only way
to run them, and it is meant to be typed deliberately by someone who has just
brought a stack up.

| File                           | Corridor                    | Needs                                        |
| ------------------------------ | --------------------------- | -------------------------------------------- |
| `sendLightning.e2e.test.ts`    | `arkade:BTC->lightning:BTC` | arkd, emulator                               |
| `sendOnchain.e2e.test.ts`      | `arkade:BTC->onchain:BTC`   | arkd, emulator, LND, esplora                 |
| `receiveLightning.e2e.test.ts` | `lightning:BTC->arkade:BTC` | arkd, emulator                               |
| `receiveOnchain.e2e.test.ts`   | `onchain:BTC->arkade:BTC`   | arkd, emulator, LND, esplora, a MINING miner |

No covclaimd is required by any of them: on both receive corridors the CLIENT
claims the Arkade lockup itself, through the covenant's collaborative claim
leaf. covclaimd stays supported and optional (`ReceiveServiceDeps.covclaimd`); it
CAN claim this covenant as of `v0.0.1-rc.4`, which `covclaimdClaim.e2e.test.ts`
covers separately — see "covclaimd" below.

- **Environment** comes from `E2E_ENV_FILE` (default `.env.regtest.lnd`, the
  superset carrying both the Arkade wallet and the LND credentials), loaded by
  `test/e2e/support/preflight.ts` so `pnpm test:e2e` stays one command.
  Anything already exported wins, so a one-off override still works.
  `COVCLAIMD_URL` (default `http://localhost:7271`) and `ESPLORA_URL` (default
  `http://localhost:3000/api`) are e2e-only knobs — no `src/config.ts` setting
  exists for covclaimd yet, because the receive legs are not wired into the CLI.
- **A missing dependency FAILS, it never skips.** A suite that runs this rarely
  and skips quietly is a suite that rots into one that cannot pass at all. The
  preflight probes every dependency and prints the whole stack as a table,
  marking which one the corridor actually needed. An unfunded Arkade wallet
  fails the same way, with the `regtest-fund.mjs` line to fix it — worth
  knowing that a regtest wallet drifts into `recoverable` (NOT spendable) on
  its own, which reads as a healthy non-zero balance until a send fails.
- **The Lightning corridors use the file-backed fake backend**, both
  directions, because each needs the COUNTERPARTY driven from inside the test —
  an invoice we can actually pay (send), and an incoming HTLC armed against a
  client-chosen hash (receive, `FakeLightningBackend.armHold`) — and
  arkade-regtest exposes no scriptable Lightning payer to this repo. The
  onchain corridors use the REAL LND wallet, because there the counterparty's
  action (funding an address, broadcasting a claim) is scriptable from here.
  Everything Arkade-side is real in all four.
- **Swap stores go to a temp directory**, never the configured `SWAP_DB_PATH`,
  so a run leaves no rows in an operator's own database. The Arkade wallet
  database (`ARK_DB_PATH`) is used as configured — it is the wallet.
- **The receive corridors are the highest-value tests here.** They are the only
  place the solver learns `P` by reading it back out of a real covclaimd claim
  (`findClaimPreimage`), which rests on Ark's `ConditionWitness` PSBT field
  surviving a `toPSBT()`/`fromPSBT()` round trip at the pinned SDK version —
  covered nowhere else except by synthetic PSBT fixtures.
- **The client's ECIES claim packet** (`test/e2e/support/claimPacket.ts`) is
  the one piece of CLIENT code with no counterpart in `src/`, and deliberately
  so: the solver must not be able to decrypt it. It is transcribed from
  `docs/environment.md` § "covclaimd wire protocol" and is the most likely
  thing to be wrong on a first covclaimd run; a bad packet shows up as a
  non-2xx from `reveal()` or a claim that never lands, and the fix is confined
  to that file.

### covclaimd

Optional, and still unwired here — but the reason has an expiry date on it now,
so read the version before repeating the old conclusion.

**What was observed (regtest, 2026-08-07).** Against a live
`ghcr.io/arkade-os/covclaimd:v0.0.1-rc.1`, `POST /v1/reveal` returned **200**
for a correctly-sealed packet against our `ScriptV2` taptree — and then no
claim was ever pushed: the lockup was still unspent minutes later, with nothing
in the container's logs. Silent, not a rejection, which is what made it
untrustworthy rather than merely broken.

**What that turned out to be.** Two independent defects, both since fixed
upstream, neither present in the release the commands above now pin:

- covclaimd builds exactly one leaf of our taptree — `nonInteractiveClaim` —
  and matches it by closure. Its condition script was the v1 form
  (`HASH160 <h> EQUAL`) while `ScriptV2` uses
  `SIZE 32 EQUALVERIFY HASH160 <h> EQUAL`, so the closure never matched. Fixed
  in `fc22a73` ("harden condition closure"), shipped in **`v0.0.1-rc.3`**,
  which is v2-only — it no longer accepts the v1 condition at all.
- A separate taptree-binding fix landed in `v0.0.1-rc.2`. `rc.1` predates both.

The Go leaf in `rc.3` has been checked byte-for-byte against the TypeScript
`VHTLC.ScriptV2` `nonInteractiveClaim` script, and a real eight-leaf v2 taptree
drives correctly through covclaimd's own closure-matching path. Note that
covclaimd's own e2e only ever builds a ONE-leaf taptree, so that path had no
upstream coverage.

**Still eight-leaf only.** The `nonInteractiveClaim` leaf script itself is
unaffected by the (opt-in) timelocked non-interactive refund leaf — it is a
different leaf entirely — but the MERKLE PATH covclaimd has to construct
changes shape with a ninth leaf in the tree, and that has not been separately
verified. An operator running covclaimd against a lockup that also carries
the timelocked non-interactive refund leaf is on unverified ground until this
note says otherwise.

**Required operator action: leave covclaimd unwired.** There is no safe middle
setting to pick here. `createServices` leaves `covclaimd` unset on purpose
(`src/cli.ts:444`), and every quote path now writes
`nonInteractiveParameters: true` unconditionally — all six `insertQuote` call
sites, with no config gate and no per-swap opt-out — so wiring covclaimd would
put it against a nine-leaf tree on EVERY newly funded lockup, not on some
unlucky subset. The failure would not announce itself at signing time: the
control block gets built from a merkle path that no longer matches, and the
witness is rejected only once the spend reaches the chain. Nothing in this repo
gates that either — `assertScriptMatchesRow` guards the solver's own
derivation, not covclaimd's independent service.

Leaving it unwired costs nothing, which is why it was already unset before this
leaf existed: no corridor requires covclaimd (above — on both receive corridors
the CLIENT claims its own lockup through the collaborative claim leaf). Rows
quoted before the leaf shipped keep the eight-leaf shape and stay claimable, so
it is only newly funded lockups that move out of covclaimd's reach.

**What has now been shown (regtest, 2026-08-12).** `v0.0.1-rc.4` claims a
solver-built lockup end to end, with the client offline. That is
`test/e2e/covclaimdClaim.e2e.test.ts`: the solver funds, reveals, and then
nobody in the test claims — the preimage never leaves the test process — and the
lockup is spent anyway, with the solver recovering `P` off that witness and
settling a real held HTLC with it.

Attributing the claim to covclaimd needed a control, because **the daemon logs
nothing for request handling** — even a rejected `POST /v1/reveal` leaves no
line — so a silent log proves nothing either way. The control: seal the packet
to a key covclaimd does not hold and change nothing else. It then fails the
reveal outright (`400 ... aead open: cipher: message authentication failed`) and
the swap never reaches `funded`. So the daemon really is opening the packet, and
the spend really is its own.

Two things worth knowing before wiring it in anger. covclaimd builds the CEL
subscription filter correctly — it contains the committed pubkey TLV,
`hasPacket(tx.extension, 4) && tx.extension[4].contains('030021<pubkey>')` — but
on this stack it logs `no arkd subscription client is configured; falling back
to the unfiltered tx stream`, so the selectivity is not actually active. And the
fallback below remains a legitimate deployment choice, not a workaround.

The fallback is simply that the CLIENT claims, the way `boltz-swap` does.
Nothing in the solver's watch path changes: `whenFunded` / `whenAwaitingClaim`
observe a spend and recover `P` through `findClaimPreimage` regardless of who
spent it. Configuring a covclaimd re-enables the reveal; leaving it unset means
the solver waits for the client, which costs only the client's need to be
online.

The client's ECIES sealing is in `test/e2e/support/claimPacket.ts`. The one
detail the wire docs underdetermine: **the ECDH shared secret is the 32-byte X
coordinate**, not the 33-byte compressed point (RFC 5903 §9, which is what
covclaimd's Go `ecdhX()` implements). `@noble/curves` returns the compressed
point by default, so the natural transcription derives a well-formed but wrong
key and fails only at covclaimd's AEAD tag check.

### What has actually been run

Green against a live `arkade-regtest` + `boltz-lnd` stack on 2026-08-07:

- `sendLightning` — full corridor.
- `sendOnchain` — full corridor.
- `receiveLightning` — BOTH tests: the happy path (the client claims, the
  solver reads `P` back out of that real claim witness) and the refund path
  (the solver's own capital back through the emulator-co-signed covenant).
  The happy path is what finally proves the `ConditionWitness`
  `toPSBT()`/`fromPSBT()` round trip against a live Arkade node.

Still failing, for a reason outside the test: `receiveOnchain`. The solver
never adopts the client's HTLC funding, because `packages/solver-rails-lnd/src/onchain/lnd/adapter.ts`'s
`outputsForAddress` reports the transaction's `tokens` (amount + fee) as an
output's `valueSats`, and behind that only sees the LND wallet's own
transactions. Both are documented at that function; the corridor goes green
once the adapter grows a per-output, any-address chain view.

Three things worth knowing before a run:

- **Settle first.** A run leaves part of the balance `preconfirmed`, and the
  next run's per-fork startup balance check then races it — reading 0 spendable
  and failing a corridor that has nothing wrong with it (seen as
  `VTXO_ALREADY_REGISTERED`, or "Arkade wallet has 0 spendable sats"). Settling
  first makes the suite reproducible:

  ```bash
  node --experimental-eventsource --env-file=.env.regtest.lnd scripts/regtest-settle.mjs
  pnpm test:e2e
  ```

  `regtest-settle.mjs` only settles — use `regtest-fund.mjs` when the wallet
  actually needs topping up.

- **The Arkade wallet drifts unspendable.** vtxos age out of `available` into
  `recoverable`, which still reads as a healthy non-zero total. Settle it back —
  `regtest-settle.mjs` recovers what is already there, and is what you want
  unless the wallet is genuinely empty:

  ```bash
  node --experimental-eventsource --env-file=.env.regtest.lnd scripts/regtest-settle.mjs
  ```

  Reaching for `regtest-fund.mjs` here tops the wallet up with fresh sats while
  the existing balance stays stranded, which papers over the state instead of
  clearing it. Observed on a stack idle overnight: `available: 0 /
recoverable: 235696`, settled back to `available: 233338` (the 2358-sat
  difference is the operator's 1% intent fee).

- **arkade-regtest's miner can be up but not mining.** Only `receiveOnchain`
  cares, and it names the miner rather than just timing out.
- **Renewal pays an intent fee, and the SDK's own `renewVtxos` does not.**
  arkade-regtest configures `ARK_OFFCHAIN_INPUT_FEE="amount * 0.01"` by default
  (`.env.defaults`), so every settlement costs 1% of each input. The SDK's
  `IVtxoManager.renewVtxos` asks for an output equal to the gross input sum, so
  the fee it implies is zero and arkd rejects the intent outright with
  `INTENT_INSUFFICIENT_FEE (31): got 0 min expected N` — the float is never
  renewed. `packages/solver-arkade/src/arkade/vtxoLifecycle.ts`'s `renewExpiringVtxos` replaces it and
  prices the output the way `Wallet.settle()` already does. This is operator
  policy, not a regtest quirk: any mainnet operator charging a non-zero intent
  fee breaks `renewVtxos` the same way. `IVtxoManager.recoverVtxos` still has
  the defect — see that module's header.

## Load test (`test/perf`)

A hundred independent client wallets swapping through one solver, on all four
corridors at once, against the same regtest stack the e2e suite uses. Where the
corridor e2e tests answer "does this work", this answers "how fast, how many at
once, and where does the time actually go".

```bash
pnpm test:perf                                   # 40 ln-send / 40 ln-receive / 10+10 onchain
PERF_LN_SEND=2 PERF_LN_RECEIVE=2 \
  PERF_ONCHAIN_SEND=0 PERF_ONCHAIN_RECEIVE=0 \
  pnpm test:perf                                 # a ~25s smoke run
PERF_CONCURRENCY=10 pnpm test:perf               # same workload, throttled
```

Every count, the amounts, the poll interval and the timeouts are env knobs; see
the constants at the top of `swapThroughput.perf.ts`. The fleet's wallets live
in `.benchdata/` and their mnemonics are derived from a fixed label, so a second
run reopens the same hundred wallets and tops up the difference rather than
stranding dust. The run sweeps the fleet back to the funder at the end.

### What it measured (2026-08-11, regtest, one machine)

100 swaps, **100 succeeded, 0 failed**, all launched at once: **209.1s wall**,
so **0.48 swaps/sec**, or **2091ms of wall clock per swap** sustained.

Per-swap LATENCY is a different number from that throughput, and the gap is the
whole result. The Lightning send corridor, against the same stack:

| phase             | n=4       | n=100       | factor   |
| ----------------- | --------- | ----------- | -------- |
| `quote`           | 57ms      | 930ms       | 16x      |
| `client_fund`     | 185ms     | 3294ms      | 18x      |
| `indexer_visible` | 20ms      | 3657ms      | **183x** |
| `solver_deliver`  | 530ms     | 6197ms      | 12x      |
| **TOTAL**         | **848ms** | **14032ms** | **17x**  |

Read that carefully before optimising anything:

- **Nothing failed and nothing was refused.** There is no admission ceiling at a
  hundred concurrent swaps; the stack queues rather than sheds. That is the
  robustness result, and it is the one worth keeping.
- **Sub-2s is already true of throughput and false of latency.** 2091ms of wall
  clock per swap at saturation is essentially the target; a single swap taking
  14s while 99 others are in flight is not the same claim, and quoting either
  number alone misleads.
- **The indexer number above is workload-specific, not a general result.**
  `indexer_visible` reaches 3657ms in the mixed hundred-swap run but stays at
  694ms with Lightning sends alone at concurrency 20 (sweep below). Its blowup
  belongs to the mixed workload — the onchain legs driving the chain — rather
  than to concurrency, and reading it as "the indexer is the bottleneck" would
  be reading one workload as a law.
- The receive corridors are dominated by `solver_arm_and_fund` (90.7s median at
  n=100) and the onchain legs by real chain confirmation. Those are batch-round
  and block waits, not request handling.

Medians and p95 come from real samples by nearest rank, so every figure above is
a value some swap actually took. Every `solver_*` figure carries up to one poll
interval (250ms default) of quantisation.

### Where 2s actually breaks

Same twenty Lightning sends at three concurrencies, so concurrency is the only
variable:

| concurrency | wall  | TOTAL median | `solver_deliver` | `indexer_visible` |
| ----------- | ----- | ------------ | ---------------- | ----------------- |
| 5           | 25.4s | 5340ms       | 1975ms           | 129ms             |
| 10          | 23.7s | 7856ms       | 5106ms           | 216ms             |
| 20          | 11.1s | 9664ms       | 7235ms           | 694ms             |

- **Sub-2s does not survive past a handful of swaps.** 848ms at four total
  swaps; 5340ms at twenty even throttled to five at a time. That is TOTAL
  VOLUME rather than concurrency alone — the fifth swap of twenty is slower
  than the fifth swap of four.
- **`solver_deliver` is what scales with concurrency**, 1975ms to 7235ms. That
  is the solver actually paying the invoice, and it is the number to attack if
  per-swap latency matters.
- **Wall clock improves as latency worsens** (25.4s to 11.1s): the throughput
  and latency trade, and the reason no single per-swap number answers "is it
  fast enough".

Read medians per row, not across: median(TOTAL) is not the sum of the phase
medians, because they come from different swaps.
