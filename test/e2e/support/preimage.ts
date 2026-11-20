import { randomBytes } from 'node:crypto'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'

export const newPreimage = (): { preimage: Uint8Array; paymentHash: string } => {
  const preimage = randomBytes(32)
  return { preimage, paymentHash: hex.encode(sha256(preimage)) }
}
