import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import type { SendSwapState } from '../db/swaps.js'

/**
 * `delivered` is `claimed`, not `paid`: the solver has delivered once it has
 * claimed the client's lockup, which is the point it is made whole.
 */
export const LN_SEND: CorridorDescriptor<SendSwapState> = {
  pair: 'arkade:BTC->lightning:BTC',
  envStem: 'LN_SEND',
  payoutRail: 'lightning',
  states: {
    live: ['quoted', 'funded', 'paying', 'paid', 'claiming'],
    exposed: ['paying', 'paid', 'claiming'],
    delivered: ['claimed'],
  },
}
