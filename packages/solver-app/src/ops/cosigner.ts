import { defaultEmulatorPubkey, getNetwork, type NetworkName } from '@arkade-os/sdk'
import { NETWORKS, type SwapNetwork } from '@arkade-os/solver-core/core/networks.js'

// The SDK pin is what clients derive with: once the emulator reports the operator's own key, a live
// read would move every new quote off it. Only networks without a pin keep the report.
export const covenantCosignerKey = (network: SwapNetwork, reported: string): string => {
  try {
    return defaultEmulatorPubkey(getNetwork(NETWORKS[network].arkdNetwork as NetworkName))
  } catch {
    return reported
  }
}
