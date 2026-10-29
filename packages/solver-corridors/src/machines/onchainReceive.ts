import { defineMachine, type StateOf } from '@arkade-os/solver-core/core/stateMachine.js'

export const OnchainReceiveMachine = defineMachine({
  quoted: { live: true, exposed: false, to: ['awaiting_confirmations', 'refused'] },
  // The self-edge re-adopts a fee-bumped client funding; nothing is exposed yet.
  awaiting_confirmations: { live: true, exposed: false, to: ['funding_arkade', 'refused', 'awaiting_confirmations'] },
  funding_arkade: { live: true, exposed: true, to: ['awaiting_claim', 'stuck'] },
  awaiting_claim: { live: true, exposed: true, to: ['claimed', 'refunding_arkade', 'stuck'] },
  claimed: { live: true, exposed: true, to: ['settled', 'stuck'] },
  settled: { live: false, exposed: false, to: [] },
  refunding_arkade: { live: true, exposed: true, to: ['claimed', 'refunded', 'stuck'] },
  refunded: { live: false, exposed: false, to: [] },
  refused: { live: false, exposed: false, to: [] },
  stuck: { live: false, exposed: false, to: [] },
})

export type OnchainReceiveSwapState = StateOf<typeof OnchainReceiveMachine>
