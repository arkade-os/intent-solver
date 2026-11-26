# Vendored Taxi packages

The root `package.json` overrides resolve these names to the archives here until the Taxi publishes
them. A frozen install refuses any archive whose bytes differ from the `integrity` in
`pnpm-lock.yaml`, which is the sha512 below. Each pins `@arkade-os/sdk` 0.5.14, the npm release the
workspace pins, so one SDK copy is linked. SDK 0.5.14 and swap 0.1.16 carry ts-sdk #1282, #1283 and
#1284, which earlier builds of this branch vendored as `0.5.14-taxi.1` / `0.1.16-taxi.1`.

| Archive                                   | Source                                                           | sha256                                                             | sha512 (lockfile `integrity`)                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `arkade-taxi-client-1.1.4-5df105e8.tgz`   | ArkLabsHQ/arkade-taxi `5df105e82f33a1c74a1d898c93356cb9a70150c7` | `0415203f0613d5e4494add128fccf15fdc746f999396d87b7ae2bfa5e6a75dfc` | `sha512-77ZpY/j58LT3arAYjc6nbzM1U2FBZvjllW3rB3KlmxJBIoTl4hsnfQIxCvvC3jOimemLwYVEVD/Fsg/lixc4+A==` |
| `arkade-taxi-covenant-1.1.4-5df105e8.tgz` | ArkLabsHQ/arkade-taxi `5df105e82f33a1c74a1d898c93356cb9a70150c7` | `c8f8d2e1752bff621caa6d16827382f1c0040c7d041258513cd907f1dcbb475f` | `sha512-7MFT18dqxpmxEm19RF61+OGzwrlB/wJ0pkkEfcfjSHsEvf/I5beBVIF3DLhXX/A5lsa3N8Y4be93uMN4q7lbOA==` |
| `arkade-taxi-protocol-1.1.4-5df105e8.tgz` | ArkLabsHQ/arkade-taxi `5df105e82f33a1c74a1d898c93356cb9a70150c7` | `5d04fd42d6ededac5c22720e1f1d58dd6f26c2aa77e889f2e472002c42115705` | `sha512-sHLPc/WL0Q9TyUthW2lZDkVOLiq3JntcrwRn5rUV7cPeBtXGwuwTCEPpDgAzEC4qzFyafk5IrQ2xsVxiXAfGCw==` |

The Taxi commit is the merge of ArkLabsHQ/arkade-taxi#51, which cut 1.1.4; the Taxi repository has
no tags.

Check an archive:

```sh
sha256sum packages/solver-app/vendor/carrier/*.tgz
openssl dgst -sha512 -binary <archive> | base64   # prefix sha512-, compare with pnpm-lock.yaml
```

Reproduce them from the Taxi commit:

```sh
git checkout 5df105e82f33a1c74a1d898c93356cb9a70150c7
pnpm install --frozen-lockfile && pnpm -r build
for p in client covenant protocol; do (cd packages/$p && pnpm pack --pack-destination "$OUT"); done
# then add the -5df105e8 suffix to each file name and compare sha256 with the table
```

A fresh rebuild matches all three. `pnpm pack` writes the client's two `@arkade-taxi` dependencies in
either order from run to run, so repack the client until it matches; both orders name the same
versions.
