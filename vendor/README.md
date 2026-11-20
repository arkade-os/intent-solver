# Vendored packages

`arkade-os-swap-0.1.10-pr1262-9fed5a9.tgz` was built with `pnpm pack` from
[`arkade-os/ts-sdk#1262`](https://github.com/arkade-os/ts-sdk/pull/1262) commit
`9fed5a98`. It carries `asset-swap-directed`, the directed covenant whose
`fulfill` leaf needs the quoting solver's signature, which no published
`@arkade-os/swap` has yet. The root pnpm override makes every workspace package
use this build without publishing a `file:` dependency from a package.

Replace it with `@arkade-os/swap` 0.1.11 from npm once that is released: drop
this directory, the override, the `COPY vendor` in
`packages/solver-app/Dockerfile` and `test/packaging/vendoredDependencies.test.ts`.
