/**
 * RLP, the encoding every Ethereum transaction is built out of.
 *
 * Needed because an EIP-1559 transaction is `0x02 || rlp([...])`, and its hash
 * — the thing a node indexes it by and the thing the signature commits to — is
 * `keccak256` of exactly those bytes. Nothing else in this service needs RLP,
 * and the subset a transaction uses is small: byte strings and lists, no
 * integers-as-such (a quantity is a minimal-length big-endian byte string).
 *
 * WHY THIS IS HAND-ROLLED AND SIGNING MIGHT NOT BE. RLP is ~40 lines of
 * mechanical layout with an external check available: re-encode a real
 * transaction's fields and the hash must come out equal to the one the chain
 * indexed it by. That is a strong, cheap test. It is not an argument for
 * hand-rolling the parts with no such check.
 *
 * The rules, in full:
 *
 * - a single byte < 0x80 is itself;
 * - a string of length n <= 55 is `0x80 + n` then the bytes;
 * - a longer string is `0xb7 + len(n)`, then n big-endian, then the bytes;
 * - a list whose payload is n <= 55 bytes is `0xc0 + n` then the payload;
 * - a longer list is `0xf7 + len(n)`, then n, then the payload.
 */

import { concatBytes } from '@noble/hashes/utils.js'

/** What RLP can encode: a byte string, or a list of them. */
export type RlpInput = Uint8Array | readonly RlpInput[]

const concat = (parts: readonly Uint8Array[]): Uint8Array => concatBytes(...parts)

/** A length as the shortest big-endian byte string that represents it. */
const lengthBytes = (n: number): Uint8Array => {
  const out: number[] = []
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256)
  return Uint8Array.from(out)
}

const withPrefix = (payload: Uint8Array, short: number, long: number): Uint8Array => {
  if (payload.length <= 55) return concat([Uint8Array.from([short + payload.length]), payload])
  const len = lengthBytes(payload.length)
  return concat([Uint8Array.from([long + len.length]), len, payload])
}

export const rlpEncode = (input: RlpInput): Uint8Array => {
  if (input instanceof Uint8Array) {
    // The single-byte case is not an optimisation — an encoder that always
    // emits the 0x80+n prefix produces different bytes, and therefore a
    // different transaction hash, for the same transaction.
    if (input.length === 1 && input[0]! < 0x80) return Uint8Array.from(input)
    return withPrefix(input, 0x80, 0xb7)
  }
  return withPrefix(concat(input.map(rlpEncode)), 0xc0, 0xf7)
}

/**
 * A quantity as RLP expects it: minimal-length big-endian, and **empty for
 * zero**.
 *
 * The empty-for-zero rule is the one that bites. RLP has no number type, so a
 * zero-valued field is the empty string `0x80`, not `0x00`. Encoding `0x00`
 * yields a structurally valid transaction with a different hash — and for a
 * `value: 0` transfer, which is every ERC-20 call, that is the common case
 * rather than an edge one.
 */
export const rlpQuantity = (value: bigint): Uint8Array => {
  if (value < 0n) throw new Error(`quantity must not be negative, got ${value}`)
  if (value === 0n) return new Uint8Array(0)
  const out: number[] = []
  for (let v = value; v > 0n; v >>= 8n) out.unshift(Number(v & 0xffn))
  return Uint8Array.from(out)
}
