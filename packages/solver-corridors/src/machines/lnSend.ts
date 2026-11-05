import { defineMachine, type StateOf } from '@arkade-os/solver-core/core/stateMachine.js'

export const LnSendMachine = defineMachine({
  quoted: { live: true, exposed: false, to: ['funded', 'refused'] },
  // Coupled path: our node cannot pay its own invoice, so it claims straight off the preimage the client revealed.
  funded: { live: true, exposed: false, to: ['paying', 'claiming', 'refused'] },
  paying: { live: true, exposed: true, to: ['paid', 'stuck', 'refused'] },
  paid: { live: true, exposed: true, to: ['claiming', 'stuck', 'refused'] },
  claiming: { live: true, exposed: true, to: ['claimed', 'stuck'] },
  claimed: { live: false, exposed: false, to: [] },
  refused: { live: false, exposed: false, to: [] },
  stuck: { live: false, exposed: false, to: ['claiming', 'refused'] },
})

export type LnSendSwapState = StateOf<typeof LnSendMachine>
