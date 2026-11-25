# Vendored carrier cohort

The root `package.json` overrides resolve these names to the archives here until the cohort is
published. A frozen install refuses any archive whose bytes differ from the `integrity` in
`pnpm-lock.yaml`, which is the sha512 below.

| Archive                                     | Source                                                           | sha256                                                             | sha512 (lockfile `integrity`)                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `arkade-os-sdk-0.5.14-taxi.1-7584c23c.tgz`  | arkade-os/ts-sdk `7584c23ce08b974e0e5e8e7651f8b45399bee7d7`      | `6c42fc4b1f06115b9936eb789e221f5d49f124b302d5865092d12672c3646b33` | `sha512-6FxJSk8TuccLZ2MpDmgLD803SzlwO3BxJaZqW3aEUThMr/EKuY42LOsCFFQA8SuAoGykmrKfpSFzdML0jFvJ1Q==` |
| `arkade-os-swap-0.1.16-taxi.1-7584c23c.tgz` | arkade-os/ts-sdk `7584c23ce08b974e0e5e8e7651f8b45399bee7d7`      | `282c308dc3ac4529c52b05e488bf962e9edaa0678b3dafec7fd16ec7140808c8` | `sha512-XZFFnRhToFsQI6begvqjKv0Q2bV+jFFwR67ILEF8FStqlng728bsY53/vPMqDY+GXW2miyp77h8+ZTa4VKqJWQ==` |
| `arkade-taxi-client-1.1.2-1e831e7d.tgz`     | ArkLabsHQ/arkade-taxi `1e831e7ddc0c71c3f78e3bb6dc6d4bdadf11fa52` | `44fc73a887a5d31019f6f0eb0a13d233307e5d3e221228bc803f5c7479443490` | `sha512-wKhlBZX1xaqNbZ45yqL+5E/6Ixo2NztroGQVo24Rq6MeSWFkHyZZWAIvs7hk33T2cNFIMfl2Fg2iVrPQWI1djw==` |
| `arkade-taxi-covenant-1.1.2-1e831e7d.tgz`   | ArkLabsHQ/arkade-taxi `1e831e7ddc0c71c3f78e3bb6dc6d4bdadf11fa52` | `2e8b2c706744d49460d14cf8e5ea56d486082f94f2bbbb47b747d4e3ba4b87fa` | `sha512-KF4XZ0gW1av8mo/pYWJZtWvva+nmJDKvfLqSyvkqXHY7jDyTr6Q0by7+0kDlQ3zWODZ/33q/VCmVm29sUqTbmQ==` |
| `arkade-taxi-protocol-1.1.2-1e831e7d.tgz`   | ArkLabsHQ/arkade-taxi `1e831e7ddc0c71c3f78e3bb6dc6d4bdadf11fa52` | `901741662fea6773825be4ad6e07a0806ec690b04ef79652df90aef33116f7f2` | `sha512-9fVt2j5shJtpsES7+G0PcAHRFDrn30Dyo4MPzPmqBUzdJq4RlCd2XSXDQkm+DuXHt330vlCjE4+8xnK/2BeW6w==` |

The SDK commit is the head of ts-sdk's `provenance/taxi-cohort-20261124` branch: master with
arkade-os/ts-sdk#1282 and #1283. The Taxi commit is the merge of ArkLabsHQ/arkade-taxi#49, which cut
1.1.2; the Taxi repository has no tags.

Check an archive:

```sh
sha256sum packages/solver-app/vendor/carrier/*.tgz
openssl dgst -sha512 -binary <archive> | base64   # prefix sha512-, compare with pnpm-lock.yaml
```
