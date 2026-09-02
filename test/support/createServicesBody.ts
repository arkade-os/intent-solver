/**
 * The source text of `createServices`, bounded at both ends.
 *
 * These assertions read source because constructing the stack needs an Arkade
 * wallet, a Lightning node and a chain that a unit test has none of.
 *
 * The upper bound is the point. Slicing to end-of-file works only while
 * `createServices` is the last declaration in its module; a helper added after
 * it would silently enter the body under test and make assertions pass for the
 * wrong reason. Raised by arkana on #215.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const servicesSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/ops/services.ts', import.meta.url)),
  'utf8',
)

/**
 * Bounded by the closing brace at column 0. Prettier keeps every brace inside
 * the function indented, so the first unindented `}` after the declaration is
 * its end.
 */
export const createServicesBody = (): string => {
  const lines = servicesSource.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith('export const createServices'))
  if (start === -1) throw new Error('createServices is gone from packages/solver-app/src/ops/services.ts')
  const offset = lines.slice(start + 1).findIndex((line) => line === '}')
  if (offset === -1) throw new Error('createServices has no closing brace at column 0; the bound is broken')
  return lines.slice(start, start + 1 + offset + 1).join('\n')
}
