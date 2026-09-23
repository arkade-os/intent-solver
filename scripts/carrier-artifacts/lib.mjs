// Built-in Node only: `verify.mjs` runs in the Docker layer BEFORE
// `pnpm install`, so there is no node_modules for it to import from.

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

export const VENDOR_DIR = 'packages/solver-app/vendor/carrier'
export const MANIFEST_PATH = `${VENDOR_DIR}/manifest.json`

const TS_SDK = 'https://github.com/arkade-os/ts-sdk.git'
const ARKADE_TAXI = 'https://github.com/ArkLabsHQ/arkade-taxi.git'
const SDK_COMMIT = 'adc6b32958c36a7f9c39d6e30efdd945af874f84'
const TAXI_COMMIT = '88ca652aec73650c80caa49ecbdad098788968c6'

// Every package whose resolution must come from a frozen archive, and the exact
// source each was packed from. Moving to a new candidate is an edit HERE, so a
// re-pack is an auditable act and `verify.mjs` can refuse an archive whose
// manifest names any other commit.
export const PINNED_SOURCES = {
  '@arkade-os/sdk': { repository: TS_SDK, commit: SDK_COMMIT, directory: 'packages/ts-sdk' },
  '@arkade-os/swap': { repository: TS_SDK, commit: SDK_COMMIT, directory: 'packages/swap' },
  '@arkade-taxi/covenant': { repository: ARKADE_TAXI, commit: TAXI_COMMIT, directory: 'packages/covenant' },
  '@arkade-taxi/protocol': { repository: ARKADE_TAXI, commit: TAXI_COMMIT, directory: 'packages/protocol' },
  '@arkade-taxi/client': { repository: ARKADE_TAXI, commit: TAXI_COMMIT, directory: 'packages/client' },
}

export const PINNED_PACKAGES = Object.keys(PINNED_SOURCES)

/** The one workspace package permitted to declare a `@arkade-taxi/*` dependency. */
export const TAXI_CONSUMER = 'packages/solver-app'

/** Why this archive is not the pinned source, or `undefined` when it is. */
export function pinnedSourceMismatch(artifact) {
  const pinned = PINNED_SOURCES[artifact?.package]
  const name = artifact?.file ?? 'an unnamed archive'
  if (!pinned) return `${name} records ${artifact?.package}, which is not a pinned package`
  for (const field of ['repository', 'commit', 'directory'])
    if (artifact.source?.[field] !== pinned[field])
      return `${name} records ${field} ${artifact.source?.[field]}, not the pinned ${pinned[field]}`
  return undefined
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// What separates each candidate from the REGISTRY build of the identical
// version: both were added in `adc6b329` and neither registry build has one.
export const CANDIDATE_SWAP_SYMBOL = 'FundingOutputMismatchError'
export const CANDIDATE_SDK_SYMBOL = 'SendDeadlineExceededError'

// One member out of a gzipped tar without a tar dependency: decode the POSIX
// ustar fields this needs, skip everything else by size.
export function readTarMember(archivePath, member) {
  const buffer = gunzipSync(readFileSync(archivePath))
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const path = prefix ? `${prefix}/${name}` : name
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0
    offset += 512
    if (path === member) return buffer.subarray(offset, offset + size).toString('utf8')
    offset += Math.ceil(size / 512) * 512
  }
  return undefined
}

export const archiveManifest = (archivePath) => {
  const source = readTarMember(archivePath, 'package/package.json')
  if (source === undefined) throw new Error(`${archivePath}: archive carries no package/package.json`)
  return JSON.parse(source)
}

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

// pnpm resolves an override against the workspace root and a package's own
// dependencies against its directory, so callers pass the one they write in.
export const fileSpec = (from, filename) => `file:${from}${from.endsWith('/') ? '' : '/'}${filename}`

// Under pnpm's strict layout a transitive package is not linked at the
// consumer's top level, so only the importer's own question is the real one.
export function packageRootFrom(fromFile, name) {
  // realpath: pnpm links packages into `.pnpm/`, and deps are siblings THERE.
  let directory = dirname(createRequire(realpathSync(fromFile)).resolve(name))
  for (;;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest) && readJson(manifest).name === name) return directory
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`${name} is not resolvable from ${fromFile}`)
    directory = parent
  }
}

// Load what actually resolved and require the named export. An import that
// merely succeeds does not separate a candidate from the registry build.
export async function assertCandidateExport(packageRoot, name, symbol) {
  const manifest = readJson(join(packageRoot, 'package.json'))
  const entry = manifest.exports?.['.']?.import?.default ?? manifest.module ?? manifest.main
  if (!entry) throw new Error(`${name} at ${packageRoot} declares no ESM entry`)
  const namespace = await import(pathToFileURL(join(packageRoot, entry)).href)
  if (!(symbol in namespace))
    throw new Error(`${name} resolved to ${packageRoot}, which does not export ${symbol}: that is not the candidate`)
  return packageRoot
}
