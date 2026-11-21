# Vendored swap SDK

`arkade-os-swap-0.1.12-repeat-asset-rfq-5ca2e1c28303.tgz` was built with
`pnpm -C packages/swap pack` from the [SDK source commit](https://github.com/arkade-os/ts-sdk/commit/131e5b4e425a68e8a0a658a356d1cf73c3f237c5).
The `packages/swap/src` diff from `bd6057c069a512e2ec4d60073e5349abc045a2c4`
has SHA-256 `5ca2e1c283031be685e1fc27c43a333991fc984a9c62a79cb7d389dfe472f68d`.
The archive's SHA-256 is
`f4fc5f37c185b2c4b6327f53445fe15f258347dbc47830ca15d7a3ab2ffb2d76`.

It supplies `asset-swap-directed-nonce` while the SDK fix is unpublished.
When a published version includes the fix, update the swap dependency pins,
remove the root override and `COPY vendor` in the Dockerfile, and regenerate
the lockfile.
