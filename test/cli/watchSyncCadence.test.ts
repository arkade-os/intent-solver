/**
 * A source-level guard, for the reason `appInjection.test.ts` states:
 * `watchUntilStopped` is module-private and `cli.ts` runs `main()` at module
 * load, so importing it runs the CLI instead of the loop.
 *
 * The defect it pins is invisible from either end: a script reached the
 * subscription only from `resyncWatchedScripts`, which ran INSIDE the
 * `FULL_SWEEP_MS` branch — after that same sweep had already polled the row. So
 * the first funding was always found by the poll and never by the event, while
 * the watcher tests and the sweep tests both stayed green.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cliSource = readFileSync(fileURLToPath(new URL('../../packages/solver-app/src/cli.ts', import.meta.url)), 'utf8')

/** The cadence guard the adoption call actually sits under: the nearest one above it. */
const guardOverAdoption = (): string => {
  const call = cliSource.indexOf('await resyncWatchedScripts()')
  if (call === -1) throw new Error('the watch loop no longer resyncs the watched scripts at all')
  const guards = [...cliSource.slice(0, call).matchAll(/if \(Date\.now\(\) - (\w+) >=? (\w+)\)/g)]
  const nearest = guards.at(-1)?.[2]
  if (!nearest) throw new Error('the adoption call is under no cadence guard at all')
  return nearest
}

const constant = (name: string): number => {
  const match = cliSource.match(new RegExp(`const ${name} = ([0-9_]+)`))?.[1]
  if (!match) throw new Error(`the watch loop no longer defines ${name}`)
  return Number(match.replaceAll('_', ''))
}

describe('the watch loop — adopting a script is not the indexer sweep', () => {
  it('does not gate script adoption on the full sweep', () => {
    expect(guardOverAdoption()).not.toBe('FULL_SWEEP_MS')
  })

  it('adopts on its own faster cadence, so a new swap is watched before it is funded', () => {
    expect(guardOverAdoption()).toBe('WATCH_SYNC_MS')
    expect(constant('WATCH_SYNC_MS')).toBeLessThan(constant('FULL_SWEEP_MS'))
  })

  it('leaves the indexer sweep at 3s, which is the deadline safety net and the EVM legs only driver', () => {
    expect(constant('FULL_SWEEP_MS')).toBe(3000)
  })
})
