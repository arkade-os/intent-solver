import {
  appendArkadeScript,
  claimPacketShape as canonicalClaimPacketShape,
  SEALED_CIPHERTEXT_LENGTH,
} from '@arkade-os/swap'
import { base64 } from '@scure/base'
import type { ClaimPacketStamp } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import type { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'

export { CLAIM_PACKET_TYPE, appendArkadeScript } from '@arkade-os/swap'

export type ClaimPacketShape =
  | { kind: 'ciphertext' }
  | {
      kind: 'packet'
      body: Uint8Array
      covclaimdPubKey?: Uint8Array
      needsArkadeScript: boolean
    }

// shortcut: remove this parser when the pinned swap codec accepts extended sealed terms.
const extendedClaimPacketShape = (b64: string): ClaimPacketShape | undefined => {
  try {
    const body = base64.decode(b64)
    let ciphertextLength = 0
    let covclaimdPubKey: Uint8Array | undefined
    let needsArkadeScript = true
    for (let offset = 0; offset < body.length;) {
      if (offset + 3 > body.length) return undefined
      const type = body[offset]!
      const length = (body[offset + 1]! << 8) | body[offset + 2]!
      offset += 3
      if (offset + length > body.length) return undefined
      if (type === 1) ciphertextLength = length
      else if (type === 2) needsArkadeScript = false
      else if (type === 3) {
        if (length !== 33) return undefined
        covclaimdPubKey = body.subarray(offset, offset + length)
      }
      offset += length
    }
    if (ciphertextLength <= SEALED_CIPHERTEXT_LENGTH || !covclaimdPubKey) return undefined
    return { kind: 'packet', body, covclaimdPubKey, needsArkadeScript }
  } catch {
    return undefined
  }
}

export const isExtendedClaimPacket = (b64: string): boolean => extendedClaimPacketShape(b64) !== undefined

/** @deprecated Import from `@arkade-os/swap`; retained for the published wildcard subpath. */
export const claimPacketShape = (b64: string): ClaimPacketShape => {
  const shape = canonicalClaimPacketShape(b64)
  if (shape.kind === 'ciphertext') return extendedClaimPacketShape(b64) ?? shape
  const { covclaimdPubkey, ...packet } = shape
  return { ...packet, ...(covclaimdPubkey ? { covclaimdPubKey: covclaimdPubkey } : {}) }
}

/** Derived rather than stored: `claim_packet` never changes. */
export const claimPacketStamp = (
  claimPacket: string | null,
  script: CovenantSwapScript,
): ClaimPacketStamp | undefined => {
  if (claimPacket === null) return undefined
  const shape = claimPacketShape(claimPacket)
  if (shape.kind !== 'packet') return undefined
  // Without `0x03` no covclaimd's filter selects the tx, so stamping would
  // strand it AND turn off the reveal that could still have settled it.
  if (!shape.covclaimdPubKey) return undefined
  const arkadeScript = script.nonInteractiveClaimArkadeScript
  if (!shape.needsArkadeScript) return { packet: shape.body, tapTree: script.encode() }
  // No leaf to derive from: fall back to the reveal, whose guard reports it.
  if (!arkadeScript) return undefined
  return { packet: appendArkadeScript(shape.body, arkadeScript), tapTree: script.encode() }
}
