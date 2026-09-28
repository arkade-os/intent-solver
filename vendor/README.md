# Vendored SDK for PR #219

`arkade-os-sdk-pr991-fed105ce.tgz` is a packed build of `@arkade-os/sdk` from
`arkade-os/ts-sdk` PR #991 at commit `fed105ced11012c7e2a68725da0eef97f0876ee6`.
SHA-256: `fc7eca505b8077ccc9db128641151633412569e9cb2843fadfc3d28cdd567598`.

The root pnpm override makes the solver and its transitive dependencies use one
SDK copy. The Docker build copies this directory before its frozen install.

To regenerate, build that SDK commit and run `npm pack --ignore-scripts` from
`packages/ts-sdk`, then replace the archive and update its hash here. When the
changes ship on npm, remove this archive and override, then update the SDK
dependency and lockfile together.
