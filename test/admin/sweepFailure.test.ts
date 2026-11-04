import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')
const cell = source.slice(
  source.indexOf('const sweepFailure'),
  source.indexOf('/**', source.indexOf('const stateCell')),
)

type Node = { spec: string; args: unknown[] }
const h = (spec: string, ...args: unknown[]): Node => ({ spec, args })
const text = (node: unknown): string =>
  node === null || node === undefined
    ? ''
    : typeof node === 'string'
      ? node
      : Array.isArray(node)
        ? node.map(text).join('')
        : (node as Node).args.map(text).join('')
const stateCell = new Function('h', 'stateWord', 'stateRead', `${cell}; return stateCell`)(
  h,
  (state: string) => h('span.state', state),
  () => '',
) as (row: unknown) => Node

describe('stateCell', () => {
  it('says a claiming row holds the preimage and what its claim keeps failing on', () => {
    const failing = { message: 'INVALID_SIGNATURE (18): invalid signature in checkpoint tx', count: 7 }
    const rendered = text(stateCell({ phase: 'exposed', state: 'claiming', failing }))
    expect(rendered).toContain('preimage held')
    expect(rendered).toContain('7')
    expect(rendered).toContain(failing.message)
  })

  it('adds nothing to a row the sweep is not failing on', () => {
    expect(text(stateCell({ phase: 'exposed', state: 'claiming' }))).toBe('claiming')
  })
})
