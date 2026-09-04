/**
 * Minimal BOLT11 encoder — enough to forge invoices whose preimages WE chose.
 *
 * Exists for one reason: end-to-end runs on regtest have no Lightning network,
 * but the send leg's contract is "pay a BOLT11, learn its preimage". Forging the
 * invoice lets a fake backend honour that contract for real: the forge picks P,
 * the invoice commits to sha256(P), and "paying" it reveals P — so everything
 * downstream (the swap script's HASH160 branch, the claim) is exercised
 * unchanged against a real Arkade server.
 *
 * Deliberately minimal: payment hash, expiry, final CLTV, amount, network. The
 * signature is by a throwaway key — BOLT11 carries no separate payee identity,
 * so any well-formed recoverable signature makes a decodable invoice. The
 * acceptance test is that OUR OWN strict decoder accepts the output.
 */

import { randomBytes } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bech32, hex } from '@scure/base'

/** 5-bit words, big-endian, minimal length (no leading zero words). */
const numberToWords = (value: number): number[] => {
  if (value === 0) return [0]
  const words: number[] = []
  let rest = value
  while (rest > 0) {
    words.unshift(rest & 31)
    rest = Math.floor(rest / 32)
  }
  return words
}

/** One tagged field: type + 10-bit length + payload words. */
const tagged = (type: number, words: number[]): number[] => [
  type,
  Math.floor(words.length / 32),
  words.length % 32,
  ...words,
]

/** Pack 5-bit words into bytes, zero-padded at the end — the BOLT11 signing view. */
const wordsToBytes = (words: number[]): Uint8Array => {
  const bits = words.length * 5
  const out = new Uint8Array(Math.ceil(bits / 8))
  let bitIndex = 0
  for (const word of words) {
    for (let b = 4; b >= 0; b--) {
      if ((word >> b) & 1) out[bitIndex >> 3]! |= 0x80 >> (bitIndex & 7)
      bitIndex += 1
    }
  }
  return out
}

export interface ForgeParams {
  /** bech32 currency prefix: 'bcrt' for regtest, 'tbs' for signet. */
  network: string
  /**
   * Sats the invoice is bound to — OMIT for an amountless one, where the payer
   * chooses.
   *
   * Optional because the deposit invoices this solver mints are amountless, and
   * a forge that could not express that let a decoder which requires an amount
   * pass its tests while failing on every real invoice it would ever see.
   */
  amountSats?: number
  /** sha256(preimage), 32 bytes. */
  paymentHash: Uint8Array
  /** Unix seconds. */
  timestamp: number
  expirySeconds: number
  minFinalCltvBlocks?: number
  /**
   * `r` fields to encode, as the hops of each hint.
   *
   * A bare number is a hop's CLTV delta with everything else left zero, and was
   * the only shape this encoder had: the CLTV is the one part of a hint the
   * PAYER is bound by and the INVOICE WRITER chooses, so the rest of the
   * 51-byte hop was filler. The object form names the channel too, because the
   * scid denylist (`decodeInvoice`'s `denylist`) filters on exactly the part
   * that used to be filler — a zeroed scid is one value, so without this every
   * forged hint is the same channel.
   */
  routeHints?: readonly (readonly ForgeHop[])[]
}

/** One forged hop: its CLTV delta, or that delta plus the channel to name it by. */
export type ForgeHop = number | { cltv: number; scid?: string }

/** BOLT11 `r`: 51 bytes per hop — scid at offset 33, CLTV delta in the last two. */
const routeHintWords = (hops: readonly ForgeHop[]): number[] => {
  const bytes = new Uint8Array(hops.length * 51)
  hops.forEach((hop, index) => {
    const { cltv, scid } = typeof hop === 'number' ? { cltv: hop, scid: undefined } : hop
    // pubkey(33) + fee_base(4) + fee_ppm(4) are left zero; short_channel_id is
    // the 8 bytes at offset 33 and cltv_expiry_delta the u16 at offset 49.
    if (scid !== undefined) {
      if (!/^[0-9a-fA-F]{16}$/.test(scid)) throw new Error(`scid must be 16 hex chars, got '${scid}'`)
      bytes.set(hex.decode(scid.toLowerCase()), index * 51 + 33)
    }
    const cltvAt = index * 51 + 49
    bytes[cltvAt] = (cltv >> 8) & 0xff
    bytes[cltvAt + 1] = cltv & 0xff
  })
  return Array.from(bech32.toWords(bytes))
}

/** Encode a decodable BOLT11 invoice for the given payment hash. */
export const forgeInvoice = (params: ForgeParams): string => {
  if (params.paymentHash.length !== 32) throw new Error('payment hash must be 32 bytes')
  if (params.amountSats !== undefined && (!Number.isInteger(params.amountSats) || params.amountSats <= 0)) {
    throw new Error('amount must be positive sats')
  }

  // Amount in the HRP with the nano multiplier: n = 1e-9 BTC = 0.1 sat, so
  // N sats = 10·N n. Nano keeps EVERY integer-sat amount representable without
  // choosing a multiplier per magnitude.
  //
  // An OMITTED amount leaves the HRP with nothing after the network prefix,
  // which is exactly how BOLT11 spells "amountless" — the payer chooses.
  const hrp = params.amountSats === undefined ? `ln${params.network}` : `ln${params.network}${params.amountSats * 10}n`

  const timestampWords = ((): number[] => {
    // Timestamp is ALWAYS 7 words (35 bits), zero-padded on the left.
    const words = numberToWords(params.timestamp)
    while (words.length < 7) words.unshift(0)
    return words
  })()

  const data = [
    ...timestampWords,
    // p: payment hash (52 words)
    ...tagged(1, Array.from(bech32.toWords(params.paymentHash))),
    // x: expiry
    ...tagged(6, numberToWords(params.expirySeconds)),
    // c: min_final_cltv_expiry
    ...tagged(24, numberToWords(params.minFinalCltvBlocks ?? 18)),
    // r: one tagged field per hint, each a path of hops
    ...(params.routeHints ?? []).flatMap((hops) => tagged(3, routeHintWords(hops))),
  ]

  // Recoverable signature over utf8(hrp) || packed data, by a throwaway key.
  const priv = secp256k1.utils.randomSecretKey()
  const message = sha256(Uint8Array.from([...new TextEncoder().encode(hrp), ...wordsToBytes(data)]))
  const signature = secp256k1.sign(message, priv, { format: 'recovered', prehash: false })
  // 'recovered' format is recovery(1) || r||s(64); BOLT11 wants r||s || recovery.
  const sigWords = Array.from(bech32.toWords(Uint8Array.from([...signature.slice(1), signature[0]!])))

  return bech32.encode(hrp, [...data, ...sigWords], false)
}

/** Forge an invoice AND the preimage it commits to. */
export const forgeInvoiceWithPreimage = (
  params: Omit<ForgeParams, 'paymentHash'>,
): { invoice: string; preimage: Uint8Array; paymentHash: Uint8Array } => {
  const preimage = randomBytes(32)
  const paymentHash = sha256(preimage)
  return { invoice: forgeInvoice({ ...params, paymentHash }), preimage, paymentHash }
}
