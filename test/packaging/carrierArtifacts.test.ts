import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  CANDIDATE_SDK_SYMBOL,
  CANDIDATE_SWAP_SYMBOL,
  MANIFEST_PATH,
  PINNED_PACKAGES,
  TAXI_CONSUMER,
  packageRootFrom,
  type CarrierManifest,
} from '../../scripts/carrier-artifacts/lib.mjs'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(REPO, MANIFEST_PATH), 'utf8')) as CarrierManifest

/**
 * `@arkade-os/sdk@0.4.74` and `@arkade-os/swap@0.0.20` exist on the registry
 * AND as candidate builds from `adc6b329` — same version specifier, different
 * bytes. An install that resolves the registry copy imports perfectly well and
 * is silently missing the candidate's changes, so these two names are the whole
 * test: each was added in `adc6b329` and neither registry build exports it.
 */
const CANDIDATE_ONLY = {
  '@arkade-os/sdk': 'SendDeadlineExceededError',
  '@arkade-os/swap': 'FundingOutputMismatchError',
} as const

const resolveFrom = (packageDir: string, name: string) =>
  createRequire(join(REPO, packageDir, 'package.json')).resolve(name)

describe('carrier artifacts', () => {
  it('pass the built-in-Node verification command', () => {
    try {
      execFileSync(process.execPath, [join(REPO, 'scripts', 'carrier-artifacts', 'verify.mjs')], {
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
