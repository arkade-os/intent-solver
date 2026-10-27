import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import { OnchainReceiveMachine, type OnchainReceiveSwapState } from '../machines/onchainReceive.js'

export const ONCHAIN_RECEIVE: CorridorDescriptor<OnchainReceiveSwapState> = {
  pair: 'onchain:BTC->arkade:BTC',
  envStem: 'ONCHAIN_RECEIVE',
  payoutRail: 'arkade',
  states: {
    live: OnchainReceiveMachine.live,
    exposed: OnchainReceiveMachine.exposed,
    delivered: ['settled'],
  },
}
