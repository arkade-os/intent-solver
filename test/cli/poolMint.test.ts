/**
 * Source-level guards on the only command that spends.
 *
 * The spend itself moved to `packages/solver-app/src/ops/pool.ts` so the admin console and the CLI
 * drive one implementation, which SPLIT this guard in two: the `--mint`
 * opt-in is a CLI concern (an argv flag), and the concurrent-provider check is
 * a money concern that belongs with the spend. Both halves are pinned below,
 * against whichever file now owns them.
 *
 * What is pinned is the ORDER of the guards against one `wallet.send`. The
 * planning is already covered by `test/arkade/vtxoPool.test.ts`; the risk that
 * lives here is a future edit that makes the spend unconditional — a `pool`
 * that mints on sight would reshape an operator's float from a command they
 * ran to read it.
 *
 * `packages/solver-app/src/ops/pool.ts` is importable, unlike `packages/solver-app/src/cli.ts` (which runs `main()`
 * then `process.exit()` at module load and exports nothing), so the ops half
 * is ALSO asserted behaviourally by actually calling it — see
 * `test/ops/pool.test.ts`. These text guards remain because they catch a
 * reordering that still type-checks and still passes a mocked call.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cliSource = readFileSync(fileURLToPath(new URL('../../packages/solver-app/src/cli.ts', import.meta.url)), 'utf8')
const opsSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/ops/pool.ts', import.meta.url)),
  'utf8',
)

/** The body of the `pool` command, up to the closing brace of its entry in `commands`. */
const poolCommand = (): string => {
  const start = cliSource.indexOf('async pool(')
  if (start === -1) throw new Error('the pool command is gone')
  const rest = cliSource.slice(start)
  const end = rest.indexOf('\n  },')
  if (end === -1) throw new Error('unterminated pool command')
  return rest.slice(0, end)
}

/**
 * One exported function's body, bounded by the NEXT top-level export of any kind.
 *
 * Two rounds of the same bug. It first sliced to the end of the module, which
 * was correct only while `mintPool` happened to be last; `resplitFloat` landing
 * after it silently widened every assertion below to cover both — the "spends
 * exactly once" count went to 2 and failed loudly, but a count that had merely
 * gone from 0 to 1 would have gone green while measuring the wrong function.
 *
 * Bounding on `\nexport const ` fixed that case and left the same hole open one
 * keyword over: `export function`, `export class`, and the `export type` /
 * `export interface` already in this module do not terminate the slice, so any
 * of them landing after the target reopens exactly the failure above. ANY
 * top-level export ends a body, so that is what this matches.
 *
 * The name is matched to a word boundary too — `resplitFloat` must not find
 * `resplitFloatDryRun` — and `source` is a parameter so the extractor itself is
 * testable against a module that has the shapes this file does not yet contain.
 */
const bodyOf = (name: string, source = opsSource): string => {
  const declaration = new RegExp(`^export (?:const|function|async function|class) ${name}\\b`, 'm')
  const found = declaration.exec(source)
  if (found === null) throw new Error(`${name} is gone`)
  const rest = source.slice(found.index)
  const next = /\nexport\s/.exec(rest.slice(1))
  return next === null ? rest : rest.slice(0, next.index + 1)
}

const mintPoolBody = (): string => bodyOf('mintPool')

describe('the pool command (CLI half)', () => {
  it('is a dry run unless --mint is passed', () => {
    const body = poolCommand()
    expect(body).toContain("args.includes('--mint')")
    // Ordering is the assertion: the opt-in has to be READ before the spend is
    // even requested, not merely mentioned somewhere in the same function.
    expect(body.indexOf("args.includes('--mint')")).toBeLessThan(body.indexOf('mintPool('))
  })

  it('never spends directly — the spend belongs to ops, behind its own gate', () => {
    expect(poolCommand()).not.toContain('wallet.send(')
  })

  it('only lets --force past the ops gate, never the absence of a flag', () => {
    expect(poolCommand()).toContain("args.includes('--force')")
  })
})

describe('resplitFloat (ops half)', () => {
  it('spends exactly once, like the mint it shares a plan with', () => {
    expect(bodyOf('resplitFloat').match(/wallet\.send\(/g)).toHaveLength(1)
  })

  it('deliberately does NOT consult the committed-rows gate', () => {
    // That gate is a proxy for a SECOND provider. `poolPlan` filters this
    // process's reservations, and the renewal this runs after settles the same
    // float with no gate at all — so requiring one here would refuse the split
    // exactly when a busy solver needs it, for a risk the settle already took.
    expect(bodyOf('resplitFloat')).not.toContain('committedAcrossCorridors')
  })
})

describe('mintPool (ops half)', () => {
  it('spends exactly once — a split is one Arkade transaction, not one per piece', () => {
    expect(mintPoolBody().match(/wallet\.send\(/g)).toHaveLength(1)
  })

  it('checks for in-flight swaps before spending, since reservations are process-local', () => {
    const body = mintPoolBody()
    expect(body).toContain('committedAcrossCorridors')
    expect(body.indexOf('committedAcrossCorridors')).toBeLessThan(body.indexOf('wallet.send('))
  })

  it('only an explicit force bypasses that check, never a missing option', () => {
    const body = mintPoolBody()
    expect(body).toContain('opts.force !== true')
    expect(body.indexOf('opts.force !== true')).toBeLessThan(body.indexOf('wallet.send('))
  })
})

/**
 * The extractor is the load-bearing part of every assertion above.
 *
 * A source-text guard that silently measures the wrong span does not fail — it
 * passes against code it was never pointed at, which is the worst outcome
 * available to a test. These pin the boundary against the shapes `packages/solver-app/src/ops/pool.ts`
 * does not currently contain, so the hole cannot reopen by someone adding one.
 */
describe('the body extractor', () => {
  const source = [
    'export const target = async () => {',
    '  wallet.send(MINE)',
    '}',
    '',
    'export function laterFunction() {',
    '  wallet.send(NOT_MINE)',
    '}',
    '',
    'export class LaterClass {}',
    'export type LaterType = number',
    'export interface LaterInterface {}',
  ].join('\n')

  it.each(['export function', 'export class', 'export type', 'export interface'])(
    'stops at a following %s, not only at the next `export const`',
    () => {
      const body = bodyOf('target', source)
      expect(body).toContain('MINE')
      expect(body).not.toContain('NOT_MINE')
      expect(body.match(/wallet\.send\(/g)).toHaveLength(1)
    },
  )

  it('takes the rest of the module when the target is genuinely last', () => {
    expect(bodyOf('target', 'export const target = () => {\n  wallet.send(MINE)\n}\n')).toContain('MINE')
  })

  it('does not match a longer name that merely starts the same way', () => {
    const shadowed = 'export const targetDryRun = () => {\n  wallet.send(NOT_MINE)\n}\n'
    expect(() => bodyOf('target', shadowed)).toThrow(/target is gone/)
  })

  it('finds a function declaration, not only an arrow constant', () => {
    expect(bodyOf('target', 'export function target() {\n  wallet.send(MINE)\n}\n')).toContain('MINE')
  })
})
