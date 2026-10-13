import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { rlpEncode, rlpQuantity, type RlpInput } from '@arkade-os/solver-rails-evm/evm/rlp.js'
import {
  addressFromPrivateKey,
  createAddress,
  decodeSignedTransaction,
  signTransaction,
  type Eip1559Fields,
} from '@arkade-os/solver-rails-evm/evm/transaction.js'

const KEY = hex.decode('00'.repeat(31) + '01')
const fields = (): Eip1559Fields => ({
  chainId: 31337n,
  nonce: 0n,
  maxPriorityFeePerGas: 1n,
  maxFeePerGas: 2_000_000_000n,
  gas: 100_000n,
  to: hex.decode('22'.repeat(20)),
  value: 0n,
  data: hex.decode('deadbeef'),
})

const items = (): RlpInput[] => {
  const tx = fields()
  const decoded = decodeSignedTransaction(signTransaction(tx, KEY).raw)
  return [
    rlpQuantity(tx.chainId),
    rlpQuantity(tx.nonce),
    rlpQuantity(tx.maxPriorityFeePerGas),
    rlpQuantity(tx.maxFeePerGas),
    rlpQuantity(tx.gas),
    tx.to,
    rlpQuantity(tx.value),
    tx.data,
    [],
    rlpQuantity(decoded.yParity),
    decoded.r,
    decoded.s,
  ]
}
const encode = (values: readonly RlpInput[]): Uint8Array => concatBytes(Uint8Array.of(2), rlpEncode(values))

const withItem = (index: number, value: RlpInput): Uint8Array => {
  const values = items()
  values[index] = value
  return encode(values)
}

describe('canonical signed transaction decoding', () => {
  it('recovers all transaction commitments from raw signed bytes', () => {
    const tx = fields()
    const signed = signTransaction(tx, KEY)
    const decoded = decodeSignedTransaction(signed.raw)
    expect(decoded.fields).toEqual(tx)
    expect(decoded.from).toEqual(addressFromPrivateKey(KEY))
    expect(decoded.hash).toEqual(signed.hash)
    expect(decoded.hash).toEqual(keccak_256(decoded.raw))
    expect(decoded.raw).toEqual(signed.raw)
  })

  it('supports deterministic CREATE signing and decodes an empty destination', () => {
    const tx = { ...fields(), to: new Uint8Array(), data: hex.decode('60006000f3') }
    const signed = signTransaction(tx, KEY)
    expect(decodeSignedTransaction(signed.raw).fields).toEqual(tx)
    expect(signTransaction(tx, KEY).raw).toEqual(signed.raw)
    expect(createAddress(signed.from, tx.nonce)).toEqual(hex.decode('f2e246bb76df876cef8b38ae84130f4f55de395b'))
  })

  it('owns copies of the raw bytes and decoded data', () => {
    const signed = signTransaction(fields(), KEY)
    const decoded = decodeSignedTransaction(signed.raw)
    signed.raw.fill(0)
    expect(decoded.raw[0]).toBe(2)
    decoded.fields.data.fill(0)
    expect(decodeSignedTransaction(decoded.raw).fields.data).toEqual(fields().data)
  })

  it('recovers the known chain sender from an externally accepted signature', () => {
    const tx: Eip1559Fields = {
      chainId: 0xa4b1n,
      nonce: 0x47af5n,
      maxPriorityFeePerGas: 0n,
      maxFeePerGas: 0x26288e0n,
      gas: 0x63d2n,
      to: hex.decode('bb009247cea2cf3aaa7a6e24382744515c8242b0'),
      value: 0xbbf2ad2c40n,
      data: new Uint8Array(),
    }
    const raw = encode([
      rlpQuantity(tx.chainId),
      rlpQuantity(tx.nonce),
      rlpQuantity(tx.maxPriorityFeePerGas),
      rlpQuantity(tx.maxFeePerGas),
      rlpQuantity(tx.gas),
      tx.to,
      rlpQuantity(tx.value),
      tx.data,
      [],
      new Uint8Array(),
      hex.decode('2ea948c52d4fa4cdd450e2a95b23eb71653f84524022803f45b4d4e6316f835b'),
      hex.decode('2e21bda8ab375be7e3e7cb49cdc5e4c600a59b13c8c70b4988e595a0fd1ac015'),
    ])
    expect(hex.encode(decodeSignedTransaction(raw).from)).toBe('af694dd50895fc3f816122518a425de63660fe76')
    expect(decodeSignedTransaction(raw).fields).toEqual(tx)
  })

  it.each([0, 1, 2, 3, 4, 6, 9, 10, 11])('rejects nonminimal numeric field %i', (index) => {
    expect(() => decodeSignedTransaction(withItem(index, Uint8Array.of(0, 1)))).toThrow('canonical')
    expect(() => decodeSignedTransaction(withItem(index, Uint8Array.of(0)))).toThrow('canonical')
    expect(() => decodeSignedTransaction(withItem(index, new Uint8Array(33).fill(1)))).toThrow('canonical')
  })

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11])('rejects lists in scalar field %i', (index) => {
    expect(() => decodeSignedTransaction(withItem(index, []))).toThrow('empty access list')
  })

  it('requires exactly twelve fields and an empty access list', () => {
    expect(() => decodeSignedTransaction(encode(items().slice(0, 11)))).toThrow('twelve')
    expect(() => decodeSignedTransaction(encode([...items(), []]))).toThrow()
    expect(() => decodeSignedTransaction(withItem(8, new Uint8Array()))).toThrow('twelve')
    expect(() => decodeSignedTransaction(withItem(8, [new Uint8Array(20)]))).toThrow('empty access list')
  })

  it('rejects invalid signature scalars, parity, and high-s malleability', () => {
    for (const index of [10, 11]) {
      expect(() => decodeSignedTransaction(withItem(index, new Uint8Array()))).toThrow()
      expect(() => decodeSignedTransaction(withItem(index, rlpQuantity(secp256k1.Point.CURVE().n)))).toThrow()
    }
    expect(() => decodeSignedTransaction(withItem(9, Uint8Array.of(2)))).toThrow('yParity')
    const decoded = decodeSignedTransaction(signTransaction(fields(), KEY).raw)
    const lowS = BigInt('0x' + hex.encode(decoded.s))
    expect(() => decodeSignedTransaction(withItem(11, rlpQuantity(secp256k1.Point.CURVE().n - lowS)))).toThrow('low s')
  })

  it('rejects invalid chain, destination, fee ordering, gas, and nonce', () => {
    expect(() => decodeSignedTransaction(withItem(0, new Uint8Array()))).toThrow('positive')
    expect(() => decodeSignedTransaction(withItem(4, new Uint8Array()))).toThrow('positive')
    expect(() => decodeSignedTransaction(withItem(4, rlpQuantity(1n << 64n)))).toThrow('gas exceeds')
    expect(() => decodeSignedTransaction(withItem(5, new Uint8Array(19)))).toThrow('to must')
    expect(() => decodeSignedTransaction(withItem(2, rlpQuantity(fields().maxFeePerGas + 1n)))).toThrow('priority fee')
    expect(() => decodeSignedTransaction(withItem(1, rlpQuantity((1n << 64n) - 1n)))).toThrow('nonce')
  })

  it('rejects other transaction types, trailing bytes, and truncated payloads', () => {
    const raw = signTransaction(fields(), KEY).raw
    expect(() => decodeSignedTransaction(concatBytes(Uint8Array.of(1), raw.slice(1)))).toThrow('EIP-1559')
    expect(() => decodeSignedTransaction(new Uint8Array())).toThrow('EIP-1559')
    expect(() => decodeSignedTransaction(Uint8Array.of(2, 0x80))).toThrow('complete RLP list')
    expect(() => decodeSignedTransaction(concatBytes(raw, Uint8Array.of(0)))).toThrow('complete RLP list')
    expect(() => decodeSignedTransaction(raw.slice(0, -1))).toThrow('truncated')
  })

  it('rejects noncanonical RLP lengths and prefixed small single bytes', () => {
    const raw = signTransaction(fields(), KEY).raw
    expect(raw[1]).toBe(0xf8)
    expect(() => decodeSignedTransaction(concatBytes(Uint8Array.of(2, 0xf9, 0), raw.slice(2)))).toThrow('RLP length')
    expect(() => decodeSignedTransaction(Uint8Array.of(2, 0xf8, 1, 0x80))).toThrow('noncanonical long')
    const encodedItems = items().map(rlpEncode)
    encodedItems[2] = Uint8Array.of(0x81, 1)
    const payload = concatBytes(...encodedItems)
    expect(() => decodeSignedTransaction(concatBytes(Uint8Array.of(2, 0xf8, payload.length), payload))).toThrow(
      'single-byte',
    )
    expect(() =>
      decodeSignedTransaction(Uint8Array.of(2, 0xff, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)),
    ).toThrow('safe bounds')
  })
})

describe('contract creation address derivation', () => {
  it('matches fixed Ethereum CREATE vectors and changes with nonce', () => {
    const sender = hex.decode('deadbeef' + '00'.repeat(16))
    expect(hex.encode(createAddress(sender, 0n))).toBe('f2048c36a5536fea3bc71d49ed59f2c65c546eea')
    expect(hex.encode(createAddress(sender, 1n))).toBe('054dd934335ea61232ae4c051f8bf20e540f8291')
    expect(createAddress(sender, 0n)).not.toEqual(createAddress(sender, 128n))
  })

  it('rejects malformed sender and nonce', () => {
    expect(() => createAddress(new Uint8Array(19), 0n)).toThrow('sender')
    expect(() => createAddress(new Uint8Array(20), -1n)).toThrow('nonce')
    expect(() => createAddress(new Uint8Array(20), (1n << 64n) - 1n)).toThrow('nonce')
  })

  it('refuses invalid numeric commitments before signing', () => {
    expect(() => signTransaction({ ...fields(), value: 1n << 256n }, KEY)).toThrow('uint256')
    expect(() => signTransaction({ ...fields(), nonce: -1n }, KEY)).toThrow('uint256')
    expect(() => signTransaction({ ...fields(), maxPriorityFeePerGas: 3_000_000_000n }, KEY)).toThrow('priority fee')
  })
})
