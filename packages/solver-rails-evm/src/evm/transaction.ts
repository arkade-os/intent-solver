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
  /** 20 bytes. Contract creation is not supported — this corridor only calls. */
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
  assertAddress(tx.to, 'to')
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
