import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import { RFQ_LIGHTNING_RECEIVE_V2 } from '@arkade-os/solver-core/core/rfqCovenant.js'
import { LnReceiveMachine, type LnReceiveSwapState } from '../machines/lnReceive.js'

export const LN_RECEIVE: CorridorDescriptor<LnReceiveSwapState> = {
  pair: 'lightning:BTC->arkade:BTC',
  envStem: 'LN_RECEIVE',
  covenantVersion: RFQ_LIGHTNING_RECEIVE_V2,
  payoutRail: 'arkade',
  states: {
    live: LnReceiveMachine.live,
    exposed: LnReceiveMachine.exposed,
    delivered: ['settled'],
  },
}
