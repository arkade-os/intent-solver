import { claimPacketShape as canonicalClaimPacketShape } from '@arkade-os/swap'

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
