import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import { RFQ_ONCHAIN_SEND_V2 } from '@arkade-os/solver-core/core/rfqContract.js'
import { OnchainSendMachine, type OnchainSendSwapState } from '../machines/onchainSend.js'

export const ONCHAIN_SEND: CorridorDescriptor<OnchainSendSwapState> = {
  pair: 'arkade:BTC->onchain:BTC',
  envStem: 'ONCHAIN_SEND',
  contractVersion: RFQ_ONCHAIN_SEND_V2,
  payoutRail: 'onchain',
  states: {
    live: OnchainSendMachine.live,
    exposed: OnchainSendMachine.exposed,
    delivered: ['claimed'],
  },
}
