# Vendored SDK for PR #219

`arkade-os-sdk-pr991-9c3445b3.tgz` is a packed build of `@arkade-os/sdk` from
`arkade-os/ts-sdk` PR #991 at commit `9c3445b30a4a2f784cae8f499bbd4b34d1b3ae6b`.
SHA-256: `7534640b65bc97cc391eab24c8673a7ac2f5340ee4448f1eec01fe908895b0ea`.

The root pnpm override makes the solver and its transitive dependencies use one
SDK copy. The Docker build copies this directory before its frozen install.

To regenerate, build that SDK commit and run `npm pack --ignore-scripts` from
`packages/ts-sdk`, then replace the archive and update its hash here. When the
changes ship on npm, remove this archive and override, then update the SDK
dependency and lockfile together.
