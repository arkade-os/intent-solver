/**
 * The two shapes of `claim_packet` (docs/rfq-protocol.md § 7.1.2). They cannot
 * collide: the ciphertext is fixed at 93 bytes, a TLV body needs 96 for it alone.
 */

import { base64 } from '@scure/base'

const LEGACY_CIPHERTEXT_LENGTH = 93

const TLV_CIPHERTEXT = 0x01
const TLV_ARKADE_SCRIPT = 0x02
const TLV_COVCLAIMD_PUBKEY = 0x03

const COMPRESSED_PUBKEY_LENGTH = 33

/** The Arkade extension packet type covclaimd scans the arkd tx stream for. */
export const CLAIM_PACKET_TYPE = 0x04

export type ClaimPacketShape =
  { kind: 'ciphertext' } | { kind: 'packet'; body: Uint8Array; covclaimdPubKey?: Uint8Array }

/** Transcribed from `DeserializeClaim`, including its tolerance of unknown and repeated types. */
const parseTlv = (data: Uint8Array): { hasCiphertext: boolean; hasArkadeScript: boolean; pubKey?: Uint8Array } => {
  let hasCiphertext = false
  let hasArkadeScript = false
  let pubKey: Uint8Array | undefined
  let offset = 0
  while (offset < data.length) {
    if (offset + 3 > data.length) throw new Error('truncated TLV header')
    const type = data[offset]!
    const length = (data[offset + 1]! << 8) | data[offset + 2]!
    offset += 3
    if (offset + length > data.length) throw new Error(`TLV type 0x${type.toString(16)} overruns the buffer`)
    const value = data.subarray(offset, offset + length)
    offset += length
    if (type === TLV_CIPHERTEXT) hasCiphertext = true
    else if (type === TLV_ARKADE_SCRIPT) hasArkadeScript = true
    else if (type === TLV_COVCLAIMD_PUBKEY) {
      if (value.length !== COMPRESSED_PUBKEY_LENGTH) {
        throw new Error(`covclaimd_pub_key TLV is ${value.length} bytes, want ${COMPRESSED_PUBKEY_LENGTH}`)
      }
      pubKey = value
    }
  }
  return { hasCiphertext, hasArkadeScript, pubKey }
}

/** Never throws: anything not unambiguously a packet keeps the old reveal path. */
export const claimPacketShape = (b64: string): ClaimPacketShape => {
  try {
    const raw = base64.decode(b64)
    if (raw.length === LEGACY_CIPHERTEXT_LENGTH) return { kind: 'ciphertext' }
    const { hasCiphertext, hasArkadeScript, pubKey } = parseTlv(raw)
    if (!hasCiphertext || !hasArkadeScript) return { kind: 'ciphertext' }
    return { kind: 'packet', body: raw, ...(pubKey ? { covclaimdPubKey: pubKey } : {}) }
  } catch {
    return { kind: 'ciphertext' }
  }
}
