import { defineMachine, type StateOf } from '@arkade-os/solver-core/core/stateMachine.js'

// `holdsOfferScript`: the offer covenant at this script is ours, so no second negotiation may watch it.
// `outgoing`: a fill transaction paying the client may be in flight.
// Exposed only in `filling`: `fulfill` pays the client and takes the deposit in one transaction.
export const AssetRfqMachine = defineMachine({
  // `-> refused` from `funded` too: a deposit can be seen after the quote has expired.
  quoted: { live: true, exposed: false, holdsOfferScript: true, to: ['funded', 'refused'] },
  funded: { live: true, exposed: false, holdsOfferScript: true, to: ['filling', 'refused'] },
  // No edge back to `funded`: an unknown outcome is `stuck`, never a retry (`revertUnsubmitted` is off-graph).
  filling: { live: true, exposed: true, holdsOfferScript: true, outgoing: true, to: ['filled', 'stuck'] },
  filled: { live: false, exposed: false, holdsOfferScript: true, to: [] },
  refused: { live: false, exposed: false, to: [] },
  stuck: { live: false, exposed: false, to: [] },
})

export type AssetRfqSwapState = StateOf<typeof AssetRfqMachine>
