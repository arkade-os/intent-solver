import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DOMAIN = fileURLToPath(new URL('../../../packages/solver-next/src/domain/', import.meta.url))
const IMPORT = /from '(\.\.?\/[^']+)'/g

describe('domain boundaries', () => {
  it('lets a context import only itself and shared: the application wires contexts together', () => {
    const offenders = readdirSync(DOMAIN).flatMap((context) =>
      readdirSync(`${DOMAIN}${context}`).flatMap((file) =>
        [...readFileSync(`${DOMAIN}${context}/${file}`, 'utf8').matchAll(IMPORT)]
          .map(([, specifier]) => specifier!)
          .filter((s) => s.startsWith('../') && !s.startsWith('../shared/'))
          .map((specifier) => `${context}/${file} imports ${specifier}`),
      ),
    )
    expect(offenders).toEqual([])
  })

  it('throws only DomainError, so a caller can handle a failure by its code', () => {
    const plain = readdirSync(DOMAIN).flatMap((context) =>
      readdirSync(`${DOMAIN}${context}`).filter((file) =>
        /new Error\(/.test(readFileSync(`${DOMAIN}${context}/${file}`, 'utf8')),
      ),
    )
    expect(plain).toEqual([])
  })

  it('depends on no package beyond the hash primitives', () => {
    const packages = readdirSync(DOMAIN).flatMap((context) =>
      readdirSync(`${DOMAIN}${context}`).flatMap((file) =>
        [...readFileSync(`${DOMAIN}${context}/${file}`, 'utf8').matchAll(/from '([^.'][^']*)'/g)].map(
          ([, specifier]) => `${context}/${file} imports ${specifier}`,
        ),
      ),
    )
    expect(packages.sort()).toEqual([
      'swap/hashlock.ts imports @noble/hashes/sha2.js',
      'swap/hashlock.ts imports @scure/base',
    ])
  })
})
