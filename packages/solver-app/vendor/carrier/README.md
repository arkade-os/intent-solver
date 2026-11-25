# Vendored Taxi packages

The root `package.json` overrides resolve these names to the archives here until the Taxi publishes
them. A frozen install refuses any archive whose bytes differ from the `integrity` in
`pnpm-lock.yaml`, which is the sha512 below. Each pins `@arkade-os/sdk` 0.5.14, the npm release the
workspace pins, so one SDK copy is linked.

| Archive                                   | Source                                                           | sha256                                                             | sha512 (lockfile `integrity`)                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `arkade-taxi-client-1.1.3-11bfa10e.tgz`   | ArkLabsHQ/arkade-taxi `11bfa10eb165f60a493055016d4e226f028378df` | `4d4a39ab4f79430a98d25f2e0ee3bc05b0e9188ca8d307c3d084efa0800cae5f` | `sha512-3Kc4P5r1i4bBbzeKKwd/TNqHkfQB5O7z15eXBLjtEjXacw2cNHfmyrm855XVdYU5nB2TKY5+CBP4iP8P39QUuQ==` |
| `arkade-taxi-covenant-1.1.3-11bfa10e.tgz` | ArkLabsHQ/arkade-taxi `11bfa10eb165f60a493055016d4e226f028378df` | `4d2c8b8e1402a03749da1a158c9d0340c8ced3c616f28c4fb481af0ddf63b95e` | `sha512-54hPzNWhm20jJNm0qFQzrV1pM69jrLQtwsbuStVz+ZjGSLuQ7OW9AFKjrM57kyXVGg2LCIyArzArjIxktyFzeg==` |
| `arkade-taxi-protocol-1.1.3-11bfa10e.tgz` | ArkLabsHQ/arkade-taxi `11bfa10eb165f60a493055016d4e226f028378df` | `320f1c525f647dea8ed4a596e93e1b4f52d6cc5905e1dfcedb8da3a59075efba` | `sha512-nG5KpHlD1US+xqeYJ2GGF3AO/5ZkyiRuM7/w5i6j6DDht/kCy4Ci3TtlI4cvuQgNVIRgvaGjF5KjzZXT0IRA8w==` |

The Taxi commit is the merge of ArkLabsHQ/arkade-taxi#50, which cut 1.1.3; the Taxi repository has
no tags.

Check an archive:

```sh
sha256sum packages/solver-app/vendor/carrier/*.tgz
openssl dgst -sha512 -binary <archive> | base64   # prefix sha512-, compare with pnpm-lock.yaml
```
