/**
 * Does the offer's script actually encode the terms the offer states?
 *
 * Swap Protocol V1 § 5.1: "the swap pkScript reconstructed from the offer +
 * signer key MUST equal `SwapPkScript`. A taker MUST abort fulfillment on
 * mismatch (`offer inconsistency`)."
 *
 * The packet is attacker-supplied and its fields are read independently of the
 * script they claim to describe. Without this, a maker can advertise terms the
 * covenant does not enforce — cheap `wantAmount` in the TLV, a script obliging
 * something else — and a taker that priced the packet would spend the deposit
 * under terms it never checked.
 */
import { offerVtxoScript, type Offer } from '@arkade-os/swap/protocol'
import { hex } from '@scure/base'
import { offerCovenantVersionOf, type OfferCovenantVersion } from '@arkade-os/solver-core/core/offerCovenant.js'

export interface OfferCovenantMatch {
  version: OfferCovenantVersion
}

/**
 * The covenant version the offer's terms compile to, or null when the script
 * does not encode those terms.
 */
export const offerCovenantMatch = (offer: Offer, serverPubkey: Uint8Array): OfferCovenantMatch | null => {
  try {
    const matches = hex.encode(offerVtxoScript(offer, serverPubkey).pkScript) === hex.encode(offer.swapPkScript)
    return matches ? { version: offerCovenantVersionOf(offer) } : null
  } catch {
    return null
  }
}

/**
 * True when the offer's `swapPkScript` is the one its own terms compile to.
 *
 * Reconstruction can throw on a malformed offer — an unparsable program, a key
 * of the wrong length — and that is a mismatch, not an exception to propagate:
 * an offer whose script cannot be built is an offer whose script cannot agree.
 */
export const offerIsConsistent = (offer: Offer, serverPubkey: Uint8Array): boolean => {
  return offerCovenantMatch(offer, serverPubkey) !== null
}
