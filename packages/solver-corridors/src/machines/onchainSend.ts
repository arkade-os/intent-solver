import { defineMachine, type StateOf } from '@arkade-os/solver-core/core/stateMachine.js'

// `owesPayout`: the float has yet to cover the payout. Past funding it is already
// broadcast, and counting it twice would reserve the same sats twice.
// `outgoing`: sats may be on their way out of the rail's wallet.
export const OnchainSendMachine = defineMachine({
  quoted: { live: true, exposed: false, owesPayout: true, to: ['funded', 'refused'] },
  funded: { live: true, exposed: false, owesPayout: true, outgoing: true, to: ['funding_onchain', 'refused'] },
  funding_onchain: {
    live: true,
    exposed: true,
    owesPayout: true,
    outgoing: true,
    to: ['awaiting_claim', 'stuck'],
  },
  awaiting_claim: { live: true, exposed: true, outgoing: true, to: ['claiming', 'refunding_onchain', 'stuck'] },
  claiming: { live: true, exposed: true, outgoing: true, to: ['claimed', 'stuck'] },
  refunding_onchain: { live: true, exposed: true, outgoing: true, to: ['claiming', 'refunded', 'stuck'] },
  claimed: { live: false, exposed: false, to: [] },
  refunded: { live: false, exposed: false, to: [] },
  refused: { live: false, exposed: false, to: [] },
  stuck: { live: false, exposed: false, outgoing: true, to: [] },
})

export type OnchainSendSwapState = StateOf<typeof OnchainSendMachine>
