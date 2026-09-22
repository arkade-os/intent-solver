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

/** Every package whose resolution must come from a frozen archive. */
export const PINNED_PACKAGES = [
  '@arkade-os/sdk',
  '@arkade-os/swap',
  '@arkade-taxi/client',
  '@arkade-taxi/covenant',
  '@arkade-taxi/protocol',
]

/** The one workspace package permitted to declare a `@arkade-taxi/*` dependency. */
export const TAXI_CONSUMER = 'packages/solver-app'

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
