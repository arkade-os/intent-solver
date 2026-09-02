import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import {
  addressFromPrivateKey,
  addressFromPublicKey,
  recoverSender,
  signTransaction,
  signingHash,
  unsignedPayload,
  type Eip1559Fields,
} from '@arkade-os/solver-rails-evm/evm/transaction.js'

/**
 * A real Arbitrum EIP-1559 transaction, and everything the chain says about it.
 *
 * Re-derivable with `eth_getTransactionByHash`. Chosen for empty calldata and a
 * zero `maxPriorityFeePerGas`, so the RLP rule most likely to be wrong is on the
 * path.
 */
const REAL = {
  fields: {
    chainId: 0xa4b1n,
    nonce: 0x47af5n,
    maxPriorityFeePerGas: 0n,
    maxFeePerGas: 0x26288e0n,
    gas: 0x63d2n,
    to: hex.decode('bb009247cea2cf3aaa7a6e24382744515c8242b0'),
    value: 0xbbf2ad2c40n,
    data: new Uint8Array(0),
  } satisfies Eip1559Fields,
  from: 'af694dd50895fc3f816122518a425de63660fe76',
  yParity: 0n,
  r: hex.decode('2ea948c52d4fa4cdd450e2a95b23eb71653f84524022803f45b4d4e6316f835b'),
  s: hex.decode('2e21bda8ab375be7e3e7cb49cdc5e4c600a59b13c8c70b4988e595a0fd1ac015'),
}

/**
 * THE test for this module.
 *
 * A signature is only meaningful relative to the exact bytes it covers. This
 * takes a signature the chain has already accepted, reconstructs what we
 * believe was signed, and checks the address that falls out is the one the
 * chain attributes it to.
 *
 * If the field order, the `0x02` prefix, the nine-element list, the
 * empty-for-zero rule or the yParity convention were wrong, recovery would
 * yield some other address — silently, since every one of those produces a
 * well-formed signature over a *different* message.
 */
describe('signing construction — verified against a real transaction', () => {
  it('recovers the sender the chain attributes the transaction to', () => {
    const recovered = recoverSender(REAL.fields, { yParity: REAL.yParity, r: REAL.r, s: REAL.s })
    expect(hex.encode(recovered)).toBe(REAL.from)
  })

  it('would recover someone else if a signed field were altered', () => {
    // Proves the assertion above has teeth: the signature covers these fields,
    // so changing one must break attribution rather than be ignored.
    const tampered = { ...REAL.fields, value: REAL.fields.value + 1n }
    const recovered = recoverSender(tampered, { yParity: REAL.yParity, r: REAL.r, s: REAL.s })
    expect(hex.encode(recovered)).not.toBe(REAL.from)
  })

  it('would recover someone else under the EIP-155 v convention', () => {
    // A type-2 transaction's recovery byte IS yParity — the chain id is already
    // a signed field, so there is no folding. Adding 27, the legacy habit,
    // gives an invalid recovery id or the wrong key.
    expect(() => recoverSender(REAL.fields, { yParity: REAL.yParity + 27n, r: REAL.r, s: REAL.s })).toThrow()
  })

  it('builds an unsigned payload that starts with the type byte', () => {
    const payload = unsignedPayload(REAL.fields)
    expect(payload[0]).toBe(0x02)
    expect(hex.encode(signingHash(REAL.fields))).toBe(hex.encode(keccak_256(payload)))
  })
})

describe('signTransaction', () => {
  const key = secp256k1.utils.randomSecretKey()
  const tx: Eip1559Fields = { ...REAL.fields, nonce: 7n, data: hex.decode('deadbeef') }

  it('reports the sender the signature actually recovers to', () => {
    // `from` is recovered from the key, not assumed from config — the point
    // being that a caller learns what the chain will believe before spending
    // gas to find out.
    const signed = signTransaction(tx, key)
    expect(hex.encode(signed.from)).toBe(hex.encode(addressFromPrivateKey(key)))
  })

  it('is deterministic, and its id is the hash of its own raw bytes', () => {
    // RFC6979 signing takes no entropy, so the same transaction and key must
    // produce byte-identical output — which is what makes a retry after a
    // timeout safe rather than a second, differently-identified transaction.
    const a = signTransaction(tx, key)
    const b = signTransaction(tx, key)
    expect(hex.encode(a.raw)).toBe(hex.encode(b.raw))
    expect(a.raw[0]).toBe(0x02)
    expect(hex.encode(a.hash)).toBe(hex.encode(keccak_256(a.raw)))
  })

  /**
   * Walk an EIP-1559 payload and hand back its twelve RLP items.
   *
   * WHY NOT A FIXED OFFSET. The first cut of the test below located the parity
   * byte at `raw.length - 67`, reasoning that r and s are 32-byte strings so
   * the tail is a known width. RLP STRIPS LEADING ZEROS, so roughly one
   * signature in 128 encodes an r or s of 31 bytes or fewer and the offset
   * lands on the wrong byte — `expected [128, 1] to include 192`, 192 being an
   * RLP list prefix. With `key` drawn from `randomSecretKey()` that made the
   * test fail a few runs in a hundred, which is exactly the shape of flake that
   * gets re-run and forgotten. Reading the structure costs a dozen lines and
   * cannot drift.
   */
  const rlpItems = (raw: Uint8Array): Uint8Array[] => {
    expect(raw[0]).toBe(0x02) // the EIP-1559 type byte
    let i = 1
    const header = raw[i]!
    // A list header is 0xc0 + len for short lists, 0xf7 + lenOfLen for long.
    i += header <= 0xf7 ? 1 : 1 + (header - 0xf7)
    const items: Uint8Array[] = []
    while (i < raw.length) {
      const prefix = raw[i]!
      if (prefix < 0x80) {
        items.push(raw.subarray(i, i + 1)) // a single byte is its own encoding
        i += 1
      } else if (prefix <= 0xb7) {
        const len = prefix - 0x80
        items.push(raw.subarray(i + 1, i + 1 + len))
        i += 1 + len
      } else if (prefix <= 0xbf) {
        const lenOfLen = prefix - 0xb7
        let len = 0
        for (let k = 0; k < lenOfLen; k++) len = len * 256 + raw[i + 1 + k]!
        items.push(raw.subarray(i + 1 + lenOfLen, i + 1 + lenOfLen + len))
        i += 1 + lenOfLen + len
      } else {
        // A LIST, not a string — `accessList` is one, and empty it encodes as
        // the single byte 0xc0. Treating it as a long string (the first cut of
        // this walker did) reads a nine-byte length out of the payload and
        // walks off the end, which is how this arrived at the wrong item.
        const short = prefix <= 0xf7
        const lenOfLen = short ? 0 : prefix - 0xf7
        let len = short ? prefix - 0xc0 : 0
        for (let k = 0; k < lenOfLen; k++) len = len * 256 + raw[i + 1 + k]!
        items.push(raw.subarray(i, i + 1 + lenOfLen + len)) // kept whole, prefix and all
        i += 1 + lenOfLen + len
      }
    }
    return items
  }

  it('encodes yParity as 0 or 1, never the legacy v', () => {
    // FOUND BY MUTATION. Every other test here goes through `recoverSender`,
    // which never reads the raw payload — so adding 27 to yParity inside the
    // signer passed all of them while producing a transaction a node would
    // reject or attribute to nobody.
    //
    // yParity is item 9 of twelve: chainId, nonce, maxPriorityFeePerGas,
    // maxFeePerGas, gas, to, value, data, accessList, yParity, r, s. Zero
    // encodes as the empty string, one as the single byte 0x01. A legacy v of
    // 27 would be 0x1b, and 28 would be 0x1c.
    for (const nonce of [0n, 1n, 7n, 1000n]) {
      const signed = signTransaction({ ...tx, nonce }, key)
      const items = rlpItems(signed.raw)
      expect(items).toHaveLength(12)
      const parity = items[9]!
      expect(parity.length).toBeLessThanOrEqual(1)
      const parityValue = parity.length === 0 ? 0 : parity[0]!
      expect(parityValue).toBeLessThanOrEqual(1)
      // THE ENCODED parity must be the one recovery needs, not merely a legal
      // value. `signed.from` is recovered from the in-memory signature, so a
      // signer that wrote a constant into the payload would still report the
      // right sender while publishing a transaction the chain attributes
      // elsewhere. Recovering from what was ENCODED is what closes that.
      const recovered = recoverSender(
        { ...tx, nonce },
        {
          yParity: BigInt(parityValue),
          r: items[10]!,
          s: items[11]!,
        },
      )
      expect(hex.encode(recovered)).toBe(hex.encode(signed.from))
    }
  })

  it('reads the parity correctly even when r or s loses a leading zero', () => {
    // The case the fixed offset got wrong. Many random keys, so a short r or s
    // is hit with near-certainty across the run rather than once in 128.
    for (let i = 0; i < 400; i++) {
      const k = secp256k1.utils.randomSecretKey()
      const items = rlpItems(signTransaction(tx, k).raw)
      expect(items).toHaveLength(12)
      const [r, s] = [items[10]!, items[11]!]
      expect(r.length).toBeLessThanOrEqual(32)
      expect(s.length).toBeLessThanOrEqual(32)
      // CANONICAL, i.e. no leading zero byte. RLP quantities strip them, and a
      // padded 32-byte scalar would change the payload and so the transaction
      // id — the very thing `rlpQuantity` is there to prevent. Without this the
      // walker happily accepts a padded r, since 32 is still <= 32.
      if (r.length > 0) expect(r[0]).not.toBe(0)
      if (s.length > 0) expect(s[0]).not.toBe(0)
      const parity = items[9]!
      expect(parity.length === 0 ? 0 : parity[0]).toBeLessThanOrEqual(1)
    }
  })

  it('produces a different id for a different nonce', () => {
    const a = signTransaction(tx, key)
    const b = signTransaction({ ...tx, nonce: tx.nonce + 1n }, key)
    expect(hex.encode(a.hash)).not.toBe(hex.encode(b.hash))
  })

  it('refuses a `to` that is not 20 bytes', () => {
    expect(() => signTransaction({ ...tx, to: new Uint8Array(19) }, key)).toThrow(/to must be 20 bytes/)
  })
})

describe('addressFromPublicKey', () => {
  it('hashes the coordinates without the 0x04 prefix', () => {
    // Including the prefix yields a plausible-looking address that no key
    // controls — funds sent there are unrecoverable.
    const key = secp256k1.utils.randomSecretKey()
    const pub = secp256k1.getPublicKey(key, false)
    expect(hex.encode(addressFromPublicKey(pub))).toBe(hex.encode(keccak_256(pub.subarray(1)).subarray(-20)))
    expect(hex.encode(addressFromPublicKey(pub))).not.toBe(hex.encode(keccak_256(pub).subarray(-20)))
  })

  it('refuses a compressed or malformed key', () => {
    const key = secp256k1.utils.randomSecretKey()
    expect(() => addressFromPublicKey(secp256k1.getPublicKey(key, true))).toThrow(/65-byte uncompressed/)
    expect(() => addressFromPublicKey(new Uint8Array(65))).toThrow(/65-byte uncompressed/)
  })
})
