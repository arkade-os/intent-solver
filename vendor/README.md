# Vendored packages

Both archives were packed from
[`arkade-os/ts-sdk#1298`](https://github.com/arkade-os/ts-sdk/pull/1298) at commit
`d8f39ee028dda771e4be3a9db310a9c31b9b79cc`. That head stacks #1298 on #1297, #1296
and #1221. It carries `asset-swap-directed-nonce-v2`, which no published
`@arkade-os/swap` has.

| Archive                              | Package                  | SHA-256                                                            |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------------ |
| `arkade-os-sdk-pr1298-d8f39ee0.tgz`  | `@arkade-os/sdk` 0.5.14  | `069552ec3c08d4b2a3ffbad3ae13fd77f0471531f7f0b59420b0da29ad420edb` |
| `arkade-os-swap-pr1298-d8f39ee0.tgz` | `@arkade-os/swap` 0.1.16 | `714ac307ed82fc3aa8fc2317f920768beeb16100f24b6ea71ed5193c027da5a2` |

npm's 0.5.14 and 0.1.16 are different builds under the same versions. The root
pnpm overrides make every workspace package, and swap itself, resolve these two,
so one SDK and one swap are installed. The Docker build copies this directory
before its frozen install.

To regenerate, check out that commit and run `corepack pnpm install` and
`corepack pnpm -r build`. Then run `npm pack --ignore-scripts` in `packages/sdk`
and `corepack pnpm pack` in `packages/swap`: pnpm rewrites swap's `workspace:*`
SDK dependency to `0.5.14`, and npm leaves it as is. Rename the archives as
above and update their hashes here.

Replace them with registry releases once the stack ships. Drop this directory,
the overrides, the `COPY vendor` in `packages/solver-app/Dockerfile` and
`test/packaging/vendoredDependencies.test.ts`, then move the SDK and swap pins
and the lockfile together.
