import type { AdminSwap } from '@arkade-os/solver-core/core/swapView.js'
import {
  projectSend,
  projectReceive,
  projectOnchainSend,
  projectOnchainReceive,
} from '@arkade-os/solver-corridors/corridors/projections.js'
import type { Services } from '../ops/services.js'

/** Every non-terminal swap in the four BTC corridors, projected; the overview and change feed both read this. */
export const liveSwaps = async (services: Services): Promise<AdminSwap[]> => {
  const [send, receive, onchainSend, onchainReceive] = await Promise.all([
    services.store.findRecoverable(),
    services.receiveStore.findRecoverable(),
    services.onchainStore.findRecoverable(),
    services.onchainReceiveStore.findRecoverable(),
  ])
  return [
    ...send.map(projectSend),
    ...receive.map(projectReceive),
    ...onchainSend.map(projectOnchainSend),
    ...onchainReceive.map(projectOnchainReceive),
  ]
}
