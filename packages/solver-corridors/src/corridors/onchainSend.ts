import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import type { OnchainSendSwapState } from '../db/onchainSwaps.js'

export const ONCHAIN_SEND: CorridorDescriptor<OnchainSendSwapState> = {
  pair: 'arkade:BTC->onchain:BTC',
  envStem: 'ONCHAIN_SEND',
  payoutRail: 'onchain',
  states: {
    live: ['quoted', 'funded', 'funding_onchain', 'awaiting_claim', 'claiming', 'refunding_onchain'],
    exposed: ['funding_onchain', 'awaiting_claim', 'claiming', 'refunding_onchain'],
    delivered: ['claimed'],
  },
}
