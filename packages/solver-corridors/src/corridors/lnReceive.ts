import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import { LnReceiveMachine, type LnReceiveSwapState } from '../machines/lnReceive.js'

export const LN_RECEIVE: CorridorDescriptor<LnReceiveSwapState> = {
  pair: 'lightning:BTC->arkade:BTC',
  envStem: 'LN_RECEIVE',
  payoutRail: 'arkade',
  states: {
    live: LnReceiveMachine.live,
    exposed: LnReceiveMachine.exposed,
    delivered: ['settled'],
  },
}
