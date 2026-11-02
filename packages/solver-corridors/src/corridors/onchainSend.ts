import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import { OnchainSendMachine, type OnchainSendSwapState } from '../machines/onchainSend.js'

export const ONCHAIN_SEND: CorridorDescriptor<OnchainSendSwapState> = {
  pair: 'arkade:BTC->onchain:BTC',
  envStem: 'ONCHAIN_SEND',
  payoutRail: 'onchain',
  states: {
    live: OnchainSendMachine.live,
    exposed: OnchainSendMachine.exposed,
    delivered: ['claimed'],
  },
}
