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
  | { kind: 'ciphertext' }
  | {
      kind: 'packet'
      body: Uint8Array
      covclaimdPubKey?: Uint8Array
      needsArkadeScript: boolean
    }

const encodeTlv = (type: number, value: Uint8Array): Uint8Array =>
  Uint8Array.from([type, (value.length >> 8) & 0xff, value.length & 0xff, ...value])

/**
 * The covenant commits to `taggedHash("ArkScriptHash", script)`, so its funder
 * holds the only copy guaranteed to match. Appended: TLV order is not fixed.
 */
export const appendArkadeScript = (body: Uint8Array, arkadeScript: Uint8Array): Uint8Array =>
  Uint8Array.from([...body, ...encodeTlv(TLV_ARKADE_SCRIPT, arkadeScript)])

/** Transcribed from `DeserializeClaim`, including its tolerance of unknown and repeated types. */
const parseTlv = (data: Uint8Array): { ciphertextLength?: number; hasArkadeScript: boolean; pubKey?: Uint8Array } => {
  let ciphertextLength: number | undefined
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
    if (type === TLV_CIPHERTEXT) ciphertextLength = value.length
    else if (type === TLV_ARKADE_SCRIPT) hasArkadeScript = true
    else if (type === TLV_COVCLAIMD_PUBKEY) {
      if (value.length !== COMPRESSED_PUBKEY_LENGTH) {
        throw new Error(`covclaimd_pub_key TLV is ${value.length} bytes, want ${COMPRESSED_PUBKEY_LENGTH}`)
      }
      pubKey = value
    }
  }
  return { ciphertextLength, hasArkadeScript, pubKey }
}

/** Never throws: anything not unambiguously a packet keeps the old reveal path. */
export const claimPacketShape = (b64: string): ClaimPacketShape => {
  try {
    const raw = base64.decode(b64)
    if (raw.length === LEGACY_CIPHERTEXT_LENGTH) return { kind: 'ciphertext' }
    const { ciphertextLength, hasArkadeScript, pubKey } = parseTlv(raw)
    // Length is fixed by the sealing scheme; a wrong one fails to decrypt either way, so take the loud path.
    if (ciphertextLength !== LEGACY_CIPHERTEXT_LENGTH) return { kind: 'ciphertext' }
    return {
      kind: 'packet',
      body: raw,
      needsArkadeScript: !hasArkadeScript,
      ...(pubKey ? { covclaimdPubKey: pubKey } : {}),
    }
  } catch {
    return { kind: 'ciphertext' }
  }
}
