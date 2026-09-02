# Packaging: two deployable sets from one workspace

This repo builds two independent solvers. Each is a subset of the eleven
LIBRARY packages, and each **builds with the other absent from its dependency
graph** — not merely unused, but not installed.

`.github/workflows/ci.yml` (`package-sets`) asserts the exact resolved set for
each, so a leak and an accidental removal both fail the build.

The twelfth package, `packages/solver-app`, is in neither set and is not a
library: it is the DEPLOYABLE — the composition root, the CLI, the admin
console and the Dockerfile that bundles them. It is `private: true`, so the
release workflow's `./packages/*` publish glob passes it over, and
`test/packaging.test.ts` pins that rather than trusting it.

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
lives at the composition root (`packages/solver-app/src/ops/corridorSet.ts`),
because naming every corridor a deployment might register is the property of the
thing that configures it — not of the RFQ dispatcher, and not of another
corridor package.

## Splitting into repos

Reusable unchanged — neither names a package:

- `packages/solver-app/Dockerfile` — copies `packages/`, installs, builds, runs
  `packages/solver-app/dist/cli.js`. Its build CONTEXT is the repo root even
  though it lives in the package (`docker build -f packages/solver-app/Dockerfile .`):
  a pnpm workspace image needs the lockfile, the workspace manifest and every
  `packages/*`.
- `ci.yml`'s `build` and `docker` jobs.

Needs per-repo work:

- **Composition root.** `packages/solver-app/src/ops/services.ts` is where the
  built-in rails are named, and a repo drops the ones it does not ship from that
  one file; `config.ts`'s `BUILT_IN_LN_BACKENDS` and `ops/rails.ts`'s `BUILT_IN`
  — both in the same package — list the same set and have to agree with it. A
  rail a consumer registers needs none of this — see "Extending, rather than
  forking" — so this is only about what the repo itself ships. `cli.ts` reaches
  past the composition root for exactly one, `@arkade-os/solver-rails-fake` for
  the `invoice` regtest helper, so a repo that ships no fake backend has that
  call site to answer for too.
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
exists (`packages/solver-app/src/ops/rails.ts`). A rail is a PAIR — one wallet
answering both the Lightning and the onchain port — so a vendor with no onchain
facility still answers that port with a backend that refuses, rather than
leaving two corridors unservable. Registration is module-level state read once
at `loadConfig`, so it has to happen at import time, above the entrypoint; and a
name already taken, built-in or not, is refused at registration rather than
silently shadowed.

`test/packaging/corridorInjection.test.ts` and `sdkSurface.test.ts` pin this.

## Publishing

Not published yet. The eleven library packages carry a full publish manifest —
`exports`, `files`, `publishConfig` — and `release.yml` resolves a `--dry-run`
publish for them on every release so a rotted manifest is caught while it is
cheap; the real publish is held behind a manual input, because the names are
unclaimed on npm and a first publish cannot be undone. `workspace:*` resolution
is the only consumer today.

`packages/solver-app` is excluded from all of that by `private: true`, and
always will be: it is the deployable, its artifact is the GHCR image, and there
is no version of it anyone should `npm install`.

When the library packages do ship, the decision on record is **`@arkade-os/*` on
GitHub Packages**, private first: it is tied to the org that owns the repos,
needs no npm org billing, and going public later is a registry change rather than a
rename.
