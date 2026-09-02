import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import type { OnchainReceiveSwapState } from '../db/onchainReceiveSwaps.js'

export const ONCHAIN_RECEIVE: CorridorDescriptor<OnchainReceiveSwapState> = {
  pair: 'onchain:BTC->arkade:BTC',
  envStem: 'ONCHAIN_RECEIVE',
  payoutRail: 'arkade',
  states: {
    live: ['quoted', 'awaiting_confirmations', 'funding_arkade', 'awaiting_claim', 'claimed', 'refunding_arkade'],
    exposed: ['funding_arkade', 'awaiting_claim', 'claimed', 'refunding_arkade'],
    delivered: ['settled'],
  },
}
