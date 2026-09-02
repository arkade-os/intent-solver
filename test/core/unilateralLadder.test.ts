import { describe, it, expect } from 'vitest'
import {
  deriveUnilateralDelays,
  SEQUENCE_GRANULARITY_SECONDS,
  SOLO_REFUND_HEADROOM_SECONDS,
} from '@arkade-os/solver-core/core/timelocks.js'

/**
 * The ladder's safety property, which had NO test until now — which is exactly
 * how a change that inverted it once reached a green CI run.
 *
 * The three leaves are not interchangeable rungs. What each one times is a
 * different party's recourse (`src/arkade/covenant.ts`):
 *
 *   unilateralClaim                  receiver alone, holding the preimage
 *   unilateralRefund                 client AND receiver — needs both
 *   unilateralRefundWithoutReceiver  client alone, needing nobody
 *
 * Only the last is a solo path for the funder, so it is the only one whose
 * timing can steal: a funder able to refund before the claimant can claim takes
 * money from someone holding the preimage. The both-signature leaf cannot be
 * used unilaterally by either party, so it needs no separation at all.
 */
describe('deriveUnilateralDelays — the ladder that stops a funder preempting a claimant', () => {
  const LADDERS = [512, 1536, 3600, 24 * 3600, 7 * 24 * 3600]

  it('opens the solo refund strictly after the claim, at every scale', () => {
    for (const exitDelay of LADDERS) {
      const d = deriveUnilateralDelays(exitDelay)
      expect(d.unilateralRefundWithoutReceiverDelay).toBeGreaterThan(d.unilateralClaimDelay)
    }
  })

  it('gives the claimant real headroom, not a single granularity tick', () => {
    // The gap has to cover an actual unilateral exit — an unroll plus
    // confirmations — not merely be non-zero.
    for (const exitDelay of LADDERS) {
      const d = deriveUnilateralDelays(exitDelay)
      expect(d.unilateralRefundWithoutReceiverDelay - d.unilateralClaimDelay).toBeGreaterThanOrEqual(
        SOLO_REFUND_HEADROOM_SECONDS,
      )
    }
  })

  it('puts claim and the both-signature refund on par', () => {
    // Nobody can spend the both-signature leaf alone, so separating it buys no
    // safety and only shortens the headroom that does.
    for (const exitDelay of LADDERS) {
      const d = deriveUnilateralDelays(exitDelay)
      expect(d.unilateralRefundDelay).toBe(d.unilateralClaimDelay)
    }
  })

  it('keeps every delay on a BIP68 512-second boundary', () => {
    // Anything else is silently rounded by the encoding, so a value that looks
    // right in config becomes a different timelock in the script.
    for (const exitDelay of LADDERS) {
      const d = deriveUnilateralDelays(exitDelay)
      for (const value of Object.values(d)) {
        expect(value % SEQUENCE_GRANULARITY_SECONDS).toBe(0)
      }
    }
  })

  it('never opens any leaf before the operator own exit delay', () => {
    // The server refuses a script whose exit delay is below its configured
    // minimum, and it does so at SPEND time — with money already in the script.
    for (const exitDelay of LADDERS) {
      const d = deriveUnilateralDelays(exitDelay)
      for (const value of Object.values(d)) {
        expect(value).toBeGreaterThanOrEqual(exitDelay)
      }
    }
  })
})
