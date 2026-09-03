# Authoring: what it costs to build a solver, measured

A decision record, not a how-to. The how-to is
[`docs/repos/intent-solver/building-a-corridor.md`](repos/intent-solver/building-a-corridor.md)
and the runnable one is [`examples/corridor-host.mjs`](../examples/corridor-host.mjs).

This exists because "make building a solver more fluent" is a request that
usually gets answered with a builder or a DSL, and the answer here turned out to
be different. The counts below are why.

Two questions wear that request. **Extending** the shipped app with a corridor or
a backend — measured first. And **writing the app itself** in code rather than in
an environment — measured in "The solver as a value", further down. They have
different answers, and only one of them has a gap.

## The measured cost

Four different jobs wear the word "corridor", and they cost wildly different
amounts. Conflating them is what makes the framework look heavier than it is.

### Registering a corridor from outside — **one call**

```ts
const services = await createServices(config, { corridors: [myCorridor] })
```

`packages/solver-app/src/ops/services.ts:255` takes the option;
`ops/corridorSet.ts:87` routes it through `createCorridorSet`, so a pair or stem
that collides with a built-in is refused at composition rather than shadowing it
at dispatch. **Zero host edits.**
`test/corridors/corridorInterface.test.ts:140-247` calls that the acid test and
proves it: a corridor with its own pair, stem, state vocabulary and payload
shape quotes, ticks, pages and reports detail with no change under
`solver-core/core/`, `solver-app/admin/` or `solver-transport/ingress/`.

### Registering a backend from outside — **one call**

```ts
registerLightningRail('my-rail', { create: async (config) => ({ ln, onchain }) })
```

`packages/solver-app/src/ops/rails.ts:108`. `loadConfig` admits the name because
it asks `lightningRailNames()` what exists, so `LN_BACKEND=my-rail` is the whole
of the operator's side. `test/packaging/railInjection.test.ts` pins every leg of
that, including the one that is easy to lose: `config.ts` must READ the registry
or the seam exists and is unusable (`railInjection.test.ts:136-140`).

Both seams are already as thin as a seam gets. Neither is where the cost is.

### Adding a built-in corridor to THIS repo — **23 files**

`grep -rln 'ONCHAIN_RECEIVE|onchainReceive|OnchainReceive' packages/*/src`
returns 23 files across six packages for `onchain:BTC->arkade:BTC`, the most
recent member of the closed union. The heaviest concentrations are
`ops/services.ts` (28 references), `admin/routes/status.ts` (9) and
`ops/refunds.ts` (9). Joining the union in
`solver-core/core/corridorPolicy.ts:12-17` is what pulls in the rest: the
`Record<Corridor, …>` tables in `config.ts`, the admin settings grid, the CLI's
served-corridor list.

### Adding a corridor FAMILY as its own package — **11 files, 4 touched**

`packages/solver-corridors-evm/src` is 11 modules, and it reaches the deployable
through exactly four files: `cli.ts`, `config.ts`, `ops/corridorSet.ts`,
`ops/services.ts`. It deliberately stayed OUT of the closed union — its pair
carries a token address, so `EvmCorridor` is a template-literal type
(`corridorPolicy.ts:52`) rather than a member — and out of `ALL_DESCRIPTORS`.

That is the shape the framework is actually optimised for, and the numbers say
it works: a family of corridors for a chain this repo had never served cost four
edits at the composition root and nothing anywhere else.

## Where the repetition is

Not in registration. In the two things every corridor implements after it.

**`tickAll`, six times.** `send/onchainOrchestrator.ts:378`,
`receive/orchestrator.ts:537` and `receive/onchainOrchestrator.ts:412` are the
same 27 lines including the same comment paragraph. `send/orchestrator.ts:579`
diverged into a bounded-concurrent version (`driveRows`, line 605).
`solver-corridors-evm/src/send/evmOrchestrator.ts:595` and
`receive/evmOrchestrator.ts:477` are 14 lines that dropped the
`shouldSkipTick`/`inFlight` guard and the `onTickSuccess` call entirely —
`grep -c shouldSkipTick` is 0 in both EVM orchestrators and ≥2 in all four
built-ins. `core/corridor.ts:172-186` predicted this in as many words: "a naive
loop here would quietly drop all four."

So the copy-paste has already cost something real. It is recorded here as a
finding rather than fixed, because fixing it changes EVM sweep behaviour and
this work is additive by remit.

**The reader half, twice.** `corridors/adapters.ts:79-115` (`readerFor`) and
`corridors/evmCorridors.ts:139-170` (`evmReaderFor`) differ in two lines:
`findRecoverable` vs `findLive`, and whether `statusFor` can answer. Six of a
corridor's eleven required members are that function.

**The stub, five times.** `corridorInterface.test.ts:16` and `:157`,
`corridorInjection.test.ts:28`, `sdkSurface.test.ts:91` and `:136` each hand-roll
a `Corridor` whose only interesting member is `quote`.

## What an author must get right that nothing checks

Every item below is stated in a docstring and enforced nowhere.

| Obligation                                                                         | Where it is stated              | What silently happens                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| `exposed` is a subset of `live`                                                     | `corridorDescriptor.ts:47`      | Checked at `registry.test.ts:103` — but only over the four built-in descriptors  |
| `payoutRail` names a rail that exists                                                | `corridorDescriptor.ts:19-29`   | Console reads UNKNOWN forever (`rail.ts:69`); no boot-time complaint             |
| `liveLockups` present whenever the corridor HOLDS lockups                            | `corridor.ts:118-135`           | Renewal protection and the recovery path are lost for every one of them          |
| `statusFor` answers `null` — never a refusal — for an id it does not hold            | `corridor.ts:100-103`           | Ends the fall-through and hides a live swap belonging to the NEXT corridor       |
| `tickAll` honours the skip guard, the backoff and per-row isolation                  | `corridor.ts:172-186`           | A failing backend is hammered; one row's throw ends the sweep                    |
| `registerLightningRail` runs before `loadConfig`                                     | `rails.ts:29-31`                | `LN_BACKEND` refuses a rail that is registered — the registry is read once       |

One of these is worse than unchecked. `building-a-corridor.md:129-130` tells an
author to use the SHARED `AdmissionControl` "or your corridor is uncapped while
every other one is not" — and through the `createServices` seam there is no way
to receive it. The instance is constructed at `ops/services.ts:298`, after
`opts.corridors` has already been built by the caller, and it is absent from the
exported `Services` interface. A consumer can only construct their own, which is
a second cap rather than a share of the one. Reachable today only by building the
host yourself with `buildApp`, where you own every object.

## The solver as a value

The other question: not "how do I add a corridor to your app" but "how do I write
_my_ app". The answer is that almost all of it already works, and that this is
invisible from outside.

**A deployment is a plain object.** `Config` is an exported interface
(`config.ts:68`) of thirty required fields, and every one of them is writable as
a literal. `test/packaging/appInjection.test.ts` writes a whole one using nothing
but `@arkade-os/solver-app/index.js` and no `process.env` at all; that file
compiling is the claim, which is why removing one field fails the typecheck
rather than a test.

**`loadConfig` is an adapter, not the gate.** It reads `process.env` 44 times
(`config.ts`, `loadConfig` at line 617) and returns exactly that interface. It is
one way to produce a `Config`. Nothing downstream asks where the object came
from.

**Corridors are a parameter, not a global.** `createServices(config, { corridors
})` (`services.ts:253-256`) takes both. There is no registry to mutate and no
ordering hazard — the contrast with the rail seam is sharp and deliberate, since
`registerLightningRail` writes module-level state that `loadConfig` reads once
(`rails.ts:29-31`), which is what forces a consumer's entrypoint to register
above the import.

**A solver with its own corridors needs no rail at all.** `services.ts:328` is
`config.lnBackend === null ? null : await createRail(config)`. With the four
built-in corridors disabled, `lnBackend: null` is a supported deployment — so a
consumer serving their own corridors never touches the rail registry, never meets
its ordering hazard, and never needs a dynamic import to sequence one.

So the app is already describable in plain code:

```ts
const services = await createServices(myConfigLiteral, { corridors: [mine] })
const app = buildApp({ corridors: services.corridors, readers: services.readers, network: 'bitcoin' })
serve({ fetch: app.fetch, port: 8080, overrideGlobalObjects: false })
// ...and then?
await services.close()
```

### Except the loop

`watchUntilStopped` is a module-private `const` at `cli.ts:164-484` — 321 lines
carrying the boot recovery pass, four cadences (`HOT_TICK_MS` 250ms,
`FULL_SWEEP_MS` 3s, `REFUND_SWEEP_MS` 60s, `VTXO_LIFECYCLE_MS` 300s), the lockup
watcher, the contract lifecycle and the refund sweep. **`cli.ts` has zero
exports** and calls `main().then(() => process.exit(...))` at module load.

That is the whole of the dynamic-import dance, and it outlives the rail question:
`await import('@arkade-os/solver-app/dist/cli.js')` does not import the loop, it
RUNS THE CLI. There is no third option. A consumer who assembles everything above
gets a solver that quotes correctly and never advances a swap — which is worse
than one that fails, because it looks like it is working.

The minimum honest replacement is short, and
`appInjection.test.ts` runs it:

```ts
for (const corridor of services.corridors) driven += await corridor.tickAll()
```

That is the daemon's own recovery pass, verbatim. What it does not carry is the
cadences and the lockup watcher — so a swap waiting on FUNDING is noticed on the
next sweep instead of on the event, and the four different wait profiles collapse
into one. Those are policy; the line above is the contract.

`buildWorker` (`worker.ts:88`) is exported and is the other scheduler, but it is
not a way round this. It is Workers-shaped (`fetch`/`scheduled`/`queue`),
`WorkerDeps` (line 68) carries no `corridors` field, and its `scheduled` handler
names `deps.service` and `deps.onchainService` directly (lines 110-113) rather
than iterating the set — so an injected corridor is quotable through its `fetch`
and never driven by its cron. It also has no VTXO-lifecycle pass, which its own
module comment states as a decision rather than an omission.

Two smaller things sit in the same private file. `HONO_SERVE_OPTIONS`
(`cli.ts:563`) is `{ overrideGlobalObjects: false }`, and its comment records a
mainnet incident that read as a payment-provider outage for most of a day — a
consumer calling `serve()` themselves reproduces it unless they have read
`cli.ts`. `startAdminServer` (`cli.ts:581`) is likewise unreachable, so a
hand-built app has no console.

### What a hand-built `Config` gives up

`loadConfig`'s validation, all of it. Two that bite:

- **`lnBackend: null` with a BTC corridor enabled.** No rail is built, so that
  corridor is never constructed and its pair is refused as `unsupported_pair` by
  a solver whose operator believes it is serving. `loadConfig` refuses this
  combination; a literal does not.
- **`Record<Corridor, …>` cannot be written by name.** The entrypoint exports a
  `Corridor` — but it is the corridor PLUGIN interface from `core/corridor.ts`,
  while the key type is the closed pair union in `core/corridorPolicy.ts`, which
  is not exported at all. Two different types, one name.
  `Record<Corridor, number>` written against the exported one fails with
  `TS2344: Type 'Corridor' does not satisfy the constraint 'string | number |
  symbol'`. Writing the four pair strings as literal keys works, which makes this
  a discoverability trap rather than a wall.

`ArkadeWalletConfig`, `Fee`, `LndConfig`, `EvmCorridorPolicy` and `EvmMarket` are
unnameable from the entrypoint too. All are satisfiable structurally, so the cost
is that their required fields are discovered from compile errors rather than from
a type you can point at — `expectedArkdNetwork` is the one that bit here.

## The proposal

**No new API.** The seams are one call each and both are pinned by tests. A
builder over `createCorridorSet([mine])` would wrap a function call in a function
call, which this codebase's own comments repeatedly refuse — `corridor.ts:179`
turns down the host even SYNTHESISING `tickAll` ("Nor can the host synthesise
it… a naive loop here would quietly drop all four"), preferring an explicit
implementation to a generated one.

What is missing is smaller and duller than an API:

1. **The authoring guide is unreachable.** `building-a-corridor.md` is a good
   140-line guide with **zero inbound references** — nothing in the README, no
   docs index, no source comment, no test.
   `grep -rn 'building-a-corridor' .` returned nothing before this change. It
   sits in `docs/repos/intent-solver/`, a directory no workflow or script
   consumes. A guide nobody can find is indistinguishable from one nobody wrote,
   which is the shape `sdkSurface.test.ts:1-12` already describes for the
   exports: every one of them "were public within `src/`, and were exported from
   the package entrypoint by none of it."

2. **There is no runnable example for a solver author.** `examples/` is this
   repo's integration surface — typechecked in CI, and the one thing an
   integrator copies — and all three files in it are CLIENTS. The guide's closing
   advice is "copy those [tests] as the starting point," but a vitest file is not
   a program: it cannot be run, it cannot be hit with `curl`, and it does not
   show the host being started.

3. **The app-as-a-value path is undocumented and unpinned.** A `Config` literal,
   `createServices` as a parameter call, `lnBackend: null` — all supported, none
   written down anywhere, and nothing failed if one of them stopped working. The
   only worked example of an app is `cli.ts`, which is 1762 lines, exports
   nothing, and starts by reading the environment.

So: **a page that shows the call, a link to it, and worked examples that run.**

### What that came to

- `examples/lib/example-corridor.mjs` — every member of `Corridor` in plain
  code, over a Map, settling nothing. `examples/corridor-host.mjs` serves it
  through the shipped `buildApp` with no wallet, no database and no environment:
  `pnpm build && node examples/corridor-host.mjs`.
- `test/examples/exampleCorridor.test.ts` — drives that example through the real
  host, and asserts the obligations tabled above for it specifically, since
  `registry.test.ts` covers only `ALL_DESCRIPTORS`.
- `test/packaging/appInjection.test.ts` — a whole deployment written as a
  literal, the rail invariant a hand-built `Config` has to uphold itself, and the
  four-line sweep a consumer has to write because the shipped one is private.
  Sits beside `corridorInjection` and `railInjection` because it is the same
  genre of claim: this reaches the real thing.
- Inbound links from the README and from `building-a-corridor.md`, which now
  also points at the runnable example instead of at two vitest files.

No source under `packages/` changed. Nothing existing was re-signatured, and no
behaviour moved.

### The one change worth making next, not made here

**Extract `watchUntilStopped` out of `cli.ts` into `ops/watch.ts` and export it.**
It is the single thing standing between a consumer and an app they wrote
themselves, and it is why the dynamic-import pattern exists.

Not done in this pass for two reasons, both concrete. It is a 321-line move of
money-path scheduling, which wants its own change and its own baseline rather
than riding along with a docs pass. And it cannot be done the lazy way:
`index.ts` must not re-export from `cli.ts`, because `cli.ts` calls `main()` and
`process.exit()` at module load, and `ci.yml`'s "built entrypoint exports a usable
surface" step exists specifically to catch an edge back into it — importing the
SDK must never run the CLI.

## What this deliberately does NOT propose

- **A corridor builder / DSL.** Registration is `createServices(config, {
  corridors: [x] })`. Wrapping that adds a layer whose only content is the
  argument you already had.
- **A `defineSolver({ … })` / app builder.** `Config` is already a literal and
  `createServices` already takes it as a parameter; a builder over that would
  restate thirty fields in a second vocabulary and then have to be kept in step
  with the first. The missing piece is the loop, and a builder does not supply
  one.
- **A `configFrom(partial)` helper that fills in defaults.** Tempting after
  writing thirty fields by hand, and it would re-create the exact hazard
  `corridorDescriptor.ts:11-16` names: a field with a default is a question
  nobody is made to answer, and `maxExposedSats`, `corridorEnabled` and
  `lnBackend` are not questions to default. `loadConfig` is allowed to default
  them because an operator reading `README.md`'s settings table can see what it
  chose; a silent literal default cannot be read anywhere.
- **Re-exporting `HONO_SERVE_OPTIONS`.** Genuinely useful, and it belongs with
  the loop extraction rather than on its own — pulling one const out of `cli.ts`
  would mean `index.ts` importing from the module that runs `main()` at load.
- **A shared `tickAll` helper in core**, despite the six-way duplication and the
  measured EVM drift. Extracting it is a real improvement, but adopting it in the
  built-ins changes sweep behaviour on a money path and this work is additive by
  remit. Recorded above as a finding; it wants its own change with its own
  baseline.
- **A `readerFrom(store)` helper**, for the same reason at lower stakes: it would
  have exactly two in-repo call sites, and they already disagree about which
  query names the live set.
- **Widening `opts.corridors` to accept a factory** so a consumer corridor can be
  handed the shared `AdmissionControl`. This is the one place a signature change
  would genuinely buy something, and it is the one place this pass is not
  permitted to touch. Flagged above rather than silently left.
- **Runtime validation of the descriptor** (`exposed ⊆ live`, `payoutRail`
  resolves). Tempting, and wrong here: `corridorDescriptor.ts:11-16` records that
  the forcing function must stay a compile-or-author-time question, and a
  throwing validator at composition would take a whole deployment down over a
  console-bucketing mistake. The obligations are documented in the table above,
  where an implementer reads them.
