import { describe, it, expect } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { hex } from '@scure/base'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'

const claimPubkey = new Uint8Array(32).fill(1)
const refundPubkey = new Uint8Array(32).fill(2)
const preimage = new Uint8Array(32).fill(7)
const paymentHash = hex.encode(sha256(preimage)) // the WIRE form: sha256(P), hex
const hash160 = ripemd160(sha256(preimage)) // what the script actually commits to, derived internally
const refundLocktime = 1_785_974_400 // an absolute unix-seconds CLTV, well above LOCKTIME_THRESHOLD

/**
 * Whether the leaf's opening `SIZE <n> EQUALVERIFY` admits a preimage of this
 * length, read back off the compiled bytes — nothing in this repo can execute a
 * script, so the gate is exercised against the operand the leaf actually carries.
 * A leaf with no such prefix gates on nothing and admits every length.
 */
const acceptsPreimageLength = (claimScript: Uint8Array, length: number): boolean => {
  const [size, push, operand, equalverify] = claimScript
  if (size !== 0x82 || push !== 0x01 || equalverify !== 0x88) return true
  return operand === length
}

describe('buildOnchainHtlc', () => {
  it('derives a P2TR address deterministically from the same params', () => {
    const a = buildOnchainHtlc({
      network: ONCHAIN_NETWORKS.regtest,
      paymentHash,
      claimPubkey,
      refundPubkey,
      refundLocktime,
    })
    const b = buildOnchainHtlc({
      network: ONCHAIN_NETWORKS.regtest,
      paymentHash,
      claimPubkey,
      refundPubkey,
      refundLocktime,
    })
    expect(a.address).toBe(b.address)
    expect(a.address.startsWith('bcrt1p')).toBe(true)
  })

  it('the claim leaf decodes to SIZE 32 EQUALVERIFY HASH160 <hash> EQUALVERIFY <claimPubkey> CHECKSIG, hash derived from the wire payment_hash', () => {
    const htlc = buildOnchainHtlc({
      network: ONCHAIN_NETWORKS.regtest,
      paymentHash,
      claimPubkey,
      refundPubkey,
      refundLocktime,
    })
    // 0x82 SIZE, 0x0120 a minimal 1-byte push of 32, 0x88 EQUALVERIFY
    expect(hex.encode(htlc.claimScript)).toBe(
      hex.encode(Uint8Array.from([0x82, 0x01, 0x20, 0x88, 0xa9, 0x14, ...hash160, 0x88, 0x20, ...claimPubkey, 0xac])),
    )
    expect(acceptsPreimageLength(htlc.claimScript, 32)).toBe(true)
  })

  it('the claim leaf turns away a 33-byte preimage that still HASH160s to the commitment', () => {
    // sha256 takes an input of any length, so a 33-byte P yields a perfectly
    // well-formed 32-byte wire payment_hash and a leaf committing to exactly its
    // HASH160 — the length gate is all that stands between it and the claim leaf.
    const longPreimage = new Uint8Array(33).fill(9)
    const longHash160 = ripemd160(sha256(longPreimage))
    const htlc = buildOnchainHtlc({
      network: ONCHAIN_NETWORKS.regtest,
      paymentHash: hex.encode(sha256(longPreimage)),
      claimPubkey,
      refundPubkey,
      refundLocktime,
    })
    // the HASH160 check on its own would wave this preimage straight through
    expect(hex.encode(htlc.claimScript)).toBe(
      hex.encode(
        Uint8Array.from([0x82, 0x01, 0x20, 0x88, 0xa9, 0x14, ...longHash160, 0x88, 0x20, ...claimPubkey, 0xac]),
      ),
    )
    expect(acceptsPreimageLength(htlc.claimScript, 33)).toBe(false)
  })

  it('the refund leaf decodes to <locktime> CHECKLOCKTIMEVERIFY DROP <refundPubkey> CHECKSIG', () => {
    const htlc = buildOnchainHtlc({
      network: ONCHAIN_NETWORKS.regtest,
      paymentHash,
      claimPubkey,
      refundPubkey,
      refundLocktime,
    })
    // minimally-encoded CScriptNum for 1_785_974_400 is the 4 bytes below (little-endian, sign bit clear)
    expect(hex.encode(htlc.refundScript)).toBe(
      hex.encode(Uint8Array.from([0x04, 0x80, 0xce, 0x73, 0x6a, 0xb1, 0x75, 0x20, ...refundPubkey, 0xac])),
    )
  })

  it('rejects a refund locktime below LOCKTIME_THRESHOLD (would read as a block height)', () => {
    expect(() =>
      buildOnchainHtlc({
        network: ONCHAIN_NETWORKS.regtest,
        paymentHash,
        claimPubkey,
        refundPubkey,
        refundLocktime: 800_000,
      }),
    ).toThrow(/LOCKTIME_THRESHOLD/)
  })

  it('rejects a payment hash that is not 32 bytes (64 hex chars)', () => {
    expect(() =>
      buildOnchainHtlc({
        network: ONCHAIN_NETWORKS.regtest,
        paymentHash: 'aa'.repeat(20),
        claimPubkey,
        refundPubkey,
        refundLocktime,
      }),
    ).toThrow(/32 bytes/)
  })

  it('differs by network (mainnet vs regtest bech32 hrp)', () => {
    const mainnet = buildOnchainHtlc({
      network: ONCHAIN_NETWORKS.bitcoin,
      paymentHash,
      claimPubkey,
      refundPubkey,
      refundLocktime,
    })
    expect(mainnet.address.startsWith('bc1p')).toBe(true)
  })
})
