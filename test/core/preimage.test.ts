import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'

const preimage = new Uint8Array(32).fill(7)
const paymentHash = hex.encode(sha256(preimage))

describe('scriptHashFromPaymentHash', () => {
  it('bridges the two hashes the swap sides disagree on', () => {
    // BOLT11 commits to sha256(P); the script's HASH160 branch commits to
    // ripemd160(sha256(P)). Deriving one from the other is what lets the send
    // leg build the script without ever seeing P.
    expect(scriptHashFromPaymentHash(paymentHash)).toEqual(ripemd160(sha256(preimage)))
  })

  it('produces the 20 bytes HASH160 requires', () => {
    expect(scriptHashFromPaymentHash(paymentHash)).toHaveLength(20)
  })

  it('rejects a hash that is not 32 bytes', () => {
    expect(() => scriptHashFromPaymentHash(hex.encode(new Uint8Array(20)))).toThrow(/32 bytes/)
  })
})
