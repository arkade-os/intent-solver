import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVM_FIELDS, PATHS } from '@arkade-os/solver-app/config/knobs.js'

const root = fileURLToPath(new URL('../../', import.meta.url))

// The config layer's messages, and the parsers only it calls, are renamed by `loadConfig` on the way out.
const EXEMPT = [
  /^packages\/solver-app\/src\/config(\.ts$|\/)/,
  /^packages\/solver-rails-evm\/src\/evm\/config\.ts$/,
  /^packages\/solver-core\/src\/core\/evmCorridorConfig\.ts$/,
]
const RENAMED_AT_LOAD = /^(OFFER_MARKETS entry|ASSET_MARKETS|SENTRY_DSN) /

const ids = [...PATHS.map(([, id]) => id), ...Object.values(EVM_FIELDS), 'EVM_TOKENS', 'ASSET_MARKETS', 'OFFER_MARKETS']
const ID = new RegExp(
  `(?<![A-Za-z0-9_])(${ids.join('|')}|(LN_SEND|LN_RECEIVE|ONCHAIN_SEND)_[A-Z_]+|[A-Z][A-Z_]*_<[A-Z]+>[A-Z_]*)(?![a-z0-9])`,
)

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'dist' || name === 'node_modules' ? [] : sources(path)
    return /\.(ts|js|mjs)$/.test(name) ? [path] : []
  })

const offenders = (): string[] =>
  readdirSync(join(root, 'packages'))
    .flatMap((pkg) => sources(join(root, 'packages', pkg, 'src')))
    .map((path) => relative(root, path).replace(/\\/g, '/'))
    .filter((file) => !EXEMPT.some((pattern) => pattern.test(file)))
    .flatMap((file) =>
      readFileSync(join(root, file), 'utf8')
        .split('\n')
        .flatMap((line, index) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return []
          const literals = [...line.replace(/\$\{[^}]*\}/g, '').matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)]
            .map((match) => match[2]!)
            .filter((text) => !ids.includes(text) && !RENAMED_AT_LOAD.test(text))
          return literals.some((text) => ID.test(text)) ? [`${file}:${index + 1}`] : []
        }),
    )

describe('runtime messages', () => {
  it('name a setting by its config path, not by an environment variable the loader refuses', () => {
    expect(offenders()).toEqual([])
  })
})
