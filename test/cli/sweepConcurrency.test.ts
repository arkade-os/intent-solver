/**
 * A source-level guard on ONE line of `createServices`, for the same reason as
 * `refundDestination.test.ts`: constructing the stack needs an Arkade wallet, a
 * Lightning node and a chain, none of which a unit test has.
 *
 * The defect this pins was invisible from both ends. `loadConfig` parsed
 * `SWEEP_CONCURRENCY` and validated it strictly enough to REFUSE bad input — so
 * the knob looked alive, and a wrong value even produced an error — while
 * `createServices` never passed the result to `SendSwapService`, which fell
 * back to its own private `SWEEP_CONCURRENCY = 8`. Setting it did nothing.
 * A test on either side alone passes: config really does parse it, and the
 * orchestrator really does honour the dep when given one. Only the wiring
 * between them was missing, and this is where it can go missing again.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const servicesSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/ops/services.ts', import.meta.url)),
  'utf8',
)

/** The dependency object `createServices` hands to the Lightning-send orchestrator. */
const sendServiceDeps = (): string => {
  const start = servicesSource.indexOf('new SendSwapService({')
  if (start === -1) throw new Error('createServices no longer constructs a SendSwapService at all')
  const end = servicesSource.indexOf('})', start)
  if (end === -1) throw new Error('unterminated SendSwapService construction in createServices')
  return servicesSource.slice(start, end)
}

describe('createServices — the sweep concurrency knob', () => {
  it('passes the configured value through, rather than leaving the orchestrator on its private default', () => {
    expect(sendServiceDeps()).toContain('sweepConcurrency: config.sweepConcurrency')
  })
})
