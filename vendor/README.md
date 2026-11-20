# Vendored packages

`arkade-os-swap-0.1.9-pr1257-10215ea.tgz` was built with `pnpm pack` from
[`arkade-os/ts-sdk#1257`](https://github.com/arkade-os/ts-sdk/pull/1257) commit
`10215eab`. It carries `asset-swap-v4`, the directed covenant whose `fulfill`
leaf needs the quoting solver's signature, which no published `@arkade-os/swap`
has yet. The root pnpm override makes every workspace package use this build
without publishing a `file:` dependency from a package.

Replace it with the registry release once #1257 ships: drop this directory, the
override, the `COPY vendor` in `packages/solver-app/Dockerfile` and
`test/packaging/vendoredDependencies.test.ts`.
