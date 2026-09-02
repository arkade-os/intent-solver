/**
 * A source-level guard on ONE line of `createServices`, exactly as
 * `sweepConcurrency.test.ts` is and for the same reason: `src/cli.ts` runs
 * `main()` and then `process.exit()` at module load and does not export
 * `createServices`, so importing it from a test would kill the runner.
 *
 * The gap it pins is the one that file documents recurring — `loadConfig`
 * parsing a knob strictly enough to REFUSE bad input, so the knob looks alive,
 * while `createServices` never hands the result to `SendSwapService`. A test on
 * either side alone passes: config really does parse the denylist, and the
 * orchestrator really does filter hints when given one. Only the wiring between
 * them can go missing.
 *
 * It is worth pinning here rather than trusted to a type, because the dep is
 * OPTIONAL — it has to be, so every existing test constructs a service without
 * it — and an optional dep silently defaults to the empty set. A deployment
 * that set the knob would then be told nothing and price every hint anyway,
 * which is the pre-denylist behaviour and looks exactly like an invoice the
 * denylist does not cover.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const servicesSource = readFileSync(fileURLToPath(new URL('../../src/ops/services.ts', import.meta.url)), 'utf8')

/** The dependency object `createServices` hands to the Lightning-send orchestrator. */
const sendServiceDeps = (): string => {
  const start = servicesSource.indexOf('new SendSwapService({')
  if (start === -1) throw new Error('createServices no longer constructs a SendSwapService at all')
  const end = servicesSource.indexOf('})', start)
  if (end === -1) throw new Error('unterminated SendSwapService construction in createServices')
  return servicesSource.slice(start, end)
}

describe('createServices — the route-hint scid denylist', () => {
  it('passes the configured set through, rather than leaving the orchestrator on an empty one', () => {
    expect(sendServiceDeps()).toContain('sendHintScidDenylist: config.sendHintScidDenylist')
  })

  it('logs what the denylist dropped, so the filter is not invisible', () => {
    // The denylist's only trace outside a config file: an operator who cannot
    // see the drop cannot tell a filtered quote from an unfiltered one.
    expect(servicesSource).toContain('service.onDroppedRouteHints =')
  })
})
