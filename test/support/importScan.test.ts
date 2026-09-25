import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { compiledFilesUnder } from './importScan.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) }
})

const roots: string[] = []
const readDirectory = vi.mocked(readdirSync)

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'intent-solver-import-scan-'))
  roots.push(root)
  return root
}

const write = (root: string, path: string): void => {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, '')
}

const relativeFiles = (root: string, files: readonly string[]): string[] =>
  files.map((file) => relative(root, file).replace(/\\/g, '/'))

afterEach(() => {
  readDirectory.mockClear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('compiledFilesUnder', () => {
  it('does not traverse excluded directories', () => {
    const root = fixture()
    write(root, 'src/nested/source.ts')
    write(root, 'src/nested/module.mts')
    write(root, 'src/nested/common.cts')
    write(root, 'dist/hidden.ts')
    write(root, 'node_modules/hidden.mts')

    const files = compiledFilesUnder(root, new Set(['dist', 'node_modules']))
    const visited = readDirectory.mock.calls.map(([path]) => resolve(String(path)))

    expect(relativeFiles(root, files)).toEqual([
      'src/nested/common.cts',
      'src/nested/module.mts',
      'src/nested/source.ts',
    ])
    expect(visited).toEqual([resolve(root), resolve(root, 'src'), resolve(root, 'src/nested')])
  })

  it('keeps recursive default behavior when no exclusions are supplied', () => {
    const root = fixture()
    write(root, 'src/source.ts')
    write(root, 'dist/generated.ts')

    expect(relativeFiles(root, compiledFilesUnder(root))).toEqual(['dist/generated.ts', 'src/source.ts'])
  })

  it('matches excluded names only on directories', () => {
    const root = fixture()
    write(root, 'dist/hidden.ts')
    write(root, 'distribution/kept.ts')
    write(root, 'dist.ts')
    write(root, 'node_modules.mts')

    expect(relativeFiles(root, compiledFilesUnder(root, new Set(['dist', 'node_modules'])))).toEqual([
      'dist.ts',
      'distribution/kept.ts',
      'node_modules.mts',
    ])
  })
})
