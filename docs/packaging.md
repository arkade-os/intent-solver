# Packaging: two deployable sets from one workspace

This repo builds two independent solvers. Each is a subset of the eleven
workspace packages, and each **builds with the other absent from its dependency
graph** — not merely unused, but not installed.

`.github/workflows/ci.yml` (`package-sets`) asserts the exact resolved set for
each, so a leak and an accidental removal both fail the build.

## The sets

| Set                      | Packages                                                                                      | Absent                  |
| ------------------------ | --------------------------------------------------------------------------------------------- | ----------------------- |
| **EVM** — arkade ↔ ERC20 | `core` `arkade` `db` `rails-evm` `corridors-evm` `transport`                                  | every Lightning package |
| **LND** — LN + onchain   | `core` `arkade` `db` `rails` `rails-esplora` `rails-lnd` `rails-fake` `corridors` `transport` | EVM                     |

Build one on its own:

```sh
pnpm --filter "@arkade-os/solver-corridors-evm..." --filter "@arkade-os/solver-transport..." build
```

The `...` suffix means "and its dependencies", so the scope pnpm reports IS the
closure. `pnpm <filters> list --depth -1 --parseable` prints it without building.

## Why the sets hold

Two different contracts, and both are enforced:

- **Import direction** — `test/boundaries.test.ts`. A layer DAG (`core` ← `rail`
  ← `corridor` ← `transport`), checked across relative imports _and_ package
  specifiers. One vendor rail may never reach another's modules.
- **Declared dependencies** — the `package-sets` CI job. The boundary test would
  pass while a `package.json` declared a dependency it never imported, and a
  stray dependency is what puts another vendor's source in a partner's checkout.

`@arkade-os/solver-transport` depends on `@arkade-os/solver-core` alone. Corridor registry assembly
lives at the composition root (`src/ops/corridorSet.ts`), because naming every
corridor a deployment might register is the property of the thing that
configures it — not of the RFQ dispatcher, and not of another corridor package.

## Splitting into repos

Reusable unchanged — neither names a package:

- `Dockerfile` — copies `packages/`, installs, builds, runs `dist/cli.js`.
- `ci.yml`'s `build` and `docker` jobs.

Needs per-repo work:

- **Composition root.** `src/ops/services.ts` is where the built-in rails are
  named, and a repo drops the ones it does not ship from that one file;
  `src/config.ts`'s `BUILT_IN_LN_BACKENDS` and `src/ops/rails.ts`'s `BUILT_IN`
  list the same set and have to agree with it. A rail a consumer registers needs
  none of this — see "Extending, rather than forking" — so this is only about
  what the repo itself ships. `cli.ts` reaches past the composition root for
  exactly one, `@arkade-os/solver-rails-fake` for the `invoice` regtest helper, so a repo
  that ships no fake backend has that call site to answer for too.
- **README and runbook.** Both are deployment documents and heavily
  backend-specific; each repo keeps only the backends it ships.
- **`package-sets` CI job.** Collapses to the single set that repo contains.

## Extending, rather than forking

A consumer defines a corridor and hands it to the shipped daemon:

```ts
import { createServices, createCorridorSet } from '@arkade-os/solver-...'

const services = await createServices(config, { corridors: [myCorridor] })
```

It joins the registry beside the built-ins — same sweep, same ingress, same
status route. Consumer corridors go through `createCorridorSet`, so a pair or
env-stem colliding with a built-in is refused at composition rather than
shadowing it at dispatch. They are not subject to `corridorEnabled`, which is
keyed by the closed union of built-in pairs.

A BTC **rail** goes the same way, but through a name rather than an object:

```ts
import { registerLightningRail } from '@arkade-os/solver-...'

registerLightningRail('my-rail', { create: async (config) => ({ ln, onchain }) })
```

`LN_BACKEND=my-rail` then selects it, because `loadConfig` asks the registry what
exists (`src/ops/rails.ts`). A rail is a PAIR — one wallet answering both the
Lightning and the onchain port — so a vendor with no onchain facility still
answers that port with a backend that refuses, rather than leaving two corridors
unservable. Registration is module-level state read once at `loadConfig`, so it
has to happen at import time, above the entrypoint; and a name already taken,
built-in or not, is refused at registration rather than silently shadowed.

`test/packaging/corridorInjection.test.ts` and `sdkSurface.test.ts` pin this.

## Publishing

Not published. The packages are `private: true` under the `@arkade-os/solver-*` scope,
which is a workspace-local name — `workspace:*` resolution is the only consumer.

When that changes, the decision on record is **`@arkade-os/*` on GitHub
Packages**, private first: it is tied to the org that owns the repos, needs no
npm org billing, and going public later is a registry change rather than a
rename.
