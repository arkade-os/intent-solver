import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import { RFQ_LIGHTNING_RECEIVE_V2 } from '@arkade-os/solver-core/core/rfqCovenant.js'
import type { ReceiveSwapState } from '../db/receiveSwaps.js'

export const LN_RECEIVE: CorridorDescriptor<ReceiveSwapState> = {
  pair: 'lightning:BTC->arkade:BTC',
  envStem: 'LN_RECEIVE',
  covenantVersion: RFQ_LIGHTNING_RECEIVE_V2,
  payoutRail: 'arkade',
  states: {
    live: ['quoted', 'armed', 'funded', 'claimed', 'refunding'],
    exposed: ['funded', 'claimed', 'refunding'],
    delivered: ['settled'],
  },
}
