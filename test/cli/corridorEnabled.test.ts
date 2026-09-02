/**
 * A source-level guard that `createServices` constructs ONLY the enabled
 * corridors' services — the mechanism issue #43 asks for, in the one place a
 * regression would reappear. Asserted against the source text because
 * constructing the stack needs live backends, which a unit test has none of.
 *
 * Two sources: the factory lives in `src/ops/services.ts`, while the operator
 * COMMANDS whose `allCorridors` opt-out is checked below are still in
 * `src/cli.ts` — a module that runs `main()` and `process.exit()` at import and
 * so can never be called from a test at all.
 *
 * Worth pinning because the failure is silent in every runtime test: an
 * unconditionally-constructed service still answers RFQs correctly — the
 * `<CORRIDOR>_ENABLED=false` deployment is simply never exercised here.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServicesBody } from '../support/createServicesBody.js'

const cliSource = readFileSync(fileURLToPath(new URL('../../src/cli.ts', import.meta.url)), 'utf8')

describe('createServices — corridor enablement', () => {
  it.each([
    ['arkade:BTC->lightning:BTC', 'SendSwapService'],
    ['arkade:BTC->onchain:BTC', 'OnchainSendSwapService'],
    ['lightning:BTC->arkade:BTC', 'ReceiveSwapService'],
    ['onchain:BTC->arkade:BTC', 'OnchainReceiveSwapService'],
  ])('constructs %s only when enabled', (corridor, serviceClass) => {
    const body = createServicesBody()
    expect(body).toContain(`enabled('${corridor}')`)
    // The construction is the conditional's branch, not a standalone
    // statement — an unconditional `new` here would serve the corridor even
    // with its knob off.
    expect(body).toMatch(
      new RegExp(`enabled\\('${corridor.replace(/[:>]/g, (c) => `\\${c}`)}'\\)[^;]*\\? new ${serviceClass}`),
    )
  })

  it('keeps the operator recovery commands able to unwind a disabled corridor’s rows', () => {
    // refund / onchain-refund-now / reclaim-l1-htlc open no ingress, so the
    // enable flags must not gate them: a corridor darkened with live rows
    // still needs its refunds pushable.
    for (const command of ["'onchain-refund-now'", "'reclaim-l1-htlc'", 'async refund()']) {
      const at = cliSource.indexOf(command)
      expect(at).toBeGreaterThan(-1)
      expect(cliSource.slice(at, at + 800)).toContain('allCorridors: true')
    }
  })
})
