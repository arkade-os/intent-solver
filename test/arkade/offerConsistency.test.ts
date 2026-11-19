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
import { ASSET_SWAP_CONTRACT_VERSIONS, offerContract, type Offer } from '@arkade-os/swap/protocol'
import { asset } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { offerContractMatch, offerIsConsistent } from '@arkade-os/solver-arkade/arkade/offerConsistency.js'
import { OFFER_CONTRACT_V1, OFFER_CONTRACT_V2 } from '@arkade-os/solver-core/core/offerContract.js'

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
const honest = offerContract(offerWith({ swapPkScript: new Uint8Array(34) }), SERVER).pkScript

describe('offerIsConsistent', () => {
  it.each(ASSET_SWAP_CONTRACT_VERSIONS)('admits freshly built %s offers with their exact terms', (version) => {
    const { swapPkScript: _script, ...fresh } = offerWith({ swapPkScript: new Uint8Array(34) })
    const pkScript = offerContract(fresh, SERVER, version).pkScript
    expect(offerContractMatch({ ...fresh, swapPkScript: pkScript }, SERVER)).toEqual({ version: OFFER_CONTRACT_V1 })
    expect(offerContractMatch({ ...fresh, wantAmount: 999n, swapPkScript: pkScript }, SERVER)).toBeNull()
  })

  it('rejects a frozen taxi.0 tree for new admission while the SDK can recover it exactly', () => {
    const operator = hex.decode('4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa')
    const pkScript = '51209c06e6e9c33c521574425ce064c571a541af76d60f3fa32fd19b2df195601722'
    const recorded: Offer = {
      wantAmount: 50_000n,
      wantAsset: asset.AssetId.fromString('aa'.repeat(32) + '0000'),
      makerPkScript: hex.decode('51203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1'),
      makerPublicKey: hex.decode('3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1'),
      emulatorPubkey: hex.decode('466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27'),
      swapPkScript: hex.decode(pkScript),
    }
    expect(hex.encode(offerContract(recorded, operator).pkScript)).toBe(pkScript)
    expect(offerContractMatch(recorded, operator)).toBeNull()
  })

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

  it('reports the legacy contract version when the offer has no exit leaf', () => {
    expect(offerContractMatch(offerWith({ swapPkScript: honest }), SERVER)).toEqual({ version: OFFER_CONTRACT_V1 })
  })

  it('reports the current contract version when the offer has an exit leaf', () => {
    const exitDelay = { type: 'seconds', value: 4096n }
    const withExit = offerWith({ swapPkScript: new Uint8Array(34), exitDelay })
    const script = offerContract(withExit, SERVER).pkScript
    expect(offerContractMatch({ ...withExit, swapPkScript: script }, SERVER)).toEqual({ version: OFFER_CONTRACT_V2 })
  })

  it('does not let a packet omit the exit leaf while funding a script that has one', () => {
    const exitDelay = { type: 'seconds', value: 4096n }
    const withExit = offerWith({ swapPkScript: new Uint8Array(34), exitDelay })
    const script = offerContract(withExit, SERVER).pkScript
    expect(offerContractMatch(offerWith({ swapPkScript: script }), SERVER)).toBeNull()
  })
})
