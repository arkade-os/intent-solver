/**
 * Preimage-hash bridging for the swap script.
 *
 * The two sides do not agree on the hash: a BOLT11 payment hash is `sha256(P)`,
 * while the swap script's HASH160 branch commits to `ripemd160(sha256(P))`.
 * Applying ripemd160 to the invoice's payment hash bridges them — which is why
 * the send leg never needs to see P before the payment itself yields it.
 */

import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'

/** A 32-byte x-only public key. */
export type XOnlyKey = Uint8Array

/** `sha256(P)`, hex — the wire form `row.paymentHash` is stored in. */
export const paymentHashFromPreimage = (preimage: Uint8Array): string => hex.encode(sha256(preimage))

/** Whether a hex preimage opens a BOLT11 payment hash; malformed hex is a mismatch, not a throw. */
export const preimageMatchesHash = (preimageHex: string, paymentHashHex: string): boolean => {
  try {
    return paymentHashFromPreimage(hex.decode(preimageHex)) === paymentHashHex
  } catch {
    return false
  }
}

/** Derive the 20-byte hash the script commits to, from a BOLT11 payment hash. */
export const scriptHashFromPaymentHash = (paymentHashHex: string): Uint8Array => {
  const paymentHash = hex.decode(paymentHashHex)
  if (paymentHash.length !== 32) {
    throw new Error(`payment hash must be 32 bytes, got ${paymentHash.length}`)
  }
  return ripemd160(paymentHash)
}
