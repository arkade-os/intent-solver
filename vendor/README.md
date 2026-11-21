# Vendored swap SDK

`arkade-os-swap-0.1.12-directed-nonce-ark-9d7636e7e545.tgz` was built with
`pnpm -C packages/swap pack` from the [SDK source commit](https://github.com/arkade-os/ts-sdk/commit/a9d6ab62adbae431bc45310fd5dce34a331e94d3).
The `packages/swap/src` diff from `bd6057c069a512e2ec4d60073e5349abc045a2c4`
has SHA-256 `9d7636e7e545dc69fd590ac63f71da7c29a534957a1d5b2acc7656e4789d2afd`.
The archive's SHA-256 is
`2750e0c8a5d0053da5d011484832dbc256fdec6ea5120323d8e53fba2ecda001`.

It supplies `asset-swap-directed-nonce` while the SDK fix is unpublished.
When a published version includes the fix, update the swap dependency pins,
remove the root override and `COPY vendor` in the Dockerfile, and regenerate
the lockfile.
