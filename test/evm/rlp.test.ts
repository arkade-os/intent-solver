import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { rlpEncode, rlpQuantity } from '@arkade-os/solver-rails-evm/evm/rlp.js'

const b = (h: string) => hex.decode(h)
const enc = (input: Parameters<typeof rlpEncode>[0]) => hex.encode(rlpEncode(input))

describe('rlpEncode — the spec`s own examples', () => {
  it('encodes a single low byte as itself', () => {
    // Not an optimisation. An encoder that always emits the 0x80+n prefix
    // produces different bytes, and so a different transaction hash, for the
    // same transaction.
    expect(enc(b('00'))).toBe('00')
    expect(enc(b('7f'))).toBe('7f')
  })

  it('prefixes a byte at or above 0x80', () => {
    expect(enc(b('80'))).toBe('8180')
  })

  it('encodes the empty string and the empty list', () => {
    expect(enc(new Uint8Array(0))).toBe('80')
    expect(enc([])).toBe('c0')
  })

  it('encodes a short string with its length', () => {
    expect(enc(new TextEncoder().encode('dog'))).toBe('83646f67')
  })

  it('switches to the long form above 55 bytes', () => {
    const short = new Uint8Array(55).fill(0xaa)
    const long = new Uint8Array(56).fill(0xaa)
    expect(enc(short).slice(0, 2)).toBe('b7') // 0x80 + 55
    expect(enc(long).slice(0, 4)).toBe('b838') // 0xb7 + 1 length byte, then 56
  })

  it('nests lists', () => {
    expect(enc([b('01'), [b('02'), b('03')]])).toBe('c401c20203')
  })
})

describe('rlpQuantity', () => {
  it('encodes zero as EMPTY, not as a zero byte', () => {
    // The rule that bites hardest. RLP has no number type, so a zero field is
    // the empty string. Encoding `0x00` yields a structurally valid
    // transaction with a different hash — and `value: 0` is every ERC-20 call.
    expect(rlpQuantity(0n)).toHaveLength(0)
    expect(enc(rlpQuantity(0n))).toBe('80')
  })

  it('is minimal-length big-endian', () => {
    expect(hex.encode(rlpQuantity(1n))).toBe('01')
    expect(hex.encode(rlpQuantity(255n))).toBe('ff')
    expect(hex.encode(rlpQuantity(256n))).toBe('0100')
    expect(hex.encode(rlpQuantity(0xa4b1n))).toBe('a4b1')
  })

  it('refuses a negative quantity', () => {
    expect(() => rlpQuantity(-1n)).toThrow(/must not be negative/)
  })
})

/**
 * The external check, and the reason this module is hand-rolled at all.
 *
 * A transaction's hash IS `keccak256` of its signed RLP, so re-encoding a real
 * transaction's fields and reproducing the hash the chain indexed it by proves
 * the whole layout at once: field order, the type-2 envelope, minimal-length
 * quantities, and the empty-for-zero rule.
 *
 * Fixture: a live Arbitrum (chain 0xa4b1) EIP-1559 transaction, chosen for
 * empty calldata and `maxPriorityFeePerGas: 0` so the zero rule is exercised.
 * Re-derivable with `eth_getTransactionByHash`.
 */
describe('EIP-1559 envelope — reproduces a real transaction`s hash', () => {
  const tx = {
    hash: '4ee466e2c5b4a52804a7b0efbfe93ec9d130cfea5f1fb085e794e841ef48dbca',
    chainId: 0xa4b1n,
    nonce: 0x47af5n,
    maxPriorityFeePerGas: 0n,
    maxFeePerGas: 0x26288e0n,
    gas: 0x63d2n,
    to: 'bb009247cea2cf3aaa7a6e24382744515c8242b0',
    value: 0xbbf2ad2c40n,
    input: '',
    yParity: 0n,
    r: '2ea948c52d4fa4cdd450e2a95b23eb71653f84524022803f45b4d4e6316f835b',
    s: '2e21bda8ab375be7e3e7cb49cdc5e4c600a59b13c8c70b4988e595a0fd1ac015',
  }

  const signedPayload = () =>
    Uint8Array.from([
      0x02,
      ...rlpEncode([
        rlpQuantity(tx.chainId),
        rlpQuantity(tx.nonce),
        rlpQuantity(tx.maxPriorityFeePerGas),
        rlpQuantity(tx.maxFeePerGas),
        rlpQuantity(tx.gas),
        b(tx.to),
        rlpQuantity(tx.value),
        b(tx.input),
        [],
        rlpQuantity(tx.yParity),
        rlpQuantity(BigInt(`0x${tx.r}`)),
        rlpQuantity(BigInt(`0x${tx.s}`)),
      ]),
    ])

  it('hashes to the id the chain gave it', () => {
    expect(hex.encode(keccak_256(signedPayload()))).toBe(tx.hash)
  })

  it('would NOT match if zero were encoded as a zero byte', () => {
    // Pins the rule that the fixture is really testing. `maxPriorityFeePerGas`
    // is 0 in this transaction, so a `0x00` encoding changes the hash.
    const wrong = Uint8Array.from([
      0x02,
      ...rlpEncode([
        rlpQuantity(tx.chainId),
        rlpQuantity(tx.nonce),
        b('00'), // the mistake
        rlpQuantity(tx.maxFeePerGas),
        rlpQuantity(tx.gas),
        b(tx.to),
        rlpQuantity(tx.value),
        b(tx.input),
        [],
        rlpQuantity(tx.yParity),
        rlpQuantity(BigInt(`0x${tx.r}`)),
        rlpQuantity(BigInt(`0x${tx.s}`)),
      ]),
    ])
    expect(hex.encode(keccak_256(wrong))).not.toBe(tx.hash)
  })
})
