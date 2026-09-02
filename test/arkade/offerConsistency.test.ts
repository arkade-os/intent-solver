/**
 * Swap Protocol V1 § 5.1: the script an offer claims MUST be the one its terms
 * compile to.
 *
 * Real curve keys throughout, deliberately. With filler bytes the SDK's
 * reconstruction throws ("Cannot find square root") and every case passes
 * through the catch — proving the guard survives a malformed offer, but nothing
 * about whether it compares scripts at all. The terms case below is the one
 * that matters: it is the actual attack.
 */
import { describe, it, expect } from 'vitest'
import { offerVtxoScript, type Offer } from '@arkade-os/swap'
import { schnorr } from '@noble/curves/secp256k1.js'
import { offerIsConsistent } from '@arkade-os/solver-arkade/arkade/offerConsistency.js'

const xonly = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const SERVER = xonly(2)
const USDT = '11'.repeat(34)

/** A maker depositing USDT and wanting sats. */
const terms = {
  wantAmount: 1_000n,
  wantAsset: undefined,
  offerAsset: { toString: () => USDT },
  makerPkScript: new Uint8Array(34).fill(0xcc),
  makerPublicKey: xonly(3),
  emulatorPubkey: xonly(4),
}

const offerWith = (over: Record<string, unknown>): Offer => ({ ...terms, ...over }) as unknown as Offer

/** What those terms actually compile to. */
const honest = offerVtxoScript(offerWith({ swapPkScript: new Uint8Array(34) }), SERVER).pkScript

describe('offerIsConsistent', () => {
  it('accepts an offer claiming the script its terms compile to', () => {
    expect(offerIsConsistent(offerWith({ swapPkScript: honest }), SERVER)).toBe(true)
  })

  it('refuses one claiming a different script', () => {
    expect(offerIsConsistent(offerWith({ swapPkScript: new Uint8Array(34).fill(0xab) }), SERVER)).toBe(false)
  })

  it('refuses when the TERMS were changed under an honest script', () => {
    // The attack: advertise a cheap `wantAmount` in the packet while the script
    // obliges more. A taker that priced the packet would spend the deposit
    // under terms it never checked.
    expect(offerIsConsistent(offerWith({ wantAmount: 2_000n, swapPkScript: honest }), SERVER)).toBe(false)
  })

  it('refuses under a different signer key, whose script is a different one', () => {
    expect(offerIsConsistent(offerWith({ swapPkScript: honest }), xonly(9))).toBe(false)
  })

  it('refuses an offer whose script cannot be reconstructed at all', () => {
    // A key off the curve is a mismatch, not an exception to propagate: a
    // script that cannot be built cannot agree.
    const broken = offerWith({ swapPkScript: honest, makerPublicKey: new Uint8Array(32).fill(0xff) })
    expect(offerIsConsistent(broken, SERVER)).toBe(false)
  })

  it('derives a P2TR script, so the comparison is against a real one', () => {
    expect(honest.length).toBe(34)
    expect([honest[0], honest[1]]).toEqual([0x51, 0x20])
  })
})
