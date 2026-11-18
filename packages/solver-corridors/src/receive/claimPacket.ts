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

/** @deprecated Import from `@arkade-os/swap`; retained for the published wildcard subpath. */
export const claimPacketShape = (b64: string): ClaimPacketShape => {
  const shape = canonicalClaimPacketShape(b64)
  if (shape.kind === 'ciphertext') return shape
  const { covclaimdPubkey, ...packet } = shape
  return { ...packet, ...(covclaimdPubkey ? { covclaimdPubKey: covclaimdPubkey } : {}) }
}

// The pinned swap codec only recognizes ciphertext wrapping a bare preimage.
const extendedPacket = (packet: string): { body: Uint8Array; needsArkadeScript: boolean } | undefined => {
  let body: Uint8Array
  try {
    body = base64.decode(packet)
  } catch {
    return undefined
  }
  let ciphertextLength = 0
  let hasRecipient = false
  let needsArkadeScript = true
  for (let offset = 0; offset < body.length;) {
    if (body.length - offset < 3) return undefined
    const type = body[offset]!
    const length = (body[offset + 1]! << 8) | body[offset + 2]!
    offset += 3 + length
    if (offset > body.length) return undefined
    if (type === 1) ciphertextLength = length
    if (type === 2) needsArkadeScript = false
    if (type === 3) {
      if (length !== 33) return undefined
      hasRecipient = true
    }
  }
  if (ciphertextLength <= SEALED_CIPHERTEXT_LENGTH || !hasRecipient) return undefined
  return { body, needsArkadeScript }
}

/** Derived rather than stored: `claim_packet` never changes. */
export const claimPacketStamp = (
  claimPacket: string | null,
  script: CovenantSwapScript,
): ClaimPacketStamp | undefined => {
  if (claimPacket === null) return undefined
  const shape = canonicalClaimPacketShape(claimPacket)
  const packet = shape.kind === 'packet' && shape.covclaimdPubkey ? shape : extendedPacket(claimPacket)
  if (!packet) return undefined
  if (!packet.needsArkadeScript) return { packet: packet.body, tapTree: script.encode() }
  const arkadeScript = script.nonInteractiveClaimArkadeScript
  if (!arkadeScript) return undefined
  return { packet: appendArkadeScript(packet.body, arkadeScript), tapTree: script.encode() }
}
