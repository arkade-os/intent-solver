# vendor

A packed `@arkade-os/sdk` build, pinned here because the solver needs SDK changes
that are not on npm yet. Temporary by construction: when the SDK releases, delete
the tarball, drop the `pnpm.overrides` entry in the root `package.json`, and pin
the released version in the five packages that depend on it.

## Why an override rather than five dependency bumps

`@arkade-os/swap` depends on `@arkade-os/sdk` itself. Pointing only this repo's
packages at the tarball resolves **two** copies of the SDK — the vendored one for
us, npm's for `swap` — and the SDK's classes cross that boundary, so `instanceof`
stops working and module state is duplicated. The override applies to the whole
tree, transitive dependencies included, which is what keeps it to one copy.

Check it stayed one:

```
ls node_modules/.pnpm | grep arkade-os+sdk   # expect a single entry
```

## Regenerating

```
git -C <ts-sdk> switch master && git pull
pnpm install && pnpm -C packages/ts-sdk build
cd packages/ts-sdk && npm pack --ignore-scripts --pack-destination <here>
```

`--ignore-scripts` because the tarball is packed from an already-built `dist`;
without it `npm pack` reruns the workspace build and fails outside the monorepo.

Name the file for the commit it came from, and say so in the PR — a tarball whose
provenance is not written down cannot be audited or reproduced.
