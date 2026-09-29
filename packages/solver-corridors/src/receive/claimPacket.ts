import { appendArkadeScript, claimPacketShape as canonicalClaimPacketShape } from '@arkade-os/swap'
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

/** Derived rather than stored: `claim_packet` never changes. */
export const claimPacketStamp = (
  claimPacket: string | null,
  script: CovenantSwapScript,
): ClaimPacketStamp | undefined => {
  if (claimPacket === null) return undefined
  const shape = canonicalClaimPacketShape(claimPacket)
  if (shape.kind !== 'packet') return undefined
  // Without `0x03` no covclaimd's filter selects the tx, so stamping would
  // strand it AND turn off the reveal that could still have settled it.
  if (!shape.covclaimdPubkey) return undefined
  const arkadeScript = script.nonInteractiveClaimArkadeScript
  if (!shape.needsArkadeScript) return { packet: shape.body, tapTree: script.encode() }
  // No leaf to derive from: fall back to the reveal, whose guard reports it.
  if (!arkadeScript) return undefined
  return { packet: appendArkadeScript(shape.body, arkadeScript), tapTree: script.encode() }
}
