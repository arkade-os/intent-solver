/**
 * Preimage-hash bridging for the swap script.
 *
 * The two sides do not agree on the hash: a BOLT11 payment hash is `sha256(P)`,
 * while the swap script's HASH160 branch commits to `ripemd160(sha256(P))`.
 * Applying ripemd160 to the invoice's payment hash bridges them — which is why
 * the send leg never needs to see P before the payment itself yields it.
 */

import { ripemd160 } from '@noble/hashes/legacy.js'
import { hex } from '@scure/base'

/** A 32-byte x-only public key. */
export type XOnlyKey = Uint8Array

/** Derive the 20-byte hash the script commits to, from a BOLT11 payment hash. */
export const scriptHashFromPaymentHash = (paymentHashHex: string): Uint8Array => {
  const paymentHash = hex.decode(paymentHashHex)
  if (paymentHash.length !== 32) {
    throw new Error(`payment hash must be 32 bytes, got ${paymentHash.length}`)
  }
  return ripemd160(paymentHash)
}
