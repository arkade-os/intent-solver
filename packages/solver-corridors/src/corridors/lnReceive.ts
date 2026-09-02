import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import type { ReceiveSwapState } from '../db/receiveSwaps.js'

export const LN_RECEIVE: CorridorDescriptor<ReceiveSwapState> = {
  pair: 'lightning:BTC->arkade:BTC',
  envStem: 'LN_RECEIVE',
  payoutRail: 'arkade',
  states: {
    live: ['quoted', 'armed', 'funded', 'claimed', 'refunding'],
    exposed: ['funded', 'claimed', 'refunding'],
    delivered: ['settled'],
  },
}
