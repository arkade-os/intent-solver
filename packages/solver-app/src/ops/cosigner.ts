import { defaultEmulatorPubkey, getNetwork, type NetworkName } from '@arkade-os/sdk'
import { NETWORKS, type SwapNetwork } from '@arkade-os/solver-core/core/networks.js'

// The SDK's pin, which clients derive with: the emulator's own report could move every new quote
// off it. Only a network without a pin keeps the report.
export const covenantCosignerKey = (network: SwapNetwork, reported: string): string => {
  const arkdNetwork = getNetwork(NETWORKS[network].arkdNetwork as NetworkName)
  try {
    return defaultEmulatorPubkey(arkdNetwork)
  } catch {
    return reported // no pin on this network
  }
}
