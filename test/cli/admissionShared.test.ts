/**
 * A source-level guard that `createServices` hands every corridor the SAME
 * admission control, and opens its stores through the layout. Asserted against
 * the source text because constructing the stack needs live backends — an
 * Arkade wallet, a Lightning node and a chain — none of which a unit test has.
 *
 * Two sources, deliberately. `createServices` now lives in `packages/solver-app/src/ops/services.ts`;
 * the `card` command that the last assertion covers is still in `packages/solver-app/src/cli.ts`,
 * which runs `main()` and `process.exit()` at module load and so can never be
 * imported by a test at all.
 *
 * `admission` is a REQUIRED dep, so omitting it entirely is a compile error
 * (TS2345) rather than something these assertions have to catch — that is the
 * primary guard, and these are belt and braces behind it.
 *
 * What the compiler still cannot see is the part that matters most: passing
 * FOUR SEPARATE controls type-checks perfectly and is silently wrong. Each one
 * bounds its own corridor, every single-corridor test keeps passing, and the
 * global cap #96 introduced quietly becomes per-corridor again — which is the
 * bound #105 is about. Counting constructions is what pins that.
 *
 * The layout assertions are here for the same reason: opening a store by a
 * hardcoded suffixed path instead of the layout works perfectly on a legacy
 * deployment and silently creates an empty second database on a consolidated
 * one. Both failures type-check.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServicesBody } from '../support/createServicesBody.js'

const cliSource = readFileSync(fileURLToPath(new URL('../../packages/solver-app/src/cli.ts', import.meta.url)), 'utf8')

describe('createServices — one admission control for every corridor', () => {
  it('constructs exactly one AdmissionControl', () => {
    const constructions = createServicesBody().match(/new AdmissionControl\(\)/g) ?? []
    expect(constructions).toHaveLength(1)
  })

  it('passes it to every corridor service, EVM included', () => {
    // One `admission,` per service, beside the `totalCommitted,` each already
    // takes — a service missing it silently falls back to a private control,
    // which bounds that corridor alone rather than the house.
    //
    // SIX, not four. This assertion said FOUR while two more services already
    // existed, so it kept passing and quietly stopped covering the ones it was
    // written for: the EVM corridors took `totalCommitted` WITHOUT the control,
    // and their quote() did a plain read-then-check. Two concurrent quotes could
    // each read the same pre-commit total and both pass a cap only one fits
    // under — the #105 race, reopened for two corridors and invisible because
    // the number was hard-coded to the corridors that existed when it was written.
    // SEVEN since the onchain asset receive leg. This number tracks reality on
    // purpose — the paragraph above is what happened the last time it did not.
    const body = createServicesBody()
    expect(body.match(/^\s*admission,$/gm) ?? []).toHaveLength(7)
    expect(body.match(/^\s*totalCommitted,$/gm) ?? []).toHaveLength(7)
  })
})

describe('createServices — stores follow the resolved layout', () => {
  it('resolves the layout rather than deriving paths inline', () => {
    const body = createServicesBody()
    expect(body).toContain('resolveDbLayout(config.swapDbPath)')
    // The suffix rule lives in src/db/layout.ts now. Re-deriving it here is how
    // the two drift apart, which is what put the wrong files in the runbook.
    expect(body).not.toMatch(/'-onchain\.sqlite'|`-\$\{suffix\}\.sqlite`/)
  })

  it('opens every store on the shared driver when consolidated', () => {
    const body = createServicesBody()
    for (const store of [
      'SwapStore.open',
      'OnchainSendSwapStore.open',
      'ReceiveSwapStore.open',
      'OnchainReceiveSwapStore.open',
      'AdminStore.open',
    ]) {
      const at = body.indexOf(`${store}(`)
      expect(at, `${store} is not opened in createServices`).toBeGreaterThan(-1)
      // `shared ?? layout.x` — the shared connection when there is one, that
      // store's own file when there is not.
      expect(body.slice(at, at + 120)).toMatch(/shared \?\? layout\./)
    }
  })

  it('opens the card command’s admin store through the layout too', () => {
    // Outside createServices: `card` builds no service stack but still reads
    // overrides, and reading them from the wrong file publishes a card with
    // limits the operator already narrowed.
    const at = cliSource.indexOf('AdminStore.open(resolveDbLayout(')
    expect(at, 'the card command bypasses the layout').toBeGreaterThan(-1)
  })
})
