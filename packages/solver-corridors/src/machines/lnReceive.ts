import { defineMachine, type StateOf } from '@arkade-os/solver-core/core/stateMachine.js'

// `exposed`: the provider's OWN Arkade lockup may be funded and not yet made whole.
export const LnReceiveMachine = defineMachine({
  quoted: { live: true, exposed: false, to: ['armed', 'refused'] },
  armed: { live: true, exposed: false, to: ['funded', 'refused'] },
  funded: { live: true, exposed: true, to: ['claimed', 'refunding', 'refunded', 'stuck'] },
  claimed: { live: true, exposed: true, to: ['settled', 'stuck'] },
  refunding: { live: true, exposed: true, to: ['refunded', 'claimed', 'stuck'] },
  settled: { live: false, exposed: false, to: [] },
  refunded: { live: false, exposed: false, to: [] },
  refused: { live: false, exposed: false, to: [] },
  stuck: { live: false, exposed: false, to: [] },
})

export type LnReceiveSwapState = StateOf<typeof LnReceiveMachine>
