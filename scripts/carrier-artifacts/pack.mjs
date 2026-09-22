#!/usr/bin/env node
/**
 * Freeze the accepted candidate packages into `packages/solver-app/vendor/carrier`.
 *
 *   node scripts/carrier-artifacts/pack.mjs --sdk <ts-sdk checkout> --taxi <arkade-taxi checkout>
 *
 * MAINTAINER COMMAND — nothing installs, builds or ships it, because it needs
 * two source checkouts a clean clone does not have. Both stay read-only.
 *
 * The Taxi leg runs that repository's own harness helpers in `packClient`'s
 * order, extended by two overrides on the fresh consumer: without them the
 * consumer takes REGISTRY `@arkade-os/sdk@0.4.74` and the candidate swap will
 * not load against it, which is why root overrides are needed here at all.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  CANDIDATE_SDK_SYMBOL,
  CANDIDATE_SWAP_SYMBOL,
  MANIFEST_PATH,
  PINNED_PACKAGES,
  VENDOR_DIR,
  archiveManifest,
  assertCandidateExport,
  packageRootFrom,
  readJson,
  sha256,
} from './lib.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Moving to a new candidate is an edit HERE, so a re-pack is an auditable act
// rather than a side effect of whatever happened to be checked out.
const PINNED = {
  sdk: {
    commit: 'adc6b32958c36a7f9c39d6e30efdd945af874f84',
    repository: 'https://github.com/arkade-os/ts-sdk.git',
    packages: [
      { name: '@arkade-os/sdk', directory: 'packages/ts-sdk' },
      { name: '@arkade-os/swap', directory: 'packages/swap' },
    ],
  },
  taxi: {
    commit: '0763128a74a26e05a7a138f762efee08073eb799',
    repository: 'https://github.com/ArkLabsHQ/arkade-taxi.git',
    packages: [
      { name: '@arkade-taxi/covenant', directory: 'packages/covenant' },
      { name: '@arkade-taxi/protocol', directory: 'packages/protocol' },
      { name: '@arkade-taxi/client', directory: 'packages/client' },
    ],
  },
}

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

const sdkRoot = flag('sdk') && resolve(flag('sdk'))
const taxiRoot = flag('taxi') && resolve(flag('taxi'))
const outDir = resolve(REPO, flag('out') ?? VENDOR_DIR)
if (!sdkRoot || !taxiRoot) {
  process.stderr.write('usage: pack.mjs --sdk <ts-sdk checkout> --taxi <arkade-taxi checkout> [--out <dir>]\n')
  process.exit(2)
}

const harness = await import(pathToFileURL(join(taxiRoot, 'scripts', 'lib', 'harness.mjs')).href)

const git = (cwd, ...argv) => execFileSync('git', ['-C', cwd, ...argv], { encoding: 'utf8' }).trim()

const assertPinnedSource = (root, expected, label) => {
  const head = git(root, 'rev-parse', 'HEAD')
  if (head !== expected.commit) throw new Error(`${label} is at ${head}, not the pinned ${expected.commit}`)
  const dirty = git(root, 'status', '--porcelain')
  if (dirty) throw new Error(`${label} at ${expected.commit} is dirty; pack only from a clean checkout:\n${dirty}`)
  return head
}

const runPnpm = (cwd, argv, npmUserConfig) => {
  const invocation = harness.packageManagerInvocation(argv)
  return execFileSync(invocation.command, invocation.args, {
    cwd,
    encoding: 'utf8',
    env: harness.packageManagerEnvironment(process.env, npmUserConfig),
    maxBuffer: 256 * 1024 * 1024,
  })
}

const spec = (from, path) => `file:${relative(from, path).replaceAll('\\', '/')}`


const scratch = mkdtempSync(join(tmpdir(), 'carrier-pack-'))
const shortCommit = (commit) => commit.slice(0, 8)
const archiveName = (name, version, commit) =>
  `${name.replace('@', '').replace('/', '-')}-${version}-${shortCommit(commit)}.tgz`

/** The repository LICENSE, for packages carrying no `license` field of their own. */
const repositoryLicense = (root) => {
  const headline = readFileSync(join(root, 'LICENSE'), 'utf8')
    .split(/\r?\n/)
    .find((line) => line.trim())
  if (!headline?.includes('MIT')) throw new Error(`${root}/LICENSE is not the MIT text this manifest would claim`)
  return 'MIT'
}

try {
  const sdkCommit = assertPinnedSource(sdkRoot, PINNED.sdk, 'ts-sdk checkout')
  const taxiCommit = assertPinnedSource(taxiRoot, PINNED.taxi, 'arkade-taxi checkout')

  const npmUserConfig = join(scratch, 'pack.npmrc')
  writeFileSync(npmUserConfig, 'registry=https://registry.npmjs.org/\n@arkade-taxi:registry=http://127.0.0.1:9/\n')

  const sdkPackDir = join(scratch, 'sdk-packs')
  mkdirSync(sdkPackDir)
  const packed = []
  for (const { name, directory } of PINNED.sdk.packages) {
    // The SDK's `prepack` builds and tsup writes to stdout, so `pack --json`
    // output is not parseable here. The new file in the destination is.
    const before = new Set(readdirSync(sdkPackDir))
    runPnpm(sdkRoot, ['--filter', name, 'pack', '--pack-destination', sdkPackDir], npmUserConfig)
    const produced = readdirSync(sdkPackDir).filter((entry) => entry.endsWith('.tgz') && !before.has(entry))
    if (produced.length !== 1) throw new Error(`packing ${name} produced ${produced.length} archives, expected one`)
    packed.push({ name, directory, path: join(sdkPackDir, produced[0]), pin: PINNED.sdk, commit: sdkCommit })
  }
  const candidate = Object.fromEntries(packed.map((entry) => [entry.name, entry.path]))

  const packDir = join(scratch, 'taxi-packs')
  const consumer = join(scratch, 'consumer')
  mkdirSync(packDir)
  mkdirSync(consumer)
  runPnpm(taxiRoot, ['-r', 'build'], npmUserConfig)
  const taxiTarballs = PINNED.taxi.packages.map(({ name }) =>
    harness.assertPackResult(
      runPnpm(taxiRoot, ['--filter', name, 'pack', '--json', '--pack-destination', packDir], npmUserConfig),
      { name, packDir },
    ),
  )
  const beforeInstall = Object.fromEntries(
    taxiTarballs.map((path) => [path, sha256(readFileSync(path))]),
  )

  const consumerManifest = harness.buildConsumerManifest(taxiTarballs, consumer)
  consumerManifest.pnpm.overrides['@arkade-os/sdk'] = spec(consumer, candidate['@arkade-os/sdk'])
  consumerManifest.pnpm.overrides['@arkade-os/swap'] = spec(consumer, candidate['@arkade-os/swap'])
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify(consumerManifest, null, 2)}\n`)
  runPnpm(
    consumer,
    ['--store-dir', join(scratch, 'pnpm-store'), 'install', '--ignore-scripts', '--frozen-lockfile=false'],
    npmUserConfig,
  )

  harness.assertTarballIntegrity(
    beforeInstall,
    Object.fromEntries(taxiTarballs.map((path) => [path, sha256(readFileSync(path))])),
  )
  const entry = harness.resolveInstalledClientEntry(consumer)
  harness.assertLocalConsumerResolution(
    consumerManifest,
    readFileSync(join(consumer, 'pnpm-lock.yaml'), 'utf8'),
    JSON.parse(runPnpm(consumer, ['list', '--json', '--depth=0'], npmUserConfig))[0],
  )
  for (const [name, symbol] of [
    ['@arkade-os/sdk', CANDIDATE_SDK_SYMBOL],
    ['@arkade-os/swap', CANDIDATE_SWAP_SYMBOL],
  ])
    await assertCandidateExport(packageRootFrom(entry, name), name, symbol)
  await import(pathToFileURL(entry).href)

  for (const path of taxiTarballs) {
    const { name } = archiveManifest(path)
    const declared = PINNED.taxi.packages.find((pinned) => pinned.name === name)
    if (!declared) throw new Error(`pack produced an unexpected package: ${name}`)
    packed.push({ ...declared, path, pin: PINNED.taxi, commit: taxiCommit })
  }

  const declaredNames = [...PINNED.sdk.packages, ...PINNED.taxi.packages].map((pinned) => pinned.name).sort()
  if (JSON.stringify(packed.map((pinned) => pinned.name).sort()) !== JSON.stringify(declaredNames))
    throw new Error('packed set does not match the pinned set')
  if (JSON.stringify(declaredNames) !== JSON.stringify([...PINNED_PACKAGES].sort()))
    throw new Error('the pinned set and PINNED_PACKAGES have drifted apart')

  const taxiLicense = repositoryLicense(taxiRoot)
  // Corepack resolves pnpm per repo, so one number for both would be wrong.
  const pnpmVersion = Object.fromEntries(
    [sdkRoot, taxiRoot].map((root) => [root, runPnpm(root, ['--version'], npmUserConfig).trim()]),
  )
  const artifacts = []
  mkdirSync(outDir, { recursive: true })
  for (const pinned of packed.sort((a, b) => a.name.localeCompare(b.name))) {
    const manifest = archiveManifest(pinned.path)
    if (manifest.name !== pinned.name) throw new Error(`${pinned.path}: archive declares ${manifest.name}`)
    const file = archiveName(manifest.name, manifest.version, pinned.commit)
    copyFileSync(pinned.path, join(outDir, file))
    const bytes = readFileSync(join(outDir, file))
    const sourceRoot = pinned.pin === PINNED.sdk ? sdkRoot : taxiRoot
    artifacts.push({
      file,
      package: manifest.name,
      version: manifest.version,
      license: manifest.license ?? taxiLicense,
      licenseFrom: manifest.license ? 'the package manifest' : 'the LICENSE file of the source repository',
      sha256: sha256(bytes),
      bytes: bytes.length,
      source: { repository: pinned.pin.repository, commit: pinned.commit, directory: pinned.directory },
      toolchain: {
        node: process.version,
        pnpm: pnpmVersion[sourceRoot],
        declaredPackageManager: readJson(join(sourceRoot, 'package.json')).packageManager,
        command: `pnpm --filter ${manifest.name} pack`,
        platform: `${process.platform}-${process.arch}`,
      },
    })
  }

  const superseded = readdirSync(outDir).filter(
    (name) => name.endsWith('.tgz') && !artifacts.some((artifact) => artifact.file === name),
  )
  for (const name of superseded) rmSync(join(outDir, name))

  writeFileSync(
    join(outDir, 'manifest.json'),
    `${JSON.stringify(
      {
        note: 'Frozen candidate packages, built from source and never published to any registry. These digests are of THIS bundle: repacking @arkade-os/sdk from the same commit emits different declaration-chunk names, though no runtime module differs, so a re-pack is a deliberate re-freeze — run scripts/carrier-artifacts/pack.mjs, then pnpm install, then scripts/carrier-artifacts/verify.mjs.',
        packedAtUtc: new Date().toISOString(),
        artifacts,
      },
      null,
      2,
    )}\n`,
  )

  process.stdout.write(`${artifacts.length} archives frozen in ${VENDOR_DIR}\n`)
  for (const artifact of artifacts) process.stdout.write(`  ${artifact.sha256}  ${artifact.file}\n`)
  if (superseded.length) process.stdout.write(`removed superseded: ${superseded.join(', ')}\n`)
  process.stdout.write(`manifest: ${MANIFEST_PATH}\n`)
} finally {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch (error) {
    process.stderr.write(`could not remove ${scratch}: ${error.message}\n`)
  }
}
