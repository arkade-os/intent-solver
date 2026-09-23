import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  CANDIDATE_SDK_SYMBOL,
  CANDIDATE_SWAP_SYMBOL,
  MANIFEST_PATH,
  PINNED_PACKAGES,
  TAXI_CONSUMER,
  artifactLicense,
  packageRootFrom,
  pinnedSourceMismatch,
  type CarrierArtifact,
  type CarrierManifest,
} from '../../scripts/carrier-artifacts/lib.mjs'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(REPO, MANIFEST_PATH), 'utf8')) as CarrierManifest

// Both versions exist on the registry as well, built from different source, so
// an install can silently take the wrong bytes and still import cleanly. Each
// symbol was added in `adc6b329`; neither registry build exports one.
const CANDIDATE_ONLY = {
  '@arkade-os/sdk': 'SendDeadlineExceededError',
  '@arkade-os/swap': 'FundingOutputMismatchError',
} as const

const resolveFrom = (packageDir: string, name: string) =>
  createRequire(join(REPO, packageDir, 'package.json')).resolve(name)

describe('carrier artifacts', () => {
  it('pass the built-in-Node verification command', () => {
    try {
      execFileSync(process.execPath, [join(REPO, 'scripts', 'carrier-artifacts', 'verify.mjs'), '--installed'], {
        cwd: REPO,
        encoding: 'utf8',
      })
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string }
      expect.fail(`${failure.stderr ?? ''}${failure.stdout ?? ''}`)
    }
  })

  it('record a reproducible source for every frozen archive', () => {
    expect(manifest.artifacts.map((artifact) => artifact.package).sort()).toEqual([...PINNED_PACKAGES].sort())
    for (const artifact of manifest.artifacts) {
      expect(artifact.source.commit, artifact.file).toMatch(/^[0-9a-f]{40}$/)
      expect(artifact.source.repository, artifact.file).toMatch(/^https:\/\//)
      expect(artifact.source.directory, artifact.file).toMatch(/^packages\//)
      expect(artifact.license, artifact.file).toBeTruthy()
      expect(artifact.toolchain.node, artifact.file).toMatch(/^v\d+\./)
      expect(artifact.file, 'the source commit belongs in the filename, not only in a semver').toContain(
        artifact.source.commit.slice(0, 8),
      )
    }
  })

  it('take a missing license from the package’s own repository, and say so truthfully', () => {
    const root = (license: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'carrier-license-'))
      writeFileSync(join(dir, 'LICENSE'), license)
      return dir
    }
    const sdkRoot = root('MIT License\n\nCopyright (c) ts-sdk\n')
    const taxiRoot = root('Apache License 2.0\n')

    expect(artifactLicense({ license: 'ISC' }, sdkRoot)).toEqual({
      license: 'ISC',
      licenseFrom: 'the package manifest',
    })
    expect(artifactLicense({}, sdkRoot)).toEqual({
      license: 'MIT',
      licenseFrom: 'the LICENSE file of the source repository',
    })
    // The other repository's text is never what an SDK archive falls back to.
    expect(() => artifactLicense({}, taxiRoot)).toThrow(/not the MIT text/)
  })

  // A well-formed commit that is not the PINNED one is the mismatch class a
  // shape check cannot see, and what a wrong-tree pack looks like.
  it('refuse an archive whose manifest names anything but the pinned source', () => {
    expect(manifest.artifacts).toHaveLength(PINNED_PACKAGES.length)
    for (const artifact of manifest.artifacts) {
      expect(pinnedSourceMismatch(artifact), artifact.file).toBeUndefined()
      const wrong = (source: Partial<CarrierArtifact['source']>) =>
        pinnedSourceMismatch({ ...artifact, source: { ...artifact.source, ...source } })
      expect(wrong({ commit: 'f'.repeat(40) })).toContain('not the pinned')
      expect(wrong({ directory: 'packages/somewhere-else' })).toContain('not the pinned')
      expect(wrong({ repository: 'https://example.invalid/fork.git' })).toContain('not the pinned')
      expect(pinnedSourceMismatch({ ...artifact, package: '@arkade-os/unpinned' })).toContain('not a pinned package')
    }
  })

  it.each(Object.entries(CANDIDATE_ONLY))(
    '%s resolves to the candidate build, not the registry one',
    async (name, symbol) => {
      expect({ '@arkade-os/sdk': CANDIDATE_SDK_SYMBOL, '@arkade-os/swap': CANDIDATE_SWAP_SYMBOL }[name]).toBe(symbol)
      for (const consumer of ['.', TAXI_CONSUMER, 'packages/solver-arkade', 'packages/solver-corridors']) {
        const root = packageRootFrom(resolveFrom(consumer, name), name)
        const entry = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { module?: string }).module
        const namespace = await import(pathToFileURL(join(root, entry ?? 'dist/index.js')).href)
        expect(Object.keys(namespace), `${name} as resolved from ${consumer}`).toContain(symbol)
      }
    },
  )

  it('make @arkade-taxi/client importable from the composition layer', async () => {
    const client = await import(pathToFileURL(resolveFrom(TAXI_CONSUMER, '@arkade-taxi/client')).href)
    expect(Object.keys(client)).toEqual(
      expect.arrayContaining([
        'TaxiClient',
        'assertSameUnsignedTx',
        'buildOfferFillPlan',
        'signJointGraphForOwner',
        'unsignedPsbtBytes',
        'verifyOfferFillPlan',
        'verifyReceiveQuote',
        'verifySwapFillQuote',
      ]),
    )
  })

  it('keep Taxi out of every package but the composition layer', () => {
    const offenders = readdirSync(join(REPO, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && `packages/${entry.name}` !== TAXI_CONSUMER)
      .flatMap((entry) => {
        const declared = JSON.parse(readFileSync(join(REPO, 'packages', entry.name, 'package.json'), 'utf8')) as Record<
          string,
          Record<string, string> | undefined
        >
        return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
          .flatMap((field) => Object.keys(declared[field] ?? {}))
          .filter((name) => name.startsWith('@arkade-taxi/'))
          .map((name) => `packages/${entry.name} declares ${name}`)
      })
    expect(offenders).toEqual([])
  })
})
