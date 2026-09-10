# Vendored packages

Pre-release builds of packages this repo consumes, pinned here so a branch can
be tested against an upstream change before it is published.

**Nothing here is a substitute for a release.** A vendored tarball is a way to
run the tests; it is not something to merge into `main` with the pin still
pointing at it. Each entry below names what has to happen before that.

## `arkade-os-swap-3d92c04b.tgz`

|                |                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| package        | `@arkade-os/swap`                                                                                              |
| built from     | `arkade-os/ts-sdk` commit `3d92c04b`                                                                           |
| that commit is | `feat/fill-offer` ([ts-sdk#785](https://github.com/arkade-os/ts-sdk/pull/785)) merged with `master` `67f12cdb` |
| sha256         | `a56afd0ecbc69f2a8ac809109f2ba4c3dba432a0f9bdde7c278fea4e7ea55f14`                                             |
| why            | `fillOffer` — the SDK's taker-side fill, which this repo implements separately as `fulfillOffer`               |

**Its manifest says `version: 0.0.14`, which is also the published version this
repo pinned before.** The version string cannot tell you which one is installed,
so the file is named by commit instead. If you need to know what is actually
resolved, read `node_modules/@arkade-os/swap/package.json` and look for
`fillOffer` in its `dist/index.d.ts` — the published 0.0.14 does not export it.

**Before this can merge with the pin in place, ts-sdk#785 has to land and ship.**
The pin then goes back to a registry version and this file is deleted. A
squash-merge will not preserve `3d92c04b`, so do not expect to resolve that sha
afterwards — it is recorded to say what was tested, not as something to fetch.
