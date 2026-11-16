import type { AdminSwap } from '@arkade-os/solver-core/core/swapView.js'
import { projectSend, projectReceive, projectOnchainSend } from '@arkade-os/solver-corridors/corridors/projections.js'
import type { Services } from '../ops/services.js'

/** Every non-terminal swap in the three BTC corridors, projected; the overview and change feed both read this. */
export const liveSwaps = async (services: Services): Promise<AdminSwap[]> => {
  const [send, receive, onchainSend] = await Promise.all([
    services.store.findRecoverable(),
    services.receiveStore.findRecoverable(),
    services.onchainStore.findRecoverable(),
  ])
  return [...send.map(projectSend), ...receive.map(projectReceive), ...onchainSend.map(projectOnchainSend)]
}
