/**
 * A source-level guard that `createServices` actually honours stored overrides.
 *
 * This exists because it was WRONG once, in the way that is hardest to notice:
 * the console persisted an override, displayed it as active, and told the
 * operator a restart would apply it — while `createServices` built every
 * service straight from the environment and never read the store. The UI said
 * "saved, restart to apply", the restart ignored it, and the solver kept
 * quoting the old fee with nothing anywhere reporting a problem.
 *
 * Asserted against the source text rather than by calling the function, because
 * constructing the stack needs live backends a unit test has none of.
 *
 * Two sources. `createServices` lives in `packages/solver-app/src/ops/services.ts`; the `card`
 * command and the transport wiring checked below are still in `packages/solver-app/src/cli.ts`,
 * which runs `main()` then `process.exit()` at module load and exports nothing,
 * so importing IT from a test would kill the runner.
 *
 * The pairing that matters: `routes/settings.ts`'s RESTART_NOTICE promises a
 * restart applies the override, and this file is what makes that promise true.
 * Deleting either one alone should fail the other's test.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CORRIDORS } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'
import { createServicesBody } from '../support/createServicesBody.js'

const cliSource = readFileSync(fileURLToPath(new URL('../../packages/solver-app/src/cli.ts', import.meta.url)), 'utf8')
const createServices = createServicesBody

/** The body of the `card` command, up to the command that follows it. */
const cardCommand = (): string => {
  const start = cliSource.indexOf('  async card([nameArg]) {')
  if (start === -1) throw new Error('the card command is gone')
  const rest = cliSource.slice(start)
  const end = rest.indexOf('\n  async ', 1)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('createServices resolves stored overrides', () => {
  it('reads the override store and layers it onto the environment', () => {
    const body = createServices()
    expect(body).toContain('applyOverrides(config, await adminStore.getOverrides())')
  })

  it('resolves the policy BEFORE constructing any service', () => {
    const body = createServices()
    expect(body.indexOf('applyOverrides(config,')).toBeLessThan(body.indexOf('new SendSwapService'))
  })

  it('hands every corridor its effective limits and fee, never the raw environment', () => {
    const body = createServices()
    for (const corridor of CORRIDORS) {
      expect(body, descriptorFor(corridor).envStem).toContain(`limits: policy.corridorLimits['${corridor}']`)
      expect(body, descriptorFor(corridor).envStem).toContain(`fee: policy.corridorFees['${corridor}']`)
    }
    // The raw environment must not reach a constructor for these.
    expect(body).not.toContain('limits: config.corridorLimits')
    expect(body).not.toContain('fee: config.corridorFees')
    expect(body).not.toContain('maxExposedSats: config.maxExposedSats')
  })

  it('gates corridor construction on the effective toggle', () => {
    expect(createServices()).toContain('policy.corridorEnabled[corridor]')
  })

  it('still exposes the ENVIRONMENT config, which the corridor-enable rules depend on', () => {
    // validateOverride and describeSettings both read Services.config to decide
    // whether a corridor may be re-enabled at all: one the environment disabled
    // has no service object to enable. Handing them the already-layered policy
    // would lose the difference between "off in env" and "off by override".
    const body = createServices()
    expect(body).toMatch(/return \{\s*config,\s*policy,/)
  })
})

describe('what must agree with the quoted terms reads policy, not env', () => {
  it('the ingress corridor gate', () => {
    // The raw environment must never gate a corridor — that part is unchanged.
    expect(cliSource).not.toContain('enabled(config,')

    // One gate, applied once: `corridorEnabled` decides whether a service is
    // constructed (pinned above), and a corridor is in `services.corridors` iff
    // its service exists. A transport that derives its own set instead drops
    // every EVM corridor — that set carries no EVM store or policy — so quoting
    // and driving disagree with nothing at the call site showing it.
    for (const transport of ['buildApp({', 'new RelayIngress({']) {
      const at = cliSource.indexOf(transport)
      expect(at, `${transport} not found in cli.ts`).toBeGreaterThan(-1)
      expect(cliSource.slice(at, at + 400), transport).toContain('corridors: services.corridors')
    }
  })

  it('the open-RFQ bidder, so a bid cannot promise terms the corridor refuses', () => {
    expect(cliSource).toContain("limits: services.policy.corridorLimits['arkade:BTC->lightning:BTC']")
    expect(cliSource).toContain("fee: services.policy.corridorFees['arkade:BTC->lightning:BTC']")
  })

  it('the registry card, which would otherwise advertise a fee nobody charges', () => {
    // Scoped to the CARD COMMAND, not the whole file. The previous form looked
    // for `policy.corridorFees['arkade:BTC->lightning:BTC']` anywhere in
    // `packages/solver-app/src/cli.ts` — and passed while the card was built from `config`,
    // because a dead `lnFees` binding and an LN_SEND guard that no longer
    // gated anything still carried those exact strings. A whole-file substring
    // cannot tell the code under test from the code about to be deleted.
    const body = cardCommand()
    expect(body).toContain('policy.corridorEnabled[corridor]')
    expect(body).toContain('limits: policy.corridorLimits[corridor]')
    expect(body).toContain('fee: policy.corridorFees[corridor]')
    // The raw environment must not reach the published card: an override that
    // narrows a corridor, or silences one, has to show up in the listing.
    // Otherwise `cli card` and the console's `/api/card` print different cards
    // for one deployment, which is the drift this whole file guards.
    expect(body).not.toContain('config.corridorEnabled')
    expect(body).not.toContain('config.corridorLimits')
    expect(body).not.toContain('config.corridorFees')
    // And no gate on ONE named corridor. The card used to refuse outright
    // unless Lightning send was enabled, which was honest when that was the
    // only market it could publish and became a lie the moment it could
    // publish onchain ones: the console served an onchain-only deployment a
    // card while `cli card` refused to build the same one. `buildSolverCard`
    // refusing when NOTHING is served is the whole of the check now.
    expect(body).not.toContain("corridorEnabled['arkade:BTC->lightning:BTC']")
  })
})
