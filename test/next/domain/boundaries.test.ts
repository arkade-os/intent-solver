import { readdirSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DOMAIN = fileURLToPath(new URL('../../../packages/solver-next/src/domain/', import.meta.url))
const RELATIVE = /from ['"](\.\.?\/[^'"]+)['"]/g
const PACKAGE = /from ['"]([^.'"][^'"]*)['"]/g

/** Every source file of the domain, as `context/path/file.ts`. */
const sources = (): string[] =>
  (readdirSync(DOMAIN, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `${entry.parentPath}/${entry.name}`.slice(DOMAIN.length))

const read = (file: string): string => readFileSync(`${DOMAIN}${file}`, 'utf8')
const contextOf = (file: string): string => file.split('/')[0]!

/** The context a relative import lands in; `..` when it leaves the domain. */
const targetOf = (file: string, specifier: string): string => contextOf(posix.join(posix.dirname(file), specifier))

describe('domain boundaries', () => {
  it('has sources to look at', () => {
    expect(sources().length).toBeGreaterThan(0)
  })

  it('lets a context import only itself and shared: the application wires contexts together', () => {
    const offenders = sources().flatMap((file) =>
      [...read(file).matchAll(RELATIVE)]
        .map(([, specifier]) => specifier!)
        .filter((specifier) => ![contextOf(file), 'shared'].includes(targetOf(file, specifier)))
        .map((specifier) => `${file} imports ${specifier}`),
    )
    expect(offenders).toEqual([])
  })

  it('throws only DomainError, so a caller can handle a failure by its code', () => {
    expect(sources().filter((file) => /new Error\(/.test(read(file)))).toEqual([])
  })

  it('depends on no package', () => {
    const packages = sources().flatMap((file) =>
      [...read(file).matchAll(PACKAGE)].map(([, specifier]) => `${file} imports ${specifier}`),
    )
    expect(packages).toEqual([])
  })
})
