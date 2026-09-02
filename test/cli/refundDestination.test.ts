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

/** The assignment that picks where reclaimed onchain HTLC funds land. */
const refundDestinationLine = (): string => {
  const line = servicesSource.split('\n').find((l) => l.includes('refundDestinationScript:'))
  if (!line) throw new Error('createServices no longer resolves a refundDestinationScript at all')
  return line
}

describe('createServices — the reclaimed-onchain-funds destination', () => {
  it('resolves it from the same onchain backend that funded the HTLC', () => {
    // The derivation is inline in the OnchainSendSwapService construction:
    // the destination script is encoded from the onchain backend's own new
    // receive address, a line or two below the property name.
    const start = servicesSource.indexOf('refundDestinationScript:')
    expect(servicesSource.slice(start, start + 300)).toContain('onchain.newReceiveAddress()')
  })

  it('never routes it through an Arkade boarding address — that money never came from Arkade', () => {
    expect(refundDestinationLine()).not.toContain('getBoardingAddress')
  })
})
