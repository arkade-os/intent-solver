/**
 * A source-level guard on ONE line of `createServices`, deliberately.
 *
 * The onchain orchestrator is agnostic about where a refund goes — it just
 * spends to the `refundDestinationScript` it is handed (see the synthetic
 * script in test/send/onchainOrchestrator.test.ts). The choice of destination
 * lives entirely in the CLI's wiring, so that is the only place this
 * regression can reappear, and `refundDestinationScript` being wrong is
 * invisible to every runtime test.
 *
 * It is asserted against the source text rather than by calling the function
 * because constructing services needs live backends
 * and does not export `createServices` — importing it from a test would kill
 * the runner.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const servicesSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/ops/services.ts', import.meta.url)),
  'utf8',
)

/**
 * The binding that picks where reclaimed onchain HTLC funds land.
 *
 * A named const rather than an expression inline in the constructor call: the
 * send corridor's fee sizing needs the same script (it is the wallet's own, and
 * so the best evidence of what its change output costs), and one derivation
 * read twice cannot drift the way two copies would.
 */
const refundDestinationBinding = (): string => {
  const start = servicesSource.indexOf('const onchainRefundDestinationScript')
  if (start === -1) throw new Error('createServices no longer resolves a refund destination at all')
  return servicesSource.slice(start, start + 300)
}

describe('createServices — the reclaimed-onchain-funds destination', () => {
  it('resolves it from the same onchain backend that funded the HTLC', () => {
    expect(refundDestinationBinding()).toContain('onchain.newReceiveAddress()')
  })

  it('never routes it through an Arkade boarding address — that money never came from Arkade', () => {
    expect(refundDestinationBinding()).not.toContain('getBoardingAddress')
  })

  it('hands the orchestrator that binding and not a second derivation', () => {
    // The property could just as easily be given its own `newReceiveAddress()`
    // call, which would compile, pass both assertions above, and quietly point
    // the fee sizing at a different script than the refund actually pays.
    const line = servicesSource.split('\n').find((l) => l.includes('refundDestinationScript:'))
    if (!line) throw new Error('createServices no longer passes a refundDestinationScript at all')
    expect(line).toContain('onchainRefundDestinationScript')
  })
})
