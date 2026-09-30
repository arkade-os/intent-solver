/**
 * Building, signing and identifying an EIP-1559 transaction.
 *
 * This is the seam `backend.ts` deliberately leaves open: it produces an
 * {@link EvmCall} — where to go, what calldata, what value — and something has
 * to turn that into bytes a node will accept. This is that something.
 *
 * TYPE 2 ONLY. Every chain this corridor can plausibly run on supports
 * EIP-1559, and supporting legacy or EIP-2930 as well would mean three signing
 * paths where the differences are exactly the fields the signature commits to.
 * One shape, or the replay protection becomes conditional.
 *
 * WHAT IS VERIFIED AND HOW. A transaction's id is `keccak256` of its signed
 * payload, and its sender is *recovered* from the signature over the unsigned
 * one. Both are checkable against a transaction that already exists on chain,
 * with no key and no funds:
 *
 * - encode a real transaction's fields, hash them, and the id must match;
 * - reconstruct its unsigned payload, recover from its `(yParity, r, s)`, and
 *   the address must equal its `from`.
 *
 * The second is the one that matters here, because it pins the exact bytes the
 * signature covers — the field order, the `0x02` prefix, and the nine-element
 * list. Get any of those wrong and a signature is valid over the wrong message:
 * the node rejects it, or worse, it authorises a transaction other than the one
 * intended. The tests do both against a live Arbitrum transaction.
 *
 * ACCESS LISTS ARE ALWAYS EMPTY. The list is part of the signed payload, so it
 * cannot simply be omitted — it is encoded as an empty list. Nothing this
 * corridor does needs one.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { rlpEncode, rlpQuantity, type RlpInput } from './rlp.js'

/** The EIP-1559 transaction type byte. */
const TYPE_2 = 0x02

/** Everything the signature commits to. */
export interface Eip1559Fields {
  chainId: bigint
  nonce: bigint
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  gas: bigint
  /** 20 bytes for a call, or empty for contract creation. */
  to: Uint8Array
  /** Native currency, in wei. */
  value: bigint
  data: Uint8Array
}

const assertAddress = (address: Uint8Array, label: string): void => {
  if (address.length !== 20) throw new Error(`${label} must be 20 bytes, got ${address.length}`)
}

/** The nine signed fields, in the order EIP-1559 fixes. */
const unsignedFields = (tx: Eip1559Fields): RlpInput[] => {
  validateFields(tx)
  return [
    rlpQuantity(tx.chainId),
    rlpQuantity(tx.nonce),
    rlpQuantity(tx.maxPriorityFeePerGas),
    rlpQuantity(tx.maxFeePerGas),
    rlpQuantity(tx.gas),
    Uint8Array.from(tx.to),
    rlpQuantity(tx.value),
    Uint8Array.from(tx.data),
    [], // access list
  ]
}

/** `0x02 || rlp([...nine fields])` — the exact bytes a signature covers. */
export const unsignedPayload = (tx: Eip1559Fields): Uint8Array =>
  Uint8Array.from([TYPE_2, ...rlpEncode(unsignedFields(tx))])

/** What is actually signed. */
export const signingHash = (tx: Eip1559Fields): Uint8Array => keccak_256(unsignedPayload(tx))

/** An address from an uncompressed public key: the last 20 bytes of its keccak. */
export const addressFromPublicKey = (uncompressed: Uint8Array): Uint8Array => {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error(`expected a 65-byte uncompressed public key, got ${uncompressed.length}`)
  }
  // The 0x04 prefix is NOT hashed — only the 64 bytes of coordinates.
  return keccak_256(uncompressed.subarray(1)).subarray(-20)
}

/** The address a private key controls. */
export const addressFromPrivateKey = (privateKey: Uint8Array): Uint8Array =>
  addressFromPublicKey(secp256k1.getPublicKey(privateKey, false))

export interface SignedTransaction {
  /** `0x02 || rlp([...nine fields, yParity, r, s])`, ready for `eth_sendRawTransaction`. */
  raw: Uint8Array
  /** `keccak256(raw)` — the id a node will index it by. */
  hash: Uint8Array
  /** Recovered from the signature, not assumed: what the chain will believe. */
  from: Uint8Array
}

/**
 * The signature's `(yParity, r, s)` over this transaction's signing hash.
 *
 * `format: 'recovered'` is a published member of noble/curves' own
 * `ECDSASignatureFormat` union (`'compact' | 'recovered' | 'der'`, v2.2.0), not
 * an undocumented option — so a future major that drops it fails the build
 * rather than silently handing back a shape this code misreads.
 *
 * It yields 65 bytes as `recovery || r || s`. The recovery
 * byte IS `yParity` for a type-2 transaction — there is no chain-id folding
 * here, because the chain id is already a signed field. Adding 27, or the
 * EIP-155 `v` arithmetic, would produce a transaction that recovers to the
 * wrong sender.
 */
const signatureParts = (hash: Uint8Array, privateKey: Uint8Array) => {
  const sig = secp256k1.sign(hash, privateKey, { prehash: false, format: 'recovered' })
  return { yParity: BigInt(sig[0]!), r: sig.subarray(1, 33), s: sig.subarray(33, 65) }
}

/** Sign, and report the sender the chain will recover rather than the one we assumed. */
export const signTransaction = (tx: Eip1559Fields, privateKey: Uint8Array): SignedTransaction => {
  const { yParity, r, s } = signatureParts(signingHash(tx), privateKey)
  const raw = Uint8Array.from([
    TYPE_2,
    ...rlpEncode([
      ...unsignedFields(tx),
      rlpQuantity(yParity),
      // As quantities, so leading zero bytes are stripped. `r` and `s` are
      // 32-byte scalars but RLP has no fixed-width form, and a leading zero
      // left in place changes the payload and therefore the id.
      rlpQuantity(bytesToBigint(r)),
      rlpQuantity(bytesToBigint(s)),
    ]),
  ])
  // RECOVERED, not derived from the key. `from` claims to be the account the
  // chain will attribute this to, so it is only worth anything if it comes from
  // where the chain gets it — the signature. Deriving it from the private key
  // reports the account we MEANT, and so cannot fail in the one case worth
  // catching: a signature valid over the wrong message, which recovers to a
  // different account entirely. That is a wrong `signingHash`, a wrong field
  // order, a wrong `format` — every signing bug this module could have.
  const from = recoverSender(tx, { yParity, r, s })
  if (bytesToHex(from) !== bytesToHex(addressFromPrivateKey(privateKey))) {
    // Unreachable unless signing is broken, and refusing is the point: a
    // transaction that recovers elsewhere would be authorised by us and
    // attributed to someone else. Better to never leave this function.
    throw new Error('signed transaction recovers to a different sender than the key that signed it')
  }
  return { raw, hash: keccak_256(raw), from }
}

/**
 * The address that signed a transaction, from its signature.
 *
 * Used by the tests to check the construction against real chain data, and
 * worth exporting: it is the only way to confirm a signed transaction will be
 * attributed to the account we think it will, before spending gas finding out.
 */
export const recoverSender = (
  tx: Eip1559Fields,
  signature: { yParity: bigint; r: Uint8Array; s: Uint8Array },
): Uint8Array => {
  if (signature.yParity !== 0n && signature.yParity !== 1n) throw new Error('yParity must be zero or one')
  const parsed = new secp256k1.Signature(bytesToBigint(signature.r), bytesToBigint(signature.s))
  if (parsed.hasHighS()) throw new Error('transaction signature must use low s')
  const recovered = new Uint8Array(65)
  recovered[0] = Number(signature.yParity)
  recovered.set(padLeft(signature.r, 32), 1)
  recovered.set(padLeft(signature.s, 32), 33)
  // SIGNATURE FIRST, then the message. That is the declared order in
  // noble/curves v2 — `recoverPublicKey(signature, message, opts?)`, see
  // `abstract/weierstrass.d.ts` — and not a transposition of v1's instance
  // method `Signature.recoverPublicKey(msgHash)`, which the same file still
  // carries for the legacy type. Stated because both arguments are
  // `Uint8Array`: swapping them TYPECHECKS, so nothing but a test against real
  // chain data would catch it.
  const point = secp256k1.recoverPublicKey(recovered, signingHash(tx), { prehash: false })
  // `recoverPublicKey` returns a COMPRESSED key; the address is derived from
  // the uncompressed form, so it has to be expanded rather than hashed as-is.
  return addressFromPublicKey(secp256k1.Point.fromBytes(point).toBytes(false))
}

const padLeft = (bytes: Uint8Array, size: number): Uint8Array => {
  if (bytes.length === size) return bytes
  if (bytes.length > size) throw new Error(`value is ${bytes.length} bytes, expected at most ${size}`)
  const out = new Uint8Array(size)
  out.set(bytes, size - bytes.length)
  return out
}

const bytesToBigint = (bytes: Uint8Array): bigint => {
  let v = 0n
  for (const byte of bytes) v = (v << 8n) | BigInt(byte)
  return v
}

const UINT256_LIMIT = 1n << 256n
const NONCE_LIMIT = (1n << 64n) - 1n

const validateFields = (tx: Eip1559Fields): void => {
  if (!(tx.to instanceof Uint8Array) || (tx.to.length !== 0 && tx.to.length !== 20)) {
    throw new Error('to must be 20 bytes or empty for contract creation')
  }
  if (!(tx.data instanceof Uint8Array)) throw new Error('data must be bytes')
  for (const field of ['chainId', 'nonce', 'maxPriorityFeePerGas', 'maxFeePerGas', 'gas', 'value'] as const) {
    if (typeof tx[field] === 'bigint' && tx[field] < 0n) throw new Error(`${field} must not be negative (uint256)`)
    if (typeof tx[field] !== 'bigint' || tx[field] >= UINT256_LIMIT) {
      throw new Error(`${field} must be a uint256`)
    }
  }
  if (tx.chainId === 0n || tx.gas === 0n) throw new Error('chainId and gas must be positive')
  if (tx.gas >= 1n << 64n) throw new Error('gas exceeds uint64')
  if (tx.nonce >= NONCE_LIMIT) throw new Error('nonce exceeds the transaction nonce limit')
  if (tx.maxPriorityFeePerGas > tx.maxFeePerGas) throw new Error('priority fee exceeds maximum fee')
}

interface RlpHeader {
  list: boolean
  start: number
  end: number
}

const rlpHeader = (raw: Uint8Array, offset: number, limit: number): RlpHeader => {
  if (offset >= limit) throw new Error('truncated RLP item')
  const prefix = raw[offset]!
  if (prefix < 0x80) return { list: false, start: offset, end: offset + 1 }
  const list = prefix >= 0xc0
  const shortLimit = list ? 0xf7 : 0xb7
  const shortBase = list ? 0xc0 : 0x80
  let start = offset + 1
  let length: number
  if (prefix <= shortLimit) {
    length = prefix - shortBase
  } else {
    const lengthBytes = prefix - shortLimit
    if (start + lengthBytes > limit || raw[start] === 0) throw new Error('invalid RLP length')
    length = 0
    for (let index = 0; index < lengthBytes; index++) {
      length = length * 256 + raw[start + index]!
      if (!Number.isSafeInteger(length)) throw new Error('RLP length exceeds safe bounds')
    }
    start += lengthBytes
    if (length < 56) throw new Error('noncanonical long RLP item')
  }
  const end = start + length
  if (!Number.isSafeInteger(end) || end > limit) throw new Error('truncated RLP payload')
  if (!list && length === 1 && raw[start]! < 0x80) throw new Error('noncanonical single-byte RLP item')
  return { list, start, end }
}

const quantityFromRlp = (value: RlpInput, name: string): bigint => {
  if (!(value instanceof Uint8Array) || value.length > 32 || (value.length > 0 && value[0] === 0)) {
    throw new Error(`${name} must be a canonical uint256 quantity`)
  }
  return bytesToBigint(value)
}

const bytesFromRlp = (value: RlpInput, name: string): Uint8Array => {
  if (!(value instanceof Uint8Array)) throw new Error(`${name} must be an RLP byte string`)
  return value
}

export interface DecodedSignedTransaction extends SignedTransaction {
  fields: Eip1559Fields
  yParity: bigint
  r: Uint8Array
  s: Uint8Array
}

export const decodeSignedTransaction = (input: Uint8Array): DecodedSignedTransaction => {
  if (!(input instanceof Uint8Array) || input[0] !== TYPE_2) throw new Error('expected an EIP-1559 transaction')
  const raw = Uint8Array.from(input)
  const root = rlpHeader(raw, 1, raw.length)
  if (!root.list || root.end !== raw.length) throw new Error('transaction must be one complete RLP list')
  const items: RlpInput[] = []
  for (let offset = root.start; offset < root.end;) {
    const item = rlpHeader(raw, offset, root.end)
    if (item.list) {
      if (items.length !== 8 || item.start !== item.end) throw new Error('only an empty access list is supported')
      items.push([])
    } else items.push(raw.slice(item.start, item.end))
    offset = item.end
    if (items.length > 12) throw new Error('transaction must contain twelve fields')
  }
  if (items.length !== 12 || items[8] instanceof Uint8Array) throw new Error('transaction must contain twelve fields')
  const fields: Eip1559Fields = {
    chainId: quantityFromRlp(items[0]!, 'chainId'),
    nonce: quantityFromRlp(items[1]!, 'nonce'),
    maxPriorityFeePerGas: quantityFromRlp(items[2]!, 'maxPriorityFeePerGas'),
    maxFeePerGas: quantityFromRlp(items[3]!, 'maxFeePerGas'),
    gas: quantityFromRlp(items[4]!, 'gas'),
    to: bytesFromRlp(items[5]!, 'to'),
    value: quantityFromRlp(items[6]!, 'value'),
    data: bytesFromRlp(items[7]!, 'data'),
  }
  validateFields(fields)
  const yParity = quantityFromRlp(items[9]!, 'yParity')
  const r = bytesFromRlp(items[10]!, 'r')
  const s = bytesFromRlp(items[11]!, 's')
  quantityFromRlp(r, 'r')
  quantityFromRlp(s, 's')
  const from = recoverSender(fields, { yParity, r, s })
  return { raw, hash: keccak_256(raw), from, fields, yParity, r, s }
}

export const createAddress = (sender: Uint8Array, nonce: bigint): Uint8Array => {
  assertAddress(sender, 'sender')
  if (typeof nonce !== 'bigint' || nonce < 0n || nonce >= NONCE_LIMIT) throw new Error('invalid CREATE nonce')
  return keccak_256(rlpEncode([sender, rlpQuantity(nonce)])).slice(-20)
}
