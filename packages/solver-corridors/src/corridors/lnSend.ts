import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import { LnSendMachine, type LnSendSwapState } from '../machines/lnSend.js'

/**
 * `delivered` is `claimed`, not `paid`: the solver has delivered once it has
 * claimed the client's lockup, which is the point it is made whole.
 */
export const LN_SEND: CorridorDescriptor<LnSendSwapState> = {
  pair: 'arkade:BTC->lightning:BTC',
  envStem: 'LN_SEND',
  payoutRail: 'lightning',
  states: {
    live: LnSendMachine.live,
    exposed: LnSendMachine.exposed,
    delivered: ['claimed'],
  },
}
