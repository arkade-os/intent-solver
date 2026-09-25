#!/usr/bin/env node
/**
 * Prove the frozen archives are what this repository claims, and that nothing
 * resolves past them to a registry build of the same version. Built-in Node
 * only: it runs in the Docker layer BEFORE `pnpm install`, and every group but
 * the last is static.
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CANDIDATE_SDK_SYMBOL,
  CANDIDATE_SWAP_SYMBOL,
  MANIFEST_PATH,
  PINNED_PACKAGES,
  TAXI_CONSUMER,
  VENDOR_DIR,
  archiveManifest,
  assertCandidateExport,
  fileSpec,
  packageRootFrom,
  pinnedSourceMismatch,
  readJson,
  sha256,
} from './lib.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INSTALLED = process.argv.includes('--installed')
const at = (...parts) => join(REPO, ...parts)
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
  return condition
}

const manifest = readJson(at(MANIFEST_PATH))
const byPackage = new Map(manifest.artifacts?.map((artifact) => [artifact.package, artifact]) ?? [])
check(
  JSON.stringify([...byPackage.keys()].sort()) === JSON.stringify([...PINNED_PACKAGES].sort()),
  `${MANIFEST_PATH} covers ${[...byPackage.keys()].join(', ')}, expected exactly ${PINNED_PACKAGES.join(', ')}`,
)

const present = readdirSync(at(VENDOR_DIR)).filter((name) => name !== 'manifest.json')
const expected = manifest.artifacts?.map((artifact) => artifact.file) ?? []
check(
  JSON.stringify([...present].sort()) === JSON.stringify([...expected].sort()),
  `${VENDOR_DIR} holds ${present.join(', ')}, and the manifest lists ${expected.join(', ')}`,
)

for (const artifact of manifest.artifacts ?? []) {
  const path = at(VENDOR_DIR, artifact.file)
  if (!check(existsSync(path), `${artifact.file} is listed in the manifest and missing from ${VENDOR_DIR}`)) continue
  const bytes = readFileSync(path)
  check(bytes.length === artifact.bytes, `${artifact.file} is ${bytes.length} bytes, manifest says ${artifact.bytes}`)
  check(sha256(bytes) === artifact.sha256, `${artifact.file} sha256 ${sha256(bytes)} != manifest ${artifact.sha256}`)

  const declared = archiveManifest(path)
  check(
    declared.name === artifact.package && declared.version === artifact.version,
    `${artifact.file} contains ${declared.name}@${declared.version}, manifest says ${artifact.package}@${artifact.version}`,
  )
  const mismatch = pinnedSourceMismatch(artifact)
  check(mismatch === undefined, mismatch ?? '')
  check(
    artifact.file.endsWith(`-${artifact.version}-${artifact.source?.commit?.slice(0, 8)}.tgz`),
    `${artifact.file} does not carry its version and source commit in its name`,
  )
  check(Boolean(artifact.license), `${artifact.file} records no license`)
  check(
    Boolean(artifact.toolchain?.node && artifact.toolchain?.pnpm && artifact.toolchain?.command),
    `${artifact.file} records no build toolchain`,
  )
}

const root = readJson(at('package.json'))
const overrides = root.pnpm?.overrides ?? {}
check(
  JSON.stringify(Object.keys(overrides).sort()) === JSON.stringify([...PINNED_PACKAGES].sort()),
  `root pnpm.overrides covers ${Object.keys(overrides).join(', ')}, expected exactly ${PINNED_PACKAGES.join(', ')}`,
)
for (const [name, spec] of Object.entries(overrides)) {
  const artifact = byPackage.get(name)
  check(
    artifact !== undefined && spec === fileSpec(VENDOR_DIR, artifact.file),
    `root override of ${name} is ${spec}, which is not a frozen archive`,
  )
}

const clientArchive = byPackage.get('@arkade-taxi/client')?.file
const consumer = readJson(at(TAXI_CONSUMER, 'package.json'))
const clientSpec = consumer.dependencies?.['@arkade-taxi/client']
check(
  clientSpec === fileSpec('./vendor/carrier', clientArchive),
  `${TAXI_CONSUMER} declares @arkade-taxi/client as ${clientSpec}, which is not the frozen archive`,
)
// And at the root, because the image's `pnpm prune --prod` empties every
// `packages/*/node_modules` and the app could then not reach its own declaration.
check(
  root.dependencies?.['@arkade-taxi/client'] === fileSpec(VENDOR_DIR, clientArchive),
  `the workspace root declares @arkade-taxi/client as ${root.dependencies?.['@arkade-taxi/client']}, so the runtime image cannot resolve it`,
)

// Taxi reaches the composition layer and nowhere else. Manifests AND imports,
// because either alone can be green while the other leaks.
const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && /\.(?:ts|mts|cts|js|mjs)$/.test(path) ? [path] : []
  })

for (const entry of readdirSync(at('packages'), { withFileTypes: true })) {
  if (!entry.isDirectory() || `packages/${entry.name}` === TAXI_CONSUMER) continue
  const packageRoot = at('packages', entry.name)
  const declared = readJson(join(packageRoot, 'package.json'))
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
    for (const name of Object.keys(declared[field] ?? {}))
      check(!name.startsWith('@arkade-taxi/'), `packages/${entry.name} declares ${name}; only ${TAXI_CONSUMER} may`)
  const src = join(packageRoot, 'src')
  if (!existsSync(src) || !statSync(src).isDirectory()) continue
  for (const file of sourceFiles(src))
    check(
      !/from\s+['"]@arkade-taxi\/|require\(\s*['"]@arkade-taxi\/|import\s*\(?\s*['"]@arkade-taxi\//.test(
        readFileSync(file, 'utf8'),
      ),
      `${file.slice(REPO.length + 1).replaceAll('\\', '/')} imports @arkade-taxi; only ${TAXI_CONSUMER} may`,
    )
}

// Where a registry build of the same version would reappear: every resolution
// must name a frozen archive, and the integrity pnpm recorded must be the
// sha512 of the archive that is committed.
const lock = readFileSync(at('pnpm-lock.yaml'), 'utf8')
const escape = (value) => value.replaceAll(/[.*+?^${}()|[\]\\/]/g, '\\$&')
for (const name of PINNED_PACKAGES) {
  const artifact = byPackage.get(name)
  const keys = [...lock.matchAll(new RegExp(`^ {2}'${escape(name)}@([^']+)':(?: \\{\\})?$`, 'gm'))]
  if (!check(keys.length > 0, `pnpm-lock.yaml resolves nothing for ${name}`)) continue
  for (const [, spec] of keys)
    check(
      spec.startsWith(`file:${VENDOR_DIR}/${artifact?.file}`),
      `pnpm-lock.yaml resolves ${name}@${spec}, which is not the frozen archive`,
    )
  check(
    overrides[name] !== undefined && lock.includes(`'${name}': ${overrides[name]}`),
    `pnpm-lock.yaml does not record the root override of ${name}`,
  )
  if (!artifact || !existsSync(at(VENDOR_DIR, artifact.file))) continue
  const integrity = `sha512-${createHash('sha512').update(readFileSync(at(VENDOR_DIR, artifact.file))).digest('base64')}`
  check(lock.includes(integrity), `pnpm-lock.yaml does not pin the bytes of ${artifact.file}`)
}

// What actually resolved, when there is an install to ask. The unit suite
// asserts the same thing unconditionally.
let entry
try {
  entry = createRequire(at(TAXI_CONSUMER, 'package.json')).resolve('@arkade-taxi/client')
} catch {
  entry = undefined
}
if (entry) {
  for (const [name, symbol] of [
    ['@arkade-os/sdk', CANDIDATE_SDK_SYMBOL],
    ['@arkade-os/swap', CANDIDATE_SWAP_SYMBOL],
  ]) {
    try {
      await assertCandidateExport(packageRootFrom(entry, name), name, symbol)
    } catch (error) {
      failures.push(error.message)
    }
  }
} else if (INSTALLED) {
  failures.push(
    `--installed, and ${TAXI_CONSUMER} resolves no @arkade-taxi/client: the candidate exports went uninspected`,
  )
}

if (failures.length) {
  process.stderr.write(`carrier artifacts FAILED:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(
  `carrier artifacts verified: ${manifest.artifacts.length} archives, lock pinned to their bytes, ` +
    `${entry ? 'candidate exports confirmed in the installed tree' : 'no install to inspect yet'}\n`,
)
