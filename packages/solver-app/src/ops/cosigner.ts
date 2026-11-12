import { defaultEmulatorPubkey, getNetwork, type NetworkName } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { NETWORKS, type SwapNetwork } from '@arkade-os/solver-core/core/networks.js'

// An emulator reporting arkd's own signer key means co-signing moved into arkd: keep the network
// pin, which clients still derive with. Any other report is this deployment's co-signer and stays.
export const covenantCosignerKey = (network: SwapNetwork, reported: string, operatorKey: Uint8Array): string => {
  if (reported.slice(-64).toLowerCase() !== hex.encode(operatorKey.slice(-32))) return reported
  try {
    return defaultEmulatorPubkey(getNetwork(NETWORKS[network].arkdNetwork as NetworkName))
  } catch {
    return reported
  }
}
