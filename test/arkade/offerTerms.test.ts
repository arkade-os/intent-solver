/**
 * The derivation both sides of an asset RFQ perform independently.
 *
 * Nothing on the wire carries the covenant, so this function IS the agreement:
 * a client funds the address it derived, and this solver watches the script it
 * derived. Every case below is a way the two could stop being the same address —
 * each of which strands a deposit rather than filling it wrongly.
 *
 * Real curve keys throughout, for the reason `offerConsistency.test.ts` gives:
 * filler bytes make the SDK throw and every assertion would pass through the
 * exception rather than on the comparison.
 */
import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { asset } from '@arkade-os/sdk'
import { offerVtxoScript } from '@arkade-os/swap'
import { hex } from '@scure/base'
import {
  offerFromTerms,
  offerScriptFrom,
  xOnlyPubkey,
  type QuotedOfferTerms,
} from '@arkade-os/solver-arkade/arkade/offerTerms.js'

const xonly = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const SERVER = xonly(2)
const MAKER_KEY = xonly(3)
const EMULATOR = xonly(4)
const USDA = '11'.repeat(34)
const MAKER_SCRIPT = '5120' + 'cc'.repeat(32)

const derivation = { serverPubkey: SERVER, emulatorPubkey: EMULATOR, hrp: 'tark' }

const terms = (over: Partial<QuotedOfferTerms> = {}): QuotedOfferTerms => ({
  wantAmount: 1_000n,
  wantAssetId: USDA,
  offerAssetId: null,
  makerPkScript: MAKER_SCRIPT,
  makerPublicKey: hex.encode(MAKER_KEY),
  ...over,
})

const derive = offerScriptFrom(derivation)

describe('offerScriptFrom', () => {
  it('compiles the same covenant the SDK does from the equivalent offer', () => {
    const direct = offerVtxoScript(
      {
        wantAmount: 1_000n,
        wantAsset: asset.AssetId.fromString(USDA),
        makerPkScript: hex.decode(MAKER_SCRIPT),
        makerPublicKey: MAKER_KEY,
        emulatorPubkey: EMULATOR,
      },
      SERVER,
    )
    expect(derive(terms()).pkScript).toBe(hex.encode(direct.pkScript))
    expect(derive(terms()).address).toBe(direct.address('tark', SERVER).encode())
  })

  it('derives a P2TR script, so the comparison is against a real one', () => {
    const pkScript = derive(terms()).pkScript
    expect(pkScript).toHaveLength(68)
    expect(pkScript.slice(0, 4)).toBe('5120')
  })

  it('moves the address when the payout amount moves', () => {
    // The property that makes the accept message unnecessary: a client funding
    // terms this solver did not quote lands somewhere it is not watching.
    expect(derive(terms({ wantAmount: 1_001n }))).not.toEqual(derive(terms()))
  })

  it('moves the address when the maker changes', () => {
    expect(derive(terms({ makerPkScript: '5120' + 'dd'.repeat(32) })).pkScript).not.toBe(derive(terms()).pkScript)
    expect(derive(terms({ makerPublicKey: hex.encode(xonly(7)) })).pkScript).not.toBe(derive(terms()).pkScript)
  })

  it('puts the asset on the leg the terms name, not merely somewhere', () => {
    // `wantAsset` obliges the FILL to deliver it; `offerAsset` says the client
    // deposits it. Swapping them describes the opposite trade, and the two must
    // never compile to one covenant.
    const wants = derive(terms({ wantAssetId: USDA, offerAssetId: null }))
    const offers = derive(terms({ wantAssetId: null, offerAssetId: USDA }))
    expect(wants.pkScript).not.toBe(offers.pkScript)
  })

  it('omits the asset field for a BTC leg rather than naming an id', () => {
    const built = offerFromTerms(terms({ wantAssetId: null, offerAssetId: USDA }), EMULATOR)
    expect(built.wantAsset).toBeUndefined()
    expect(built.offerAsset?.toString()).toBe(USDA)
  })

  it('follows the hrp it is given, so a testnet address never reads as mainnet', () => {
    expect(derive(terms()).address.startsWith('tark1')).toBe(true)
    expect(offerScriptFrom({ ...derivation, hrp: 'ark' })(terms()).address.startsWith('ark1')).toBe(true)
  })

  it('is bound to the signer key, so two Arkade Services derive two addresses', () => {
    expect(offerScriptFrom({ ...derivation, serverPubkey: xonly(9) })(terms()).pkScript).not.toBe(
      derive(terms()).pkScript,
    )
  })
})

describe('xOnlyPubkey', () => {
  it('drops the compressed prefix and leaves an x-only key alone', () => {
    const compressed = new Uint8Array([0x02, ...EMULATOR])
    expect(hex.encode(xOnlyPubkey(compressed))).toBe(hex.encode(EMULATOR))
    expect(hex.encode(xOnlyPubkey(EMULATOR))).toBe(hex.encode(EMULATOR))
  })

  it('makes both spellings of the emulator key derive ONE covenant', () => {
    // The trap this exists for: the emulator advertises 33 bytes and the
    // covenant takes 32, so the raw form would quote an address no client ever
    // derives — and the deposit would never arrive at all.
    const compressed = { ...derivation, emulatorPubkey: new Uint8Array([0x03, ...EMULATOR]) }
    expect(offerScriptFrom(compressed)(terms()).pkScript).toBe(derive(terms()).pkScript)
  })

  it('is bound to the emulator key, so a rotation is a different covenant', () => {
    expect(offerScriptFrom({ ...derivation, emulatorPubkey: xonly(8) })(terms()).pkScript).not.toBe(
      derive(terms()).pkScript,
    )
  })
})
