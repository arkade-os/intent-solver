# intent-solver

Swap provider ("solver") between Arkade and Lightning, onchain BTC and ERC20
tokens — and the LND reference implementation of the corridor framework.

MIT licensed — see [LICENSE](LICENSE).

Four BTC corridors ship built in, two per direction:

- **`arkade:BTC->lightning:BTC`** (send) — the user pays a Lightning invoice out
  of an Arkade balance. **Working.** Proven end-to-end on `bitcoin` (real sats:
  funding, claim, and the non-interactive covenant refund) and replicable on
  regtest in minutes with no Lightning network at all.
- **`arkade:BTC->onchain:BTC`** (send) — the user is paid onchain out of an
  Arkade balance. **Working**, proven on regtest including the solver's own
  HTLC refund on timeout.
- **`lightning:BTC->arkade:BTC`** (receive) — the user is paid over Lightning
  and the sats land on Arkade. **Working on regtest**, happy path and edges.
- **`onchain:BTC->arkade:BTC`** (receive) — the user pays onchain and the sats
  land on Arkade. **Working on regtest**, same.

Two more appear per token named by `EVM_TOKENS` —
**`arkade:BTC->ethereum:<token>`** and its reverse, on any EVM chain, off unless
that variable is set. A corridor exists per TOKEN rather than once per family,
and every chain fact is configuration rather than something compiled in, so a
custom network needs no code. Their settings are their own block in
[§ Settings and defaults](#settings-and-defaults) below.

All of them are quoted through RFQ v1 and driven by the same `watch` loop. The
receive legs fund a lockup out of the solver's own float, which is why
`packages/solver-arkade/src/arkade/lockupFunding.ts` and `packages/solver-arkade/src/arkade/reservations.ts` exist — see
"Settings and defaults" below.

## Architecture

Current flows and the intents end-state, including a per-element
implemented-vs-target table: [`docs/architecture.md`](docs/architecture.md)
(diagram source: [`docs/architecture.excalidraw`](docs/architecture.excalidraw)).
The purely-outbound transport (provider with zero listening ports) has its own
write-up and verified end-to-end run: [`docs/outbound.md`](docs/outbound.md).
Where the RFQ round trip spends its time, measured against a live
relay, and the bespoke-bus-vs-Nostr question resolved:
[`docs/relay-transport.md`](docs/relay-transport.md).
Every timing constant, margin and gate on one page — what each protects and
why it has the value it has: [`docs/deadlines.md`](docs/deadlines.md).

The design rule everything hangs off: **the client derives the swap script
itself and funds only its own derivation.** A quote carries only five binding
fields a client trusts — `solver_pubkey`, `refund_locktime`, `valid_until`,
`from_amount`/`to_amount` — and only two of them (`solver_pubkey`,
`refund_locktime`) enter the script derivation. Amount, payment hash,
Arkade server key, emulator key and refund destination are all the client's own
data, so a wrong or malicious provider can only produce an address the client
refuses, never one that traps funds. Failure needs nothing from the client
either: the script's refund leaf is a covenant (`enforcePayTo` behind a tweaked
emulator key), so after the deadline _anyone_ can push a refund that provably
pays only the client's address — no client keys, no client state.

## What it means to "send to Lightning", client-side

Integration speaks **RFQ v1** — the standard negotiation layer for every
corridor, specified end to end in
[`docs/rfq-protocol.md`](docs/rfq-protocol.md), with a ready JS trader
library ([`docs/integration-js.md`](docs/integration-js.md)). The whole client is six steps,
and it is transport-agnostic: the same `{v:1, type:"rfq_request", …}` payload
goes over **either** an HTTP POST **or** the outbound relay — HTTP is not
required. Two runnable reference clients:
[`examples/send-client.mjs`](examples/send-client.mjs) (HTTP) and
[`examples/send-client-relay.mjs`](examples/send-client-relay.mjs) (relay, no
HTTP anywhere).

1. decode the invoice yourself
2. send an `rfq_request` over your transport — `POST /v1/swap` on HTTP, or
   publish it to the relay addressed to the solver's pubkey:
   `{ v: 1, type: "rfq_request", rfq_id: <your random 32-byte hex>,
pair: "arkade:BTC->lightning:BTC", amount_side: "to",
profile: { invoice, refund_address } }`
3. trust only the quote's **binding fields**: `solver_pubkey`,
   `refund_locktime`, `valid_until`, `from_amount`/`to_amount`
4. derive the script locally; `profile.lockup_address` is compare-only —
   **refuse to fund on any mismatch**
5. gate (invoice live, ≥90 min deadline headroom, before `valid_until`), fund
   your own derivation
6. done — watch `GET /v1/rfq/<rfq_id>` on HTTP or send `rfq_status_request`
   over the relay, or just watch the lockup on-chain (the solver claiming
   spends it). `settled` reveals the preimage as your receipt; a failed swap
   refunds itself to your address

The RFQ family is the only wire family. The pre-RFQ `ln_send_*` shape was
removed unserved — nothing was ever deployed against it.

## Building your own solver

Nothing about the built-in corridors is privileged: they implement the same
`Corridor` interface you would, and a corridor this build was never compiled
against is served by the same host, driven by the same sweep and answered for by
the same status route. Registering one is a single call —
`createServices(config, { corridors: [mine] })` — and a BTC backend is a single
call too, `registerLightningRail('mine', module)` with `LN_BACKEND=mine`.
Somewhere to keep the coins is the third: `registerFundSource(services => …)`
puts your own wallet in the console beside the built-in two, with the same
read/deposit/settle/withdraw buttons, and a factory returning `null` means "not
on this deployment" rather than a source that is present and broken.

The **whole deployment** is describable in code as well: `Config` is a plain
exported interface, `loadConfig()` is the environment adapter that produces one
rather than the only source of one, and a solver serving its own corridors sets
`lnBackend: null` and needs no rail at all.

```ts
const services = await createServices(myConfig, { corridors: [mine] })
const app = buildApp({ corridors: services.corridors, readers: services.readers, network: 'bitcoin' })
```

The sweep loop is the one piece that is not reachable — it lives inside
`cli.ts` — so an app assembled this way must run its own; see `docs/authoring.md`
§ "The solver as a value" for the four lines and what they leave out.

- **The guide:**
  [`docs/repos/intent-solver/building-a-corridor.md`](docs/repos/intent-solver/building-a-corridor.md)
  — the descriptor, the eleven required members, the closed refusal vocabulary, and
  what the host will _not_ do for you.
- **A corridor that runs:**
  [`examples/corridor-host.mjs`](examples/corridor-host.mjs) over
  [`examples/lib/example-corridor.mjs`](examples/lib/example-corridor.mjs) — a
  whole solver with no wallet, no database and no environment.
  `pnpm build && node examples/corridor-host.mjs`.
- **An app written as a value:** `test/packaging/appInjection.test.ts` — a whole
  `Config` as a literal, no `process.env`, plus the sweep a consumer supplies.
- **What it costs, measured, and the obligations nothing checks:**
  [`docs/authoring.md`](docs/authoring.md).

## Layout

A pnpm workspace. Twelve packages under `packages/`; the repo root holds the
orchestration scripts, the shared dev tooling and the one `test/` tree.

```
packages/solver-core/           pure decision logic — no I/O, clock injected (limits,
                                timing gates, networks); strict BOLT11 decode with closed
                                rejection enums; the rail PORT types; and poll, log and the
                                GiveUp sentinel the orchestrators share
packages/solver-arkade/         Arkade wallet, covenant swap script, claim + covenant-refund
                                spends, and the solver's own float: renewal/recovery, funding
                                selection, the reservation ledger, the vtxo-pool planner
packages/solver-db/             the SqlDriver implementation over better-sqlite3, its own
                                package because it carries a NATIVE binding
packages/solver-rails/          the L1 HTLC script and the spends over it, vendor-neutral
packages/solver-rails-esplora/  the esplora chain-read client every onchain vendor needs
packages/solver-rails-lnd/      the LND rail — a rail is a PAIR, one wallet answering both
                                the Lightning and the onchain port
packages/solver-rails-fake/     a rail that forges and self-settles its own invoices for
                                regtest E2E, and is refused on `bitcoin`
packages/solver-rails-evm/      the EVM rail: RPC, the ERC20 swap contract, broadcast
packages/solver-corridors/      the four BTC corridors — send and receive orchestrators (the
                                money paths, and the ONE lockup-funding path), a durable
                                store per corridor, and the RFQ payload schemas and
                                quote/status mappers, one module per pair
packages/solver-corridors-evm/  the same shape, for arkade <-> ERC20
packages/solver-transport/      the ingress seam: the Hono app (inbound HTTP, bus-shaped
                                versioned payloads, runs on Node and Workers) and the
                                outbound relay client (WebSocket, reconnect + subscription
                                replay). Either one feeds the same dispatcher
packages/solver-app/            THE DEPLOYABLE, and the only package that is not a library:
                                the composition root (`ops/`), the admin console (`admin/`),
                                `config.ts`, `cli.ts` — every operation by hand, the
                                reproducibility surface — `worker.ts` for the Cloudflare
                                Workers entry, and its own Dockerfile
examples/                       reference clients + the JS trader library (examples/lib/)
scripts/                        regtest funding, mock relay, relay client
test/                           one suite, covering every package
```

`solver-core`'s modules take a `now` and return a decision — never a clock read, a
socket or a database — which is what makes the money gates testable at their
exact boundaries. The orchestrator holds the one rule that matters
operationally: **the row is the truth**; every step commits intent before the
irreversible side effect and is safe to re-run from any crash.

## Running it

- **Node 22 or 24** (`engines.node` is `>=22.6.0 <27`). Both ends are exercised
  in CI — the whole suite runs under `node:22-slim` and `node:24-slim`, and the
  Docker image is built and smoke-tested on both — so the range is a tested
  claim rather than a declaration. **22 is active LTS until April 2027 and stays
  supported**; nothing here requires 24.

  The Docker image defaults to 22 for that reason. Build it on 24 with
  `--build-arg NODE_VERSION=24`.

  The upper bound is deliberate: `<27` keeps an untested major from being picked
  up silently, and is meant to be raised once one is tested. Note that it will
  not stop you on its own — `engine-strict` is unset here (`pnpm config get
engine-strict` returns `undefined`, and `.npmrc` does not set it), so an
  out-of-range Node installs with at most a warning and surfaces later from a
  running process. Set `engine-strict=true` to find out at install time instead.

- **Regtest, end to end, no Lightning:** `docs/runbook.md` § "Replicating end to
  end on regtest" — arkd + emulator from
  [arkade-regtest](https://github.com/arklabsHQ/arkade-regtest),
  `LN_BACKEND=fake` forging its own invoices, mock relay for the outbound-only
  flow.
- **Deploy:** `docs/runbook.md` — single Node process, Docker image (compose
  file included), purely-outbound relay mode, and the Cloudflare Workers shape
  with its caveat stated.
- **Admin console:** `ADMIN_PORT=8788 pnpm cli relay` serves an operator
  console — swaps across every corridor the deployment serves, quotes, the
  wallet (sats and every Arkade asset it holds) and VTXO pool, the funding
  sources, backend status, settings and an action audit log — on its own port,
  from inside the running provider. Off unless `ADMIN_PORT` is set. **It has no
  authentication: anything that can reach that port can move money.** Put a
  reverse proxy in front of it, or tunnel to the default loopback bind. See
  `docs/runbook.md` § "The admin console".

  `ADMIN_HOST` chooses that bind, and defaults to `127.0.0.1` — which is the
  whole of the console's access control. Setting it to `0.0.0.0` publishes an
  unauthenticated money-moving interface to every interface the host has; do
  that only behind something that authenticates. `ADMIN_PORT` is an integer in
  `[1, 65535]` and a bad value throws rather than reading as "off", so a typo
  cannot silently darken the console an operator believes is up.

- **Funding sources:** every place this deployment keeps coins answers one
  interface (`packages/solver-app/src/ops/fundSources.ts`), so the console can
  read a balance, list the ways in, settle what has arrived and withdraw —
  without knowing whether it is talking to the Lightning rail or the Arkade
  wallet. Deposits are a **list**, because a source has more than one route and
  they differ in speed, in chore and in whether they expire: the Arkade float
  takes an Arkade address (spendable float on arrival) or its boarding address
  (L1, settle first), and the rail takes an invoice or an onchain address. The
  chore-free option is listed first. Two sources ship (`rail`, `arkade`); the
  rail one is simply absent
  without `LN_BACKEND`, so **the list is the availability decision** rather than
  a set of buttons that fail when pressed. Only `readBalance` is required, and a
  source that cannot do an operation says so in its capabilities instead of
  throwing at the end of it. Withdrawal is the one `armed`-tier action here —
  it is the only one that moves coins to an address the operator typed.

- **Theme:** follows your system's light/dark preference, with a toggle in the
  nav that overrides and persists. Both palettes are held to WCAG AA (4.5:1) by
  `test/admin/contrast.test.ts`, which re-derives every rendered
  foreground/background pair from `styles.css` itself — so a retune that dims
  something below legibility fails the build rather than shipping. That test
  exists because two tokens had already drifted under the floor: `--text-faint`
  (the raw row JSON and the timeline, small monospace) at 3.16:1, and `--failed`
  — the colour whose whole job is to say a swap failed — at 3.85:1 on its chip.
- **Troubleshooting a row:** the console explains itself rather than showing raw
  codes. A swap's detail carries the verbatim `failureReason` (so it still
  matches your logs) plus what that reason MEANS and what to do about it, and —
  for a state like `stuck` — what the state itself implies. The prose lives once
  in `packages/solver-core/src/core/refusalReasons.ts`, typed as a `Record` over every corridor's
  refusal enum, so a new refusal code cannot be added without an explanation:
  the build fails until there is one. **`recheck`** re-polls the backend and
  drives the row one step, on any of the four corridors; it is `safe`-tier
  because it is exactly what the sweep does on its own cadence, and it is the
  first thing to try on a `stuck` row — most resolve themselves once the backend
  is re-read.
- **CLI:** `quote · status · timeline · list · drive · watch · serve · relay ·
send · send-onchain · refund · refund-now · claim-now · onchain-refund-now ·
reclaim-l1-htlc · park-swap · test-refund · invoice · card · balances · pool` —
  every command goes through the same orchestrator the service runs. `pool` is
  the only one that spends the float on the operator's say-so rather than a
  swap's, and only under `--mint`.

  Five of them act on ONE existing row and are built for the incident rather
  than the happy path, so all five open every corridor
  (`createServices(config, { allCorridors: true })`) — a row whose corridor has
  since been disabled must still be unwindable, and the config that darkened it
  is usually the reason someone is unwinding. `refund-now` and
  `onchain-refund-now` push the refund for a swap the solver funded;
  `reclaim-l1-htlc` broadcasts the refund of an L1 HTLC; `claim-now` records a
  preimage and returns the row to `claiming` for the sweep to push, rather than
  broadcasting anything itself; and `park-swap <id> <reason>` moves no coins at
  all — it takes a row out of the sweep with the reason recorded, for when no
  automatic outcome is reachable and a human has to own it.

- **Settings:** every environment variable and every constant, with which are
  yours to change, is in [§ Settings and defaults](#settings-and-defaults)
  below. Operator-facing deployment detail lives in
  [`docs/runbook.md`](docs/runbook.md); what was established by running against
  the real services is in [`docs/environment.md`](docs/environment.md).

## Safety gates

Both legs pay out before they collect, so each exposing action has its
precondition checked **immediately before** it, never at setup time:

- never pay against an expired BOLT11, or one about to lapse mid-attempt
  (`MIN_INVOICE_WINDOW`, 2 min)
- never pay unless the lockup covers the full amount
- never pay within 90 minutes of the client's refund deadline
  (`MIN_CLAIM_WINDOW`) — the deadline matures against median-time-past, which
  lags wall clock ~1h, so a smaller margin is no margin
- never fund a lockup first observed after the quote's funding deadline
  (`lockupDeadlineFor` — at most `LOCKUP_TIMEOUT_SECONDS`, default 15 min, and
  less when the invoice itself expires sooner)
- never sign a checkpoint the server returned unless it txid-matches a
  checkpoint built locally — a forged one would harvest the preimage and the
  provider's signature
- never pay a lockup whose claim key is no longer the configured provider key
- aggregate exposure cap on top of per-swap limits (`MAX_EXPOSED_SATS`), with
  quote creation metered per requester (a quote holds capacity for its whole
  funding window)

These are invariants in the state machines, not policy config: a deployment
that could switch them off could lose money, so there is no switch. The
tables below say per value which is which — every row is marked either
**invariant** (recompile to change it) or **config** (an env var).

## Settings and defaults

Two kinds of number live in this service and they must not be confused:

- **config** — an environment variable, with a default where one is safe. The
  full operator-facing list is `docs/runbook.md` § "Configuration
  (environment)"; the table below is the same set read off `packages/solver-app/src/config.ts`,
  with what breaks when it is missing.
- **invariant** — a constant in `src/`, deliberately not reachable from the
  environment. Changing one is a commit, a review and a redeploy, which is the
  point.

Nothing in the second group has an env override, and nothing in the first
group can widen a safety bound: `MAX_SWAP_SATS` may only narrow the per-swap
range (`resolveLimits` takes a `Math.min` against the network default), and
that is the only knob that touches an amount at risk at all.

### Environment — required

| Var              | Default                                              | What breaks without it                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARK_MNEMONIC`   | none                                                 | throws `ARK_MNEMONIC is not set` at `loadConfig`. Secret — never logged                                                                                                                                                                                                                                                                                                                                        |
| `ARK_SERVER_URL` | none                                                 | throws `ARK_SERVER_URL is not set`. arkd endpoint                                                                                                                                                                                                                                                                                                                                                              |
| `EMULATOR_URL`   | none                                                 | throws `EMULATOR_URL is not set`. Co-signs covenant refunds — no network profile ships a default, on any network                                                                                                                                                                                                                                                                                               |
| `RELAY_URL`      | none (`null`)                                        | `relay` mode is unavailable, and `card` emits a listing with no RFQ transport. Must be `wss://` (or `ws://` against the mock relay)                                                                                                                                                                                                                                                                            |

### Environment — optional, with defaults

| Var                                           | Default                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SWAP_NETWORK`                                | `regtest`                                                | `bitcoin` \| `mutinynet` \| `signet` \| `regtest`. Anything else throws. Selects the whole profile: limits, invoice/Arkade prefixes, backend network name |
| `LN_BACKEND`                                  | none                                                     | `lnd` \| `fake`, or the name of a rail a consumer registered (`registerLightningRail`, `packages/solver-app/src/ops/rails.ts`); matched exactly after trimming, and an unrecognised value throws naming the accepted set rather than falling through to one. **No default, and required unless all four BTC corridors are disabled** — a rail is a PAIR, one wallet answering both the Lightning and the onchain port, so the onchain corridors take their backend from this value too. A deployment serving only EVM or asset flow says so with `<CORRIDOR>_ENABLED=false` on the four and leaves this unset; `Services.ln` and `Services.onchain` are then null and throw by name if anything reaches for them. `lnd` talks to a real LND node's gRPC; `fake` forges and self-settles its own invoices for regtest E2E and is refused on `bitcoin` |
| `ARK_UNILATERAL_EXIT_DELAY`                   | none (believe the server)                                | Seconds. What to treat as the Arkade server's unilateral exit delay instead of the value it advertises at `/v1/info`, for a deployment where arkd enforces a shorter minimum than it announces — mainnet does: `/v1/info` reports its _Public_ unilateral exit (605184) while covenant leaves are checked against the plain _Unilateral exit_ (259584), so `260096` is the value to set there. Not cosmetic: every covenant's CSV timelocks come from it, and the Lightning receive corridor sizes its final CLTV delta against it — at mainnet's advertised `605184` that corridor needs 4074 blocks and cannot be served, while at or below **296448s (~3.43 days)** it is served with every gate intact (`maxServableExitDelay`). **Served is not routable, and the difference has been misread here before:** at `260096` the strict rule still wants **1774 blocks** of final CLTV — ~12 days of a payer's funds, leaving ~242 blocks for the whole route under the 2016 gate. Setting this does NOT make `LN_RECEIVE_ACCEPT_UNILATERAL_GAP` unnecessary; that flag is what takes the requirement to 54 blocks, and it does so at any exit delay. **The directions are not symmetric:** too high is merely wasteful, too low writes a script the server rejects **at spend rather than at funding**, with money already in it. Confirm the server accepts the script with one small real spend first (a collaborative claim or refund proves that much; the CSV leaves are reachable only through a server-independent exit, which `cli unilateral-exit` performs). In-flight swaps are unaffected — each row snapshots its own delays at quote time |
| `ARK_ESPLORA_URL`                             | none (SDK per-network default)                           | the Arkade wallet's view of the Bitcoin chain. Unset takes the SDK's per-network default, which on regtest is `http://localhost:3000/api` and inside a container resolves to the container itself. The failure is QUIET — one `Failed to fetch chain tip` line, then block-denominated VTXO expiry goes unwatched. Not `LND_ESPLORA_URL`, which is the Lightning side's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `LN_RECEIVE_ACCEPT_UNILATERAL_GAP`            | `false`                                                  | `true` \| `false`, exactly — a typo throws rather than reading as agreement. Serves `lightning:BTC->arkade:BTC` even when the solver's own solo recourse opens AFTER the incoming htlc's `E`, which is in practice the only way the corridor runs on mainnet: arkd reports `unilateralExitDelay=605184` (7 days), so the solo leaf opens at 7.05 days and the strict rule demands 4074 blocks of final CLTV — roughly 28 days of a payer's funds, which nothing routes, so every quote is refused `recourse_window_unservable`. Raising `MAX_FINAL_CLTV_BLOCKS` does not help (2016 reports the wall, it is not the wall) and neither does the server-independent exit (`cli unilateral-exit`), which lets the solver USE the leaf but leaves the 7-day CSV unchanged. `ARK_UNILATERAL_EXIT_DELAY` moves the strict requirement without removing it: at `260096` it is 1774 blocks rather than 4074, under the 2016 gate so quotes stop being refused — but that is still ~12 days of a payer's funds with ~242 blocks left for the whole route. **Servable is not routable**, which is why this flag exists at all; with it set the requirement is 54 blocks at any exit delay, because accepting the gap is what removes the dependency. **What it accepts:** with the Arkade server gone or censoring past its exit delay AND `E` passed, a trader can let the htlc fail back for free and only then claim the Arkade payout, taking both sides (#69). Bounded by `LN_RECEIVE_MAX_SATS`, which `bitcoin` therefore requires you to set explicitly alongside it. Gates (a)–(c) are untouched. Shown in the admin console; not editable there                                                                                                                        |
| `DB_DIR`                                      | `.data` (`/data` in the image)                           | the directory every database file goes in — the whole set below, unless a variable names one individually. Point it at the volume and there is nothing else to place. Set-but-empty reads as unset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SWAP_DB_PATH`                                | `<DB_DIR>/swaps.sqlite`                                  | swap rows. THE file to back up. Readable by `status`/`list`/`timeline` without any key material. **Names four sibling files, not one**: each corridor opens its own SQLite store, and the admin console its own, derived by suffixing this path — `-onchain`, `-receive`, `-onchain-receive`, `-admin`. Back up the set, not the file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ARK_DB_PATH`                                 | `<DB_DIR>/ark.sqlite`                                    | Arkade wallet state — a separate file from the swap DB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `FAKE_LN_STATE_PATH`                          | `<DB_DIR>/fake-ln.json`                                  | the fake backend's preimage map                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MAX_SWAP_SATS`                               | network default (below)                                  | **narrows only.** A value above the network max is silently clamped down; non-finite or ≤ 0 throws                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MAX_EXPOSED_SATS`                            | `limits.maxSats * 3`                                     | aggregate cap across concurrently-exposed swaps. Non-finite or ≤ 0 throws                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `<CORRIDOR>_MIN_SATS` / `<CORRIDOR>_MAX_SATS` | the deployment range                                     | per-corridor range, where `<CORRIDOR>` is `LN_SEND`, `LN_RECEIVE`, `ONCHAIN_SEND` or `ONCHAIN_RECEIVE`. **Narrows only**, applied after `MAX_SWAP_SATS`: a corridor cannot be widened past the deployment cap by reaching for the more specific knob. Non-integer or ≤ 0 throws; a floor above the ceiling throws rather than quoting an empty range                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `<CORRIDOR>_ENABLED`                          | `true`                                                   | whether this corridor QUOTES. `false` darkens it: its service is never constructed, and its pair is refused `unsupported_pair` at both ingresses (by name, before any quote exists) instead of being quoted and failed per swap. It does **not** abandon swaps already in flight — the sweep still drives every non-terminal row to completion or refund, so switching a corridor off never strands a funded client lockup, and `refund` / `onchain-refund-now` / `reclaim-l1-htlc` still unwind its rows. Only the exact strings `true`/`false`; `FALSE`, `0` and `no` all throw, because a typo silently meaning "on" would leave a corridor quoting that an operator believes is dark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `<CORRIDOR>_FEE_BPS`                          | `0`                                                      | the corridor's spread, in basis points. Integer in `[0, 9999]`; anything else throws. Charged on all four corridors, but not in the same direction: `LN_SEND` adds it on top of the invoice (the client locks invoice + fee); the other three subtract it from what the solver delivers, snapshotted onto the row as `payout_sats` at quote time so a later config change can never reprice a paid client. A quote whose fee eats the whole amount refuses `pricing_unavailable`, and the onchain corridors additionally refuse a payout under 330 sats (dust)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `<CORRIDOR>_FEE_FLAT_SATS`                    | `0`                                                      | a flat charge on top of the spread, for the fixed cost a corridor pays regardless of swap size — an onchain leg broadcasts a transaction either way. Integer in `[0, 1000000]`. **A Lightning corridor charging one cannot publish a registry card** (the schema carries `fee_bps` only) and **will not bid on open RFQs** (same reason), rather than advertise a rate it will not honour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `<CORRIDOR>_FEE_CAP_SATS`                     | unset                                                    | the ceiling on what this corridor charges for EXECUTION, and the switch that turns live pricing on: set, the corridor prices its own chain cost as `vsize x sats/vbyte` from a sampled fee rate instead of charging `<CORRIDOR>_FEE_FLAT_SATS`, which becomes the fallback for when no estimate is available. Integer in `[1, 1000000]`. **`ONCHAIN_SEND` and `ONCHAIN_RECEIVE` only** — set on a Lightning corridor it throws, because that backend cannot yet be asked what a payment will cost and a knob that parses and changes nothing is worse than none. The two directions are sized separately: receive pays for the solver's claim of the client's HTLC, send pays for funding it. `<CORRIDOR>_FEE_BPS` is untouched — it covers proportional risk, which does not move with a fee market |
| `<CORRIDOR>_FEE_MIN_SATS`                     | `0`                                                      | the least this corridor will charge flat, however cheap execution turns out to be — a swap ties up float, carries refund risk and takes attention, none of which fall to zero because fees did. Integer in `[0, 1000000]`. A SEPARATE number from `<CORRIDOR>_FEE_FLAT_SATS`: that one answers "what do I think this costs" and is the fallback, this one answers "what is the least I will do this for". Set without `<CORRIDOR>_FEE_CAP_SATS` it throws (with no cap there is no live pricing for it to floor); above the cap it throws too |
| `ONCHAIN_FEE_RATE_REFRESH_MS`                 | `60000`                                                  | how old the sampled sats/vbyte reading may get before a refresh STARTS. The held value keeps being served meanwhile, so a refresh never blocks a quote — `PricingStrategy` is synchronous precisely so an upstream call cannot land on the hot path. Reading is what triggers refreshing, so a solver that is not quoting polls nothing. ONE sample serves both onchain corridors, so the two directions cannot price the same instant off different numbers |
| `ONCHAIN_FEE_RATE_STALE_MS`                   | `900000`                                                 | how old that reading may get before it stops being served at all, at which point pricing falls back to `<CORRIDOR>_FEE_FLAT_SATS` rather than quoting off a number from an hour ago. Must exceed `ONCHAIN_FEE_RATE_REFRESH_MS`, or every read past the refresh age returns nothing and the sample degrades to permanently absent — quietly, and only under load. Longer than a block interval by default, so a merely slow source keeps its answer |
| `SWEEP_CONCURRENCY`                           | `8`                                                      | swaps driven per Lightning-**send** sweep, the only sweep with any fan-out. The other three corridors tick serially and this does not reach them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POOL_AUTO_MINT`                              | `false`                                                  | whether the watch loop splits the float into the VTXO pool on its own, without an operator running `pool-mint`. **Opt-in because it spends**: the pass runs after recovery (recovered coins are what there is to split) and mints at the shape `poolTarget` derives from `MAX_SWAP_SATS` and `MAX_EXPOSED_SATS`. Never forced — the concurrent-provider guard still applies, precisely because this caller has no human to weigh it, so a second process on the same mnemonic skips rather than races. A failed mint is logged and the loop continues; the next cadence sees the same float. Only the exact strings `true`/`false`; anything else throws, since `Boolean('false')` is `true` and a typo would hand an operator the automated spending they had explicitly declined                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `CONTRACT_RETENTION_DAYS`                     | `30`                                                     | how long a DISABLED contract row is kept before it is deleted. Retirement is two-stage: once a swap is over and its script holds nothing unspent the contract is disabled (`watch: 'retained'`, reversible, still annotates its outputs), and only after this window is the row deleted. Deleting is what bounds cost — `getContractsWithVtxos` syncs an unfiltered contract list, so a retained row is still fetched from the indexer on every snapshot (arkade-os/ts-sdk#787). Non-finite or ≤ 0 throws                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `LOCKUP_TIMEOUT_SECONDS`                      | `900` (15 min)                                           | funding window a Lightning-**send** quote grants, as an UPPER bound — the window is clipped to the invoice when that binds first (`lockupDeadlineFor`), so this sets no minimum invoice life. After the window the sweep abandons the swap. Integer in `[60, MAX_LOCKUP_TIMEOUT]`, the ceiling **derived** as `REFUND_SAFETY_MARGIN` (2h): the window is spent out of the very margin the deadline reserves for claiming, so a longer one could only produce swaps that refuse themselves `cltv_budget_too_short`. Defence in depth — `payableCltvBlocks` enforces that at payment time regardless. The onchain corridors keep their own fixed 15 min                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `LN_SEND_HINT_SCID_DENYLIST`                  | empty                                                    | route hints this deployment will not price, as a comma-separated list of lowercase hex `short_channel_id`s (16 hex chars each; anything else throws). Unset or empty prices every hint, which is the pre-existing behaviour. The whole hint goes when ANY of its hops is denylisted — a hint is a path. **Ships empty, and an entry is only ever added on authoritative confirmation** (the wallet vendor, the node operator named by the hint, or the recipient) **that the channel cannot route.** How a scid LOOKS is not confirmation: BOLT #2 requires an unannounced channel's `option_scid_alias` to be unrelated to its real `short_channel_id` and permits it in `r` fields, so a block field above the chain tip is not a confirmation height — LND allocates aliases from heights 16000000-16250000, where such a value is evidence FOR a live private channel. Private channels are absent from gossip too, so "no edge found" proves nothing. **A wrong entry is a fund-risk, not a lost swap**: a routable channel listed here is priced out of a deadline a route can still take, which on a rail that caps nothing is the double-collect window. `docs/runbook.md` gives the standard                   |
| `PORT`                                        | `8787`                                                   | `serve` binding; integer 1–65535                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `HOST`                                        | `127.0.0.1`                                              | `serve` binding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `RELAY_PROTOCOL`                              | `nostr`                                                  | `dev` speaks `scripts/mock-relay.mjs`'s broker framing. Any other value throws — defaulting to the production dialect is deliberate, since a Nostr relay spoken to in dev framing connects and then goes silently deaf                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `OPEN_RFQ_MAX_BIDS_PER_MIN`                   | `30`                                                     | `0` disables open-RFQ bidding entirely (the market-key subscription is never opened)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `RELAY_HEALTH_PATH`                           | `.data/relay-health` (`/data/relay-health` in the image) | `relay` touches this mtime every 10s while the socket is up; the image's `HEALTHCHECK` reads exactly this path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `NOSTR_AD_PUBLISH`                            | `off`                                                    | whether this solver advertises itself on Nostr (kind 38859, `docs/rfq-protocol.md` § 3). `manual` publishes only when asked; `auto` also republishes on change or heartbeat. Under `off` the console's **post now** action is REFUSED, not merely unused — a policy an action can override is advisory. Any other value throws                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

`PORT`, `OPEN_RFQ_MAX_BIDS_PER_MIN` and `LOCKUP_TIMEOUT_SECONDS` go through `intFromEnv`, which treats an
empty or whitespace value as unset rather than as `Number('') === 0`. The three
`Number()` knobs (`MAX_SWAP_SATS`, `MAX_EXPOSED_SATS`, `SWEEP_CONCURRENCY`)
throw on an empty value instead. Either way, set-but-empty never silently
becomes zero. The three do not validate identically past that point:
`SWEEP_CONCURRENCY` checks `Number.isInteger`, so `1.5` is rejected as "must be
a positive integer", while the other two check `Number.isFinite` and would
accept it.

### Environment — EVM corridors (`ethereum:<token>`), off unless `EVM_TOKENS` is set

Nothing here has a default and nothing here is read unless `EVM_TOKENS` names at
least one token. A deployment that sets none behaves exactly as it did before
these existed: no EVM store is opened, no EVM corridor is constructed, and both
EVM pairs are refused `unsupported_pair` at the ingress.

The absence of defaults is deliberate — with one exception below. A default block
cadence or acceptance depth is a guess about a chain this service has never seen,
and both are wrong in a direction that costs money — so an operator enabling a
chain has to state what that chain does.

| Var                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVM_TOKENS`                    | the tokens served, `SYMBOL:0xaddress:decimals`, comma-separated. The symbol is what every other knob below names, because `EVM_SEND_0XA0B8…_MAX_SATS` is legal shell and unreadable. A repeated symbol or address throws                                                                                                                                                                                                         |
| `EVM_RPC_URL`                   | JSON-RPC endpoint. **Absent means the corridor is not served** and is not an error; anything else missing while it IS served is, because the missing half is always a safety knob                                                                                                                                                                                                                                                |
| `EVM_HTLC_ADDRESS`              | the `ERC20Swap` deployment, 20 bytes `0x`-prefixed                                                                                                                                                                                                                                                                                                                                                                               |
| `EVM_CHAIN_ID`                  | EIP-155 chain id, so a signed transaction cannot be replayed onto another chain                                                                                                                                                                                                                                                                                                                                                  |
| `EVM_PRIVATE_KEY`               | 32 bytes of hex, signing this corridor's transactions. **Separate from `ARK_MNEMONIC` on purpose** — rotating one must not silently rotate the other, including the one holding funds mid-swap                                                                                                                                                                                                                                   |
| `EVM_MIN_CONFIRMATIONS`         | depth before a client's lock counts as real. Proven by asking the contract whether the lock was already there that many blocks ago — an `eth_call` at a historical height — so a node that has pruned that far cannot answer and the corridor waits rather than advancing on an unproven depth. Your node's state retention therefore bounds what you can configure here                                                         |
| `EVM_MIN_AGE_SECONDS`           | how long it must ALSO have been buried. Both halves exist because depth alone is not finality: a rollup sequencer issues a receipt in 1–2 seconds, so a lock can be many confirmations deep and still vanish. The observer takes the later                                                                                                                                                                                       |
| `EVM_FASTEST_SECONDS_PER_BLOCK` | the fastest plausible cadence — used to read someone ELSE's deadline, so an early estimate is the safe one                                                                                                                                                                                                                                                                                                                       |
| `EVM_SLOWEST_SECONDS_PER_BLOCK` | the slowest plausible cadence — used to size OUR own, for the mirror reason. A floor above the ceiling throws at startup                                                                                                                                                                                                                                                                                                         |
| `EVM_GAS_LIMIT`                 | gas ceiling for one call. A ceiling rather than an estimate: `eth_estimateGas` cannot be trusted for a call that reverts under conditions it does not reproduce, and a claim that runs out of gas past the timeout is a total loss                                                                                                                                                                                               |
| `EVM_MAX_FEE_PER_GAS_CEILING`   | what one transaction may cost, in wei per gas. The pricing reports when it BOUND the answer rather than silently underpricing                                                                                                                                                                                                                                                                                                    |
| `EVM_FEE_HEADROOM_SECONDS`      | how long a transaction must stay viable while unmined, which sizes `maxFeePerGas` against a rising base fee                                                                                                                                                                                                                                                                                                                      |
| `EVM_QUOTE_VALIDITY_SECONDS`    | **default `60`**, integer in `[10, 900]` — the only EVM knob with a default, because the value is policy, not chain fact: rfq-protocol.md §5 puts cross-asset quote windows "on the order of ~30 seconds". The quote's `valid_until` is `now + this`, snapshotted per row; funding first observed past it is refused and refunded, never filled at a stale rate                                                                  |
| `EVM_ORDER_MARGIN_SECONDS`      | the recourse margin between the two legs' deadlines — the time to see a counterparty's claim and get our own settled                                                                                                                                                                                                                                                                                                             |
| `EVM_MIN_CLAIM_WINDOW_SECONDS`  | the least time a client is given to claim. On a corridor where they may have to acquire gas first, even minutes are thin                                                                                                                                                                                                                                                                                                         |
| `EVM_SEND_<SYMBOL>_*`           | per-token, per-direction corridor knobs — the same `_ENABLED` / `_MIN_SATS` / `_MAX_SATS` / `_FEE_BPS` / `_FEE_FLAT_SATS` family as `<CORRIDOR>_*` above, e.g. `EVM_SEND_USDC_MAX_SATS`. Plus the inventory bound `_MIN_UNITS` / `_MAX_UNITS` (atomic units of the token, both-or-neither, bigint-parsed): enforced at quote time, and the knob that still refuses when the price has run away and the sats bound reads generous |
| `EVM_RECEIVE_<SYMBOL>_*`        | the same, for the other direction. The two directions are separate corridors and are enabled separately                                                                                                                                                                                                                                                                                                                          |
| `EVM_<SYMBOL>_*`                | the token's MARKET — its price feed and pointer. No direction in the name, because a market is the pair and both directions share it                                                                                                                                                                                                                                                                                             |

**One caveat on amounts.** Every amount on the wire is still bounded by
`Number.MAX_SAFE_INTEGER` (`packages/solver-core/src/core/wireAmount.ts` landed the string ENCODING, not
the range). In atomic units that is ~9e15: no constraint for a 6-decimal token
such as USDC or USDT, but an 18-decimal token cannot be served until the
downstream `number`s are widened to bigint, since one whole token is 1e18.

### Environment — Arkade asset offers (the packet path), off unless `OFFER_MARKETS` is set

Not a corridor, and absent from the corridor tables above rather than missing
from them. Both legs are on Arkade and the maker's covenant obliges the fill to
pay them in the same transaction, so there is no HTLC, no deadline and no refund
— which is also why there is no `_ENABLED` knob and no fee row of its own.

**The solver is always the TAKER.** There is deliberately no option for
publishing an offer. An offer is a standing commitment with no expiry, so
publishing one writes a free option against this deployment's float.

A deployment that sets none of these behaves exactly as it did before they
existed: no `offer_fill` table is opened, no subscription to arkd's filtered
transaction stream, nothing decided and nothing spent.

| Var                     | Notes                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OFFER_MARKETS`         | the markets taken, `A/B` pairs comma-separated, where `BTC` is the sats leg and anything else is a 68-hex asset id: `BTC/<assetId>,<assetIdA>/<assetIdB>`. Unordered — one entry serves both directions. Unset serves none, which is the whole path off. An entry naming one thing twice, or not shaped `A/B`, throws                              |
| `OFFER_MIN_FILL_AMOUNT` | **required once `OFFER_MARKETS` names a market**, with no default shipped: this is how much of the float one discovered offer may take, which is the deployment's answer rather than this repository's. A whole number in the WANT leg's own units — asset units, or sats when that leg is BTC — parsed as bigint, since an asset amount is 256-bit |
| `OFFER_MAX_FILL_AMOUNT` | same rule, the upper bound. A max below the min throws at startup: it would refuse every offer, which is indistinguishable from a quiet market and would be diagnosed as one                                                                                                                                                                       |

### Environment — `LN_BACKEND=lnd` only

| Var                                  | Default         | Notes                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LND_SOCKET`                         | none            | required; `host:port` of the gRPC listener                                                                                                                                                                                                                                                                |
| `LND_CERT` / `LND_CERT_PATH`         | none            | **exactly one.** Both set, or neither, is an error — silently preferring one is how a stale file ships the wrong cert                                                                                                                                                                                     |
| `LND_MACAROON` / `LND_MACAROON_PATH` | none            | same rule. `_PATH` is read and base64-encoded at load                                                                                                                                                                                                                                                     |
| `CHAIN_TIP_ESPLORA_URL`              | `LND_ESPLORA_URL` | **block-typed deployments only.** Where to read the chain tip height. A deployment whose arkd advertises a BLOCK-typed unilateral exit delay writes covenant timelocks that mature on HEIGHT — both the CSV ladder and the absolute refund locktime — so the service needs somewhere to read one. Falls back to `LND_ESPLORA_URL`, which points at the same indexer wherever one exists, so block mode usually needs no new variable. A seconds-typed deployment never reads it; if a block-typed row ever reaches an orchestrator without a tip source, it throws a named error rather than guessing — guessing "not reached" strands a refund forever, and "reached" pushes one the chain rejects |
| `LND_ESPLORA_URL`                    | none (optional) | **onchain-receive corridor only.** LND's own chain view is wallet-scoped and carries no per-output values, so it cannot see a client's funding transaction. Unset is fine for a send-only deployment; the receive path fails loudly (`onchain receive needs an Esplora URL…`) rather than under-reporting |

### Environment — test and tooling only

| Var                                                 | Default            | Used by                                                                                |
| --------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `PAYEE_MNEMONIC`                                    | none               | `cli invoice` on a non-`fake` backend — stands in for an arbitrary Lightning recipient |
| `SOLVER_NAME`                                       | none               | `cli card`, when no name is passed positionally                                        |
| `SOLVER_CARD_RELAYS`                                | `''`               | comma-separated relays added to the card beyond `RELAY_URL`                            |
| `E2E_ENV_FILE`                                      | `.env.regtest.lnd` | `test/e2e`. Note its `ARK_DB_PATH` is a **different wallet** from `.env.regtest`'s     |
| `MOCK_RELAY_PORT`, `PROBE_WAIT_MS`, `SOLVER_PUBKEY` | —                  | `scripts/mock-relay.mjs`, `scripts/probe-relay.mjs`                                    |

### Amounts (`packages/solver-core/src/core/networks.ts`, `packages/solver-core/src/core/limits.ts`)

| Value                                     | Setting                                           | Tunable                                                                                 |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `bitcoin` limits                          | 500 – 1,000 sats                                  | **invariant** (narrowable by `MAX_SWAP_SATS`)                                           |
| `signet` / `mutinynet` / `regtest` limits | 1,000 – 1,000,000 sats                            | **invariant** (narrowable)                                                              |
| `MAX_EXPOSED_SATS`                        | `3 × maxSats`                                     | config                                                                                  |
| `SOLVER_FEE_BPS`                          | `0`                                               | **invariant** — one constant so the card, the bids and quote pricing cannot drift apart |
| `maxRoutingFeeSats(a)`                    | `max(10, ceil(a × 0.005))` — 50 bps, 10-sat floor | **invariant**                                                                           |

Mainnet is capped deliberately low: the first swaps exist to prove the
mechanism, not to move money. Raising `BITCOIN_LIMITS` should be a deliberate
commit, not a deploy-time flag — which is why it is not one.

### Timelock arithmetic (`packages/solver-core/src/core/timelocks.ts`)

Everything here is **invariant**; two encodings are in play and they are not
interchangeable.

| Constant                       | Value         | Protects against                                                                                                                                                                    |
| ------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOCKTIME_THRESHOLD`           | `500_000_000` | BIP65's height/time boundary. `assertAbsoluteLocktime` rejects anything below it outright — a refund locktime a verifier reads as a _block height_ is a deadline that never arrives |
| `SEQUENCE_GRANULARITY_SECONDS` | `512`         | BIP68's unit. A relative delay that is not a whole multiple of 512 cannot be expressed at all                                                                                       |
| `MINUTE` / `HOUR`              | `60` / `3600` | the units every gate below is written in                                                                                                                                            |

Block heights are deliberately never used for either: a two-hour window is
roughly twelve blocks, and block-interval variance over twelve blocks is far
too wide to hold a Lightning HTLC deadline against.

**The three unilateral delays are derived, not configured.**
`deriveUnilateralDelays(serverExitDelaySeconds)` reads the operator's own
minimum exit delay off `arkProvider.getInfo().unilateralExitDelay`
(`packages/solver-arkade/src/arkade/wallet.ts`) and returns:

| Delay                                  | Formula                              |
| -------------------------------------- | ------------------------------------ |
| `unilateralClaimDelay`                 | `ceilToGranularity(serverExitDelay)` |
| `unilateralRefundDelay`                | `claim + 512`                        |
| `unilateralRefundWithoutReceiverDelay` | `claim + 1024`                       |

They cannot be hardcoded. The server rejects any script whose exit delay is
below its configured minimum, and that minimum differs by orders of magnitude
between deployments — a couple of thousand seconds on a test network against
roughly a week on mainnet. A constant that works on one network produces
`INVALID_VTXO_SCRIPT: exit delay is too short` on another, and only _when a
spend is attempted_: the funding transaction is accepted first, so the failure
surfaces once there is already money in the script.

Each step is one 512s unit above the last, which is what preserves the
mandatory `claim < refund < refundWithoutReceiver` ordering. That ordering is
the invariant; the staggering is how it is guaranteed for any server minimum.

Three inputs are rejected outright, with the reason:

- not finite, or ≤ 0 → `server exit delay must be a positive number of seconds`
- **below 512** → `is below 512s and is a block count, not seconds`. This is the
  one that matters in practice: below 512 the value is a _block count_ by the
  SDK's own convention, so treating 144 blocks (~24h) as 144 seconds would
  round to a 512s timelock against a day-long requirement — accepted at
  funding, rejected at spend, money already locked
- above `0xffff × 512` = 33,553,920s (~388 days) → BIP68 cannot encode it

### Send leg — `arkade:BTC->lightning:BTC` (`packages/solver-core/src/core/send.ts`)

All **invariant**, except `DEFAULT_LOCKUP_TIMEOUT` — the default behind the
`LOCKUP_TIMEOUT_SECONDS` env knob.

| Constant                   | Value    | Protects against                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIN_INVOICE_WINDOW`       | 2 min    | paying an invoice that lapses mid-attempt — a payment may probe several routes, and being failed back after committing is a loss                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `MIN_CLAIM_WINDOW`         | 90 min   | the client refunding while we are still trying to claim. 90 because the deadline matures against **median-time-past** (BIP-113), which lags wall clock by ~1h on mainnet; a wall-clock margin smaller than the MTP lag is no margin at all. Also the client-side funding gate ("headroom ≥ 90 min")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DEFAULT_LOCKUP_TIMEOUT`   | 15 min   | a quote staying fundable indefinitely; after this the swap is abandoned. **Config**, not invariant: the default behind `LOCKUP_TIMEOUT_SECONDS` (see the environment table)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `lockupDeadlineFor`        | ≤ 15 min | a client funding inside the window it was quoted being refused for expiry anyway. The funding window is **fitted to the invoice** — `min(quotedAt + lockupTimeout, invoiceExpiresAt - MIN_INVOICE_WINDOW)` — so a short invoice gets a short window instead of being turned away. Replaced a fixed quoting FLOOR (`lockupTimeout + MIN_INVOICE_WINDOW`, 17 min at the default; before that `MIN_INVOICE_WINDOW + MIN_CLAIM_WINDOW`, 92 min) that bound nothing: the invoice clock decides only whether the PAYEE still accepts the payment, while what guards the money is the payee's CLTV delta held against `refundLocktime` — which never reads it. The floors' cost was ordinary invoices: 15 min is BTCPay Server's default expiry, and 92 min sat above BOLT11's own 3600s default |
| `SECONDS_PER_BLOCK`        | 600      | turning a CLTV delta into wall clock. **Nominal and slow on purpose** — here the refund deadline must _outlast_ an HTLC, so slow is the safe direction. Must never be swapped with `HTLC_SECONDS_PER_BLOCK`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ROUTE_CLTV_BUDGET_BLOCKS` | 432      | the CLTV our own route may add on top of the payee's final delta. **LND enforces it** (`max_timeout_height` → `cltv_limit`); a rail whose pay call exposes no max-CLTV control cannot, so there it is only a budget — which is why the number is a deliberately generous over-estimate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `REFUND_SAFETY_MARGIN`     | 2 h      | margin on top of the worst-case HTLC lifetime before the refund path opens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

`worstCaseHtlcBlocks = minFinalCltv + hintCltvBlocks(cltv) + routeBudget` is the
single definition of that worst case, and it has two consumers that must never
disagree: it becomes the client's refund deadline, and it is the budget the CLTV
ceiling the payment is capped at starts from.

Two of its three terms are read off the invoice, because the invoice's WRITER
chooses them: the final delta (`c`) and a route hint (`r`, whose
`cltv_expiry_delta` per hop is client-controlled and was previously ignored
entirely). WHICH hint is `hintCltvBlocks`'s call, and it is the one place that
choice is made — hints are ALTERNATIVES, so a rail that can decline an over-long
route is bound only by the BEST of them, while a rail that cannot is bound by
whatever the network picked, i.e. the worst. `MAX_CLIENT_CLTV_BLOCKS` (288) caps
the sum at two points that ask different questions:

| gate                                        | hint                                         | question                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | -----                                        | -------------------------------------------------------------------------------------------                                                                                                                                                                                                |
| `decodeInvoice` (backend-blind, a floor)    | best                                         | could ANY backend serve this? unconditional, so "no bound at all" cannot happen by omission                                                                                                                                                                                                |
| `evaluateSendAcceptance` (`cltv_too_large`) | worst                                        | can THIS deployment? only fires where the rail cannot cap the route                                                                                                                                                                                                                        |

A Wallet of Satoshi invoice carrying hints of `[40]` and `[40000]` is therefore
quoted on LND and refused on a rail that cannot cap, where it used to be refused
on both.

The third term, `routeBudget`, is what the public route may add — and the BACKEND
declares it (`SendBackend.routeCltvBudgetBlocks`) alongside whether it enforces
the ceiling at all (`SendBackend.enforcesRouteCltv`, declared separately rather
than inferred from the budget, which agrees only by coincidence):

| backend                | budget                                       | enforces | why                                                                                                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LND                    | `ROUTE_CLTV_BUDGET_BLOCKS` (432)             | yes      | enforces it via `max_timeout_height`, so being wrong costs a refused payment, not money                                                                                                                                                                                                    |
| a rail that cannot cap | `UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS` (2016) | no       | no CLTV field on the pay call, and none reported back on the payment either, so the route can be neither capped nor observed. The budget must bound ANY route the network would carry (LND's own default `--max-cltv-expiry`)             |
| fake                   | `ROUTE_CLTV_BUDGET_BLOCKS`                   | yes      | pays its own forged invoices over no network                                                                                                                                                                                                                                               |

Deployments on such a rail therefore quote refund deadlines much further out.
That is the price of a rail that cannot be capped, and it is bearable because the
deadline is a FALLBACK: a swap whose payment provably failed is refunded
immediately over the covenant's no-timelock leaf, and an expired VTXO stays
recoverable. Only a payment genuinely stuck in flight waits it out — exactly when waiting is right.
A ceiling looser than the deadline reserved for it is the double-collect window.

The ceiling actually handed to the backend is
`payableCltvBlocks(minFinalCltv, refundLocktime, now)` — that budget **clamped
by what is left of the deadline right now**, minus the safety margin. The two
numbers are not interchangeable, and the difference is a fund-loss bug:
`refundLocktime` is absolute and fixed when we quote, while the ceiling is a
delta from the moment we pay (LND: `max_timeout_height = current_height +
maxCltvBlocks`), so every second spent funding shortens one and not the other.
Unclamped, a swap funded more than `REFUND_SAFETY_MARGIN` after its quote could
authorise an HTLC outliving the client's refund. When the clamp falls to the
payee's own `minFinalCltv` there is no route left to buy, and the payment is
refused `cltv_budget_too_short` rather than attempted. This is the shape Boltz's
`TimeoutDeltaProvider.getCltvLimit` has — remaining timelock minus a buffer,
recomputed at payment time, never the value hoped for at quote time.

That clamp is not merely safe on an enforcing rail, it is the **mechanism**: it
shortens the ceiling second for second as funding drags, so the HTLC still ends a
full `REFUND_SAFETY_MARGIN` before the deadline however late the lockup arrived.
A ceiling is worth what the rail does with it, though, and a rail that cannot
cap drops it — so there the clamp narrows a number nothing reads while the real
HTLC stays as long as it ever could.

Two changes hold that rail to the same invariant. `deadlineContainsHtlc` requires
the budget to be **unclamped** — `payableCltvBlocks(…) >= worstCaseHtlcBlocks(…)`,
which is exactly the statement that what remains still affords the whole worst
case _and_ the margin — and refuses `uncapped_route_deadline_too_short`
otherwise. The margin is not spare slack: it is the time an observe-and-claim
needs after the preimage arrives (`MIN_CLAIM_WINDOW`, 90 min, against a deadline
maturing on median-time-past). A deadline that merely reached the end of the HTLC
would leave zero time to claim the lockup, which is the double-collect window
rather than a bound on it.

What pays for the funding delay there instead is the deadline itself:
`refundLocktimeFor` adds the **funding window** to `htlcBound` on a rail that
cannot cap, since nothing else absorbs it. Minutes against ~14 days of route
budget.

The gate exists because `enforcesRouteCltv` is read from the backend running at
PAYMENT time while `refundLocktime` was fixed at quote time, and nothing on the
row records which rail quoted it: a deployment moving off an enforcing rail
inherits rows whose deadlines were sized off the best route hint, which the new
rail cannot decline the worst of.

`refundLocktimeFor` returns the **later of two bounds**:

```
htlcBound       = now + (minFinalCltv + 432) × 600 + 2h
unilateralBound = now + unilateralClaimDelay      + 2h
refundLocktime  = max(htlcBound, unilateralBound)
```

The first closes the hold-invoice attack: a client supplies a hold invoice for
a node they control, funds the lockup, lets us pay, and sits on the HTLC — if
the refund path opened before that HTLC could resolve they would refund _and_
then settle, collecting twice. A fixed `now + 2h` is not a bound on anything
the client cannot choose.

The second closes the server-outage case: both collaborative paths need the
Arkade server to co-sign, so our only unilateral recourse is `unilateralClaim`,
which does not mature for `unilateralClaimDelay` (roughly seven days on
mainnet). On mainnet this bound dominates, which is why
`ROUTE_CLTV_BUDGET_BLOCKS` only really binds on small-exit-delay test networks.

Refusal reasons are closed sets. At quote time (`SendAcceptanceRefusal`):
`invoice_expired`, `invoice_expires_too_soon`, `wrong_network`,
`amount_out_of_range`, `zero_amount_invoice`. Immediately before paying
(`SendPaymentRefusal`): `invoice_expired`, `invoice_expires_too_soon`,
`claim_window_too_short`, `lockup_insufficient`.

### Receive leg — `lightning:BTC->arkade:BTC` (`packages/solver-core/src/core/receive.ts`)

All **invariant**. `E` is the deadline by which the held HTLC must be settled.
It is **read from the Lightning backend for this payment hash, never chosen and
never defaulted** — the backend may pick a value shorter than its documented
norm, and a hardcoded guess that runs long is precisely the case where the
provider pays out and cannot collect. Three windows fence it:

| Constant                 | Value  | Protects against                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIN_SETTLE_WINDOW`      | 90 min | funding when too little time remains before `E` to be sure we could notice the preimage and settle after a claim — including retries and a claim landing late in the window                                                                                                                                                                                                                                                                  |
| `SETTLE_SAFETY_MARGIN`   | 15 min | the refund path opening _after_ `E`. Once `E` passes the payment is gone, and Arkade funds in a script whose recourse has not opened would be lost outright                                                                                                                                                                                                                                                                                  |
| `MAX_REFUND_HORIZON`     | 2 h    | how long one swap may park provider capital. Applied at **quote** time, where the deadline is fixed; this module only reads the committed value back                                                                                                                                                                                                                                                                                         |
| `HTLC_SECONDS_PER_BLOCK` | 150    | a backend reporting `E` as a CLTV timeout _height_. **A floor on the block interval, not an estimate** — assuming blocks arrive too slowly puts `E` later than the truth and invents settle time we do not have; assuming too fast only declines a swap we could have served. 150s is a quarter of the 600s target, and difficulty retargets by at most 4× per period, so a sustained rate below it is bounded by consensus rather than hope |

`htlcDeadlineFromHeight` takes the _current_ height rather than the acceptance
height, so the answer tracks the chain's real progress, and it is deliberately
not clamped to `now`: once the chain is past the timeout the deadline genuinely
is in the past, and every gate downstream reads that correctly as "too late".

`evaluateReceiveFunding` must be called immediately before funding, never at
arming time, and returns a yes/no — never a deadline. The deadline is an
_input_, because by then the script enforcing it is already derived; recomputing
it would produce a different script that cannot spend the lockup holding the
money. `ReceiveFundingRefusal` is the closed set `invoice_expired`,
`htlc_not_armed`, `settle_window_too_short`, `refund_deadline_too_late`.

### Onchain corridors (`packages/solver-core/src/core/onchainSend.ts`, `packages/solver-core/src/core/onchainReceive.ts`)

All **invariant**. The first five are shared by name _and_ value with
`@arkade-os/swap`'s `onchainHtlc.ts`, because the client's own `assertFundable`
guardrail is written in terms of exactly these constants.

| Constant                                                            | Value                 | Notes                                                                                                                                                          |
| ------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ONCHAIN_SECONDS_PER_BLOCK`                                         | 600                   | declared in both modules                                                                                                                                       |
| `ONCHAIN_CLAIM_MARGIN_SECONDS`                                      | 90 min                | send leg                                                                                                                                                       |
| `ONCHAIN_ORDER_MARGIN_SECONDS`                                      | 2 h                   | send leg                                                                                                                                                       |
| `DEFAULT_MIN_CONFIRMATIONS`                                         | `1`                   | solver policy when a quote does not override it                                                                                                                |
| `MAX_MIN_CONFIRMATIONS`                                             | `6`                   | a requested depth above this is clamped down, not refused                                                                                                      |
| `ONCHAIN_DUST_SATS`                                                 | `330`                 | the **taproot** threshold, not P2PKH's 546 — the refund destination is taproot. Below it the spend refuses rather than broadcasting a non-standard transaction |
| `DEFAULT_ONCHAIN_LOCKUP_TIMEOUT`                                    | 15 min                | send leg                                                                                                                                                       |
| `DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT`                            | 15 min                | receive leg                                                                                                                                                    |
| `MIN_ONCHAIN_FUND_WINDOW`                                           | 90 min                | re-checked immediately before funding the onchain HTLC                                                                                                         |
| `MIN_ARKADE_FUND_WINDOW`                                            | 90 min                | re-checked immediately before funding the Arkade lockup                                                                                                        |
| `MIN_SETTLE_WINDOW` / `SETTLE_SAFETY_MARGIN` / `MAX_REFUND_HORIZON` | 90 min / 15 min / 2 h | redeclared in `onchainReceive.ts` under the same names and values as `receive.ts` — one invariant set, applying to every receive-direction profile             |

The two directions mirror each other and the direction of the bound flips:

```
send    htlcLocktime   = now + minConf × 600 + 2 × 90min
        refundLocktime = max(htlcLocktime + 2 × 2h,
                             now + unilateralClaimDelay + 2h)

receive htlcLocktime   = now + minConf × 600 + 2 × 90min
        arkadeRefund   = min(htlcLocktime - 15min, now + 2h)
```

On **send** the client funds the Arkade lockup and the solver funds the onchain
HTLC, so the Arkade refund must land safely _after_ the onchain deadline —
hence `max` of two lower bounds. On **receive** the roles invert, the solver
funds Arkade, and its refund must open safely _before_ the onchain deadline —
hence `min` of two upper bounds. Both margins are doubled rather than sized to
the boundary, so a quote is not refused by ordinary clock skew between solver
and client.

### Invoice parsing (`packages/solver-core/src/invoice/decode.ts`)

| Constant                       | Value         | Protects against                                                                                                   |
| ------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `MAX_INVOICE_LENGTH`           | 2048          | unbounded bech32 parsing is free DoS. **Invariant**                                                                |
| `MAX_CLIENT_FINAL_CLTV_BLOCKS` | 288 (~2 days) | how long the payee can keep our outbound HTLC alive — the quantity the refund deadline must outlast. **Invariant** |
| `DEFAULT_EXPIRY_SECONDS`       | 3600          | BOLT11's own default when the invoice carries no expiry tag                                                        |
| `DEFAULT_MIN_FINAL_CLTV`       | 18            | BOLT11's own default when there is no `c` tag                                                                      |

### Hold invoices (receive leg)

| Constant                                              | Value                                                           | Where                                                   | Tunable       |
| ----------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- | ------------- |
| `DEFAULT_HOLD_INVOICE_WINDOW`                         | derived: `MAX_REFUND_HORIZON − MIN_CLAIM_WINDOW` (1800 s today) | `packages/solver-corridors/src/receive/orchestrator.ts` | **invariant** |
| `EMPTY_LOCKUP_GRACE`                                  | 120 s                                                           | `packages/solver-corridors/src/receive/orchestrator.ts` | **invariant** |
| `FUND_CONFIRM_ATTEMPTS` / `FUND_CONFIRM_INTERVAL_MS`  | 8 × 1000 ms                                                     | `packages/solver-corridors/src/receive/orchestrator.ts` | **invariant** |

The window is subtracted, never picked: `refund_locktime` is `now + MAX_REFUND_HORIZON`
and cannot move once the covenant is built from it, so the invoice window is the
only free variable, and deriving it is what keeps the claim race at exactly
`MIN_CLAIM_WINDOW`. Both fields are stamped from a single clock read, so the
margin is that equality and not one second under it.

A backend cannot break this either way. One that _shortens_ the invoice moves
`payDeadline` earlier, widening the race; one that lengthens it cannot help
itself, because `payDeadline` is `min(invoice.expiresAt, quote.valid_until)` and
`valid_until` comes from the same constant.

`EMPTY_LOCKUP_GRACE` is how long `refunding` tolerates "the lockup is empty and
no claim is readable" before escalating to the terminal `stuck` state. The two
reads do not go true at the same instant — `findLockups` reports the lockup gone
the moment a claim marks the vtxo spent, while `findClaimPreimage` must also
fetch the spending transaction back — so in the gap a _completed_ swap reads
exactly like the inexplicable case. Read lag resolves in seconds; a genuine
anomaly never does. Hence a clock, not a single observation, and minutes rather
than seconds: escalating early throws a completed swap into a state with no
outgoing edge.

`HTLC_REFUND_MTP_MARGIN` (90 min, `packages/solver-corridors/src/send/onchainOrchestrator.ts`) is the
same MTP reasoning applied to arming the onchain refund: at the bare deadline
Bitcoin rejects the transaction as non-final for up to an hour, and worse,
widens the window in which the client can still land a valid claim after we
have committed to refunding.

### The solver's own coins (`packages/solver-arkade/src/arkade/vtxoLifecycle.ts`)

All **invariant**.

| Constant                             | Value         | Notes                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RENEWAL_THRESHOLD_MS`               | 3 days        | matches the SDK's `DEFAULT_RENEWAL_CONFIG.thresholdMs`. Only ever an **upper bound** — the threshold actually applied to a coin is `min(3 days, batchLifetime / 2)`, so a coin whose whole batch is shorter than three days does not renew on every single pass                                                                                 |
| `MAX_VTXOS_PER_SETTLEMENT`           | 50            | mirrors the SDK's own cap, copied because it is not exported. Overflow is a **deferral, not a loss** — the next pass renews it                                                                                                                                                                                                                  |
| `LOCKUP_RECOVERY_MTP_MARGIN_SECONDS` | 5400 (90 min) | how far past `refundLocktime` a lockup must be before recovery is attempted. Deliberately the same figure as `HTLC_REFUND_MTP_MARGIN`, but applied to the **skip** side: a premature refund broadcast is one rejected transaction, while a premature recovery is one rejected _settlement_ that takes every unrelated coin in the batch with it |

A block-denominated batch expiry is treated as having **no schedulable
expiry at all** rather than being converted: a height is not a time, and the
conversion needs a chain tip. Feeding `expiresAtHeight × 1000` to a clock
comparison lands in January 1970, which collapsed the renewal threshold to 0
and disabled the treadmill cap outright for those coins.

### Funding a receive lockup (`packages/solver-arkade/src/arkade/lockupFunding.ts`, `reservations.ts`, `vtxoPool.ts`)

All **invariant**, and the pool target is derived rather than set.

| Rule                                                   | Where                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prefer coins whose batch outlives `MAX_REFUND_HORIZON` | `selectLockupFunding`   | a **preference, not a requirement**. A lockup stays in its funder's batch and `vhtlc-v2` bars renewal from re-anchoring it, so the SDK's own soonest-expiry-first rule is exactly inverted here. But requiring it makes the corridor unusable wherever batches are shorter than the horizon — regtest's `ARKD_VTXO_TREE_EXPIRY=6144` (~102 min) against a 120-minute horizon means _no_ coin can ever clear it. Falls back to the best available and reports it through `clearedHorizon`, which the caller logs |
| Reserve what is about to be spent                      | `reservations.ts`       | funding pins its inputs so the renewal settle cannot take them mid-send; arkd would otherwise fail whichever loses with `VTXO_ALREADY_SPENT`. Process-local and in-memory on purpose: a reservation describes work in flight in _this_ process, and persisting it would let a stale pin outlive the crash that stranded it                                                                                                                                                                                      |
| Read through `getSpendableVtxos`, never `getVtxos`     | `receive/fundLockup.ts` | the ungated read fed to `sendBitcoin({ selectedVtxos })` bypasses the generic-spending gate — which here would mean funding one lockup out of another live lockup's escrow                                                                                                                                                                                                                                                                                                                                      |
| Pool target = `maxExposedSats / maxSats`               | `poolTarget`            | the concurrency the exposure cap already permits, so the shape tracks existing config instead of adding a knob. Two rungs, small-heavy: a small piece is usable by every swap, a large one only by large swaps, and funding composes                                                                                                                                                                                                                                                                            |

**Both receive corridors share one funding path** (`receive/fundLockup.ts`).
They did not always: the onchain leg called `wallet.send` while the Lightning
leg applied these rules, and regtest cannot tell the two apart — where no coin
clears the horizon, the wrong selection returns the same coin as the right one.
Only mainnet would have.

`planPool` is **never acted on automatically**. `balances` prints the current
shape and what it is short of; `pool` prints the same and, with `--mint`,
executes it — one Arkade transaction paying the solver's own address the
planned pieces, so N pieces cost one transaction and no intent fee (settling
would charge per input to reshape a float that is already spendable).

Minting is a command rather than a watch-loop job because the hazard is a
_concurrent provider_: funding pins its inputs in a process-local ledger, so a
mint run from a second process cannot see what a running provider reserved and
can spend a coin out from under an in-flight funding. Non-terminal rows are the
only shared signal, so `--mint` refuses while any exist — a loose proxy, since
a `quoted` row has reserved nothing, which is why `--force` exists for an
operator who knows no provider is running. Liveness itself is not detectable:
`watch` and `serve` leave no heartbeat.

### Transport, cadences and retry budgets

**Invariant** throughout.

| Constant                                                       | Value                                             | Where                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOT_TICK_MS`                                                  | 250 ms                                            | `packages/solver-app/src/cli.ts` — states where we have already paid and are exposed until we claim                                                                                                                                                                    |
| `FULL_SWEEP_MS`                                                | 3000 ms                                           | `packages/solver-app/src/cli.ts` — waiting on a client's funding, a human action minutes wide                                                                                                                                                                          |
| `REFUND_SWEEP_MS`                                              | 60,000 ms                                         | `packages/solver-app/src/cli.ts` — deadlines are hours out and mature against the chain tip, so sweeping faster only produces rejected pushes                                                                                                                          |
| `VTXO_LIFECYCLE_MS`                                            | 300,000 ms                                        | `packages/solver-app/src/cli.ts` — the solver's own coins, days from expiry; a missed pass is harmless                                                                                                                                                                 |
| `RELAY_HEARTBEAT_MS`                                           | 10,000 ms                                         | `packages/solver-app/src/cli.ts` — what refreshes `RELAY_HEALTH_PATH`'s mtime                                                                                                                                                                                          |
| `poll` default `intervalMs`                                    | 2000 ms                                           | `packages/solver-core/src/util/poll.ts`. A probe that _throws_ costs an attempt and the loop continues — these loops run in the window where we have paid and not yet claimed, so one dropped packet must not abandon the claim. A probe that means it throws `GiveUp` |
| `cli test-refund` budgets                                      | 30 attempts (lockup), then 6 × 30 s (refund push) | few on purpose: every rejected push writes an error line in the emulator operator's log, and the refund leaf has no expiry — a later run costs nothing                                                                                                                 |
| `DEFAULT_RECONNECT_MS` / `DEFAULT_MAX_RECONNECT_MS`            | 1000 / 30,000 ms                                  | `packages/solver-arkade/src/arkade/lockupWatcher.ts`, doubling backoff                                                                                                                                                                                                 |
| relay reconnect delays                                         | `[1000, 2000, 4000, 8000, 16000]` ms              | `packages/solver-transport/src/relay/connection.ts`                                                                                                                                                                                                                    |
| `STABLE_CONNECTION_MS`                                         | 10,000 ms                                         | how long a socket must hold before the backoff is earned back; anything shorter is flapping, and flapping must escalate rather than reset                                                                                                                              |
| `DEFAULT_MAX_REPLAY_MS`                                        | 120,000 ms                                        | subscription replay bound after reconnect. Shorter than any quote's validity — an older request has no live client behind it                                                                                                                                           |
| `RESUME_OVERLAP_MS`                                            | 1000 ms                                           | margin subtracted from the high-water mark on resume. Redelivery is cheap (idempotency is a property of the payload); a gap is a lost request                                                                                                                          |
| `MAX_PENDING_EVENTS`                                           | 256                                               | publish queue during a reconnect window; overflow drops the **oldest**                                                                                                                                                                                                 |
| `MAX_FRAME_CHARS`                                              | 32,768                                            | `packages/solver-transport/src/relay/nostr.ts` — checked before anything is parsed, so a hostile megabyte tag array is not JSON-parsed and SHA-256'd first                                                                                                             |
| `NOSTR_KIND_DIRECTED` / `NOSTR_KIND_BROADCAST`                 | 4859 / 4860                                       | provisional kind numbers, `docs/rfq-protocol.md` § 3.1                                                                                                                                                                                                                 |
| `BID_VALIDITY`                                                 | 5 min                                             | `packages/solver-core/src/core/openRfq.ts` — short because every unexpired bid is a standing cap on our directed quotes                                                                                                                                                |
| `OPEN_RFQ_MAX_AGE_MS`                                          | 60,000 ms                                         | broadcast freshness filter; without it, replay after a reconnect would have us bidding on the relay's whole backlog                                                                                                                                                    |
| `MAX_RELAYS`                                                   | 8                                                 | `packages/solver-core/src/core/registryCard.ts`, mirroring the registry schema's bound                                                                                                                                                                                 |

## What the deployment stack must satisfy

These are not our numbers, and none of them is configurable here — but each
one breaks a deployment, and two fail late rather than at startup. Verified by
reading the pinned SDK bundle (`node_modules/@arkade-os/sdk/dist/chunk-DVOQZAAX.js`),
not from documentation. Full walkthrough: `docs/runbook.md` § "Why the stack
needs those overrides".

**The checkpoint exit delay floor is the one most likely to surprise a
production deployment.** `Wallet.create` resolves a policy and throws
`ServerResponseMismatchError` if the server's advertised checkpoint tapscript
is below it:

| Network                       | Floor               | Constant                                    |
| ----------------------------- | ------------------- | ------------------------------------------- |
| regtest (`bech32 === 'bcrt'`) | **1200 s**          | `REGTEST_MIN_CHECKPOINT_EXIT_DELAY_SECONDS` |
| every other network           | **86,400 s (24 h)** | `DEFAULT_MIN_CHECKPOINT_EXIT_DELAY_SECONDS` |

The comparison is a strict `<`, so exactly 1200 (or exactly 86,400) passes.
Off regtest the policy additionally sets `requireSeconds: true`, so a
block-typed timelock is rejected before the floor is even reached. The
regtest/non-regtest branch is chosen from the locally pinned network, not from
server data, so the permissive branch cannot be selected by the operator.

On regtest that means **`ARKD_CHECKPOINT_EXIT_DELAY=1536`, not 1200**: BIP68
encodes in 512s units, so 1200 is representable only as `floor(1200/512) = 2`
units = 1024 s, which is under the floor. 1536 = 3 × 512 is the smallest
multiple of the granularity that clears it.

**The batch-expiry floor is checked at settle, not at startup.**
`Wallet.create` only _pins_ the policy; the assertion fires per round inside
the `onBatchStarted` handler reached from `wallet.settle()`. A too-small value
therefore brings the stack up perfectly happily and only fails once funds are
actually settled.

| Network             | Floor        | Constant                           |
| ------------------- | ------------ | ---------------------------------- |
| regtest             | **6000 s**   | `REGTEST_MIN_BATCH_EXPIRY_SECONDS` |
| every other network | **86,400 s** | `DEFAULT_MIN_BATCH_EXPIRY_SECONDS` |

Hence **`ARKD_VTXO_TREE_EXPIRY=6144`** on regtest. There is also a third,
stricter check that applies on _every_ network including regtest: when the
server advertises a `vtxoTreeExpiry`, the batch expiry must **equal** it
exactly. There is no separate minimum on `vtxoTreeExpiry` itself.

Three more stack requirements, all covered in the runbook:

- **everything denominated in seconds, not blocks.** Upstream flipped the
  stack's defaults to block counts; `deriveUnilateralDelays` hard-rejects
  anything below 512 as a block count, so the service dies at wallet
  construction — before any swap runs
- **`COVCLAIMD_IMAGE` must be set explicitly** — `regtest.mjs` silently drops
  covclaimd from the stack when it is unset. No error; the container is not there
- **the operator's intent-fee policy affects renewal.** arkade-regtest
  configures `ARK_OFFCHAIN_INPUT_FEE="amount * 0.01"`, so every settlement
  costs 1% of each input. The SDK's own `IVtxoManager.renewVtxos` implies a
  zero fee and arkd rejects the intent outright with
  `INTENT_INSUFFICIENT_FEE`, so `renewExpiringVtxos` replaces it and prices the
  output the way `Wallet.settle()` does. This is **operator policy, not a
  regtest quirk** — any mainnet operator charging a non-zero intent fee breaks
  `renewVtxos` the same way. See `docs/runbook.md` § "Operating notes"

## Client-facing vocabulary

The API, and anything a client can observe, uses only generic terms: `swap`,
`lockup`, `claim`, `refund`, `timeout`, "the swap provider". Which Lightning
implementation sits behind the port is an implementation detail of this
service; it stays behind `packages/solver-rails-lnd/` and out of state names,
error codes and log lines.

## The preimage is not ours to hold (receive leg)

`covclaimd` is a **separate service**. The wallet seals `(preimage,
destination)` to it directly, and this service never offers an endpoint that
accepts a preimage from a client. The provider only ever sees a preimage once
it appears in a claim witness — after the Arkade side is already funded.

## Known limits

Stated in full in `docs/environment.md` § "Known trust assumptions and limits":
no server-independent claim implemented yet (the leaf exists; the unroll flow
is TODO — a censoring Arkade server after payment is the one unmitigated loss);
covenant refunds eventually need the Arkade server and emulator both alive; a
truly-failed payment can sit `pending` for an operator (deliberate allowlist).

Two more, current as of the receive corridors going live:

- **covclaimd is deliberately not wired.** Both receive orchestrators take it as
  an optional dependency and `createServices` leaves it unset:
  `covclaimd:v0.0.1-rc.1` accepts a reveal with HTTP 200 and then silently never
  claims (observed on regtest 2026-08-07). Without it the client claims its own
  lockup holding the covenant's `receiver` key, so the cost is the client needing
  to be online — not correctness. Wiring a component that fails silently would be
  worse than not wiring it.

  The cause is now known and fixed upstream: `rc.1` matched the v1 preimage
  condition against our `ScriptV2` taptree, so its claim closure never matched.
  `v0.0.1-rc.3` carries the v2 form (and a separate taptree-binding fix from
  `rc.2`), and the runbook's stack commands pin `rc.4`.

  **The live claim has now been watched**, which was the standing precondition
  here: `test/e2e/covclaimdClaim.e2e.test.ts` claims a real lockup against a
  running `rc.4`, and `receiveLightningEdges.e2e.test.ts` drives a whole receive
  swap to `settled` on covclaimd's own claim with the client never acting. What
  keeps this unwired is therefore the wiring work itself, no longer doubt about
  the daemon. See `docs/runbook.md` § covclaimd.

- **Nothing shapes the float automatically.** `planPool` reports what the pool is
  short of; minting the pieces is still manual. Since funding pins the coins it
  spends, a float of one coin serves one swap at a time however many sats it
  holds.
