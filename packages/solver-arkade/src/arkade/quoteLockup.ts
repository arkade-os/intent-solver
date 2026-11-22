import { ArkAddress } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import type { UnilateralDelays } from '@arkade-os/solver-core/core/timelocks.js'
import { CovenantSwapScript } from './covenant.js'

/**
 * The pkScript of an Arkade address on this network, or null when `address` is not one.
 *
 * With `onServer`, only an address that lives on that Arkade server: a covenant refund pushed to another
 * deployment's address can be spent only with that other server's cooperation. Null accepts any server.
 */
export const arkadeAddressPkScript = (address: string, hrp: string, onServer: string | null): Uint8Array | null => {
  try {
    const decoded = ArkAddress.decode(address)
    const pkScript = decoded.pkScript
    if (!address.toLowerCase().startsWith(`${hrp}1`)) return null
    if (onServer !== null && hex.encode(decoded.serverPubKey) !== onServer) return null
    return pkScript
  } catch {
    return null
  }
}

export interface ClientFundedLockup {
  paymentHash: string
  refundLocktime: number
  delays: UnilateralDelays
  clientRefundPubkey: string
  refundPkScript: Uint8Array
}

/**
 * The covenant script of a lockup the client funds and the solver claims with the preimage.
 *
 * Always the full covenant suite, no legacy selector: see `NonInteractiveParameters.legacy`.
 */
export const clientFundedLockupScript = (
  arkade: { providerPubkey: string; serverPubkey: string; emulatorPubkey: string; receiverPkScript: string },
  lockup: ClientFundedLockup,
): CovenantSwapScript =>
  new CovenantSwapScript({
    receiver: hex.decode(arkade.providerPubkey),
    server: hex.decode(arkade.serverPubkey),
    // The 20-byte ripemd160(sha256(P)) the script wants, never the wire's sha256 form.
    preimageHash: scriptHashFromPaymentHash(lockup.paymentHash),
    refundLocktime: lockup.refundLocktime,
    claimDelay: lockup.delays.unilateralClaimDelay,
    client: hex.decode(lockup.clientRefundPubkey),
    clientRefundDelay: lockup.delays.unilateralRefundWithoutReceiverDelay,
    refundWithoutServerDelay: lockup.delays.unilateralRefundDelay,
    nonInteractiveParameters: {
      emulatorPubkey: hex.decode(arkade.emulatorPubkey),
      receiverPkScript: hex.decode(arkade.receiverPkScript),
      senderPkScript: lockup.refundPkScript,
    },
  })
