/**
 * Derive an offer address as this solver does and as a client's `createOffer`
 * does, and require the SAME STRING — a wrong unit, a rounded value or the local
 * override all pass a mere "is `exitDelay` set?" check and still strand the
 * deposit. The client half is the REAL createOffer against its wallet live-info
 * seam: serverExitDelay is package-internal and otherwise unobservable.
 */
import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ArkAddress, CSVMultisigTapscript, asset } from '@arkade-os/sdk'
import { createOffer, offerContract } from '@arkade-os/swap/protocol'
import { hex } from '@scure/base'
import {
  offerExitDelay,
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
const HRP = 'tark'
const MAKER_ADDRESS = new ArkAddress(SERVER, xonly(5), HRP).encode()
const MAKER_SCRIPT = hex.encode(ArkAddress.decode(MAKER_ADDRESS).pkScript)

const terms: QuotedOfferTerms = {
  wantAmount: 19_900n,
  wantAssetId: USDA,
  offerAssetId: null,
  makerPkScript: MAKER_SCRIPT,
  makerPublicKey: hex.encode(MAKER_KEY),
}

const infoBody = (unilateralExitDelay: string): string =>
  JSON.stringify({
    signerPubkey: hex.encode(SERVER),
    network: 'regtest',
    unilateralExitDelay,
    vtxoTreeExpiry: '604672',
    boardingExitDelay: '604672',
    roundInterval: '10',
    dust: '1000',
    forfeitAddress: 'bcrt1qforfeit',
    marketHour: null,
    checkpointTapscript: hex.encode(
      CSVMultisigTapscript.encode({ timelock: { type: 'blocks', value: 10n }, pubkeys: [SERVER] }).script,
    ),
  })

const clientWallet = () => ({
  getAddress: async () => MAKER_ADDRESS,
  identity: { xOnlyPublicKey: async () => MAKER_KEY },
  getContractManager: async () =>
    new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async () => undefined) }),
})

const clientOffer = async (unilateralExitDelay: number) =>
  createOffer(
    {
      ...clientWallet(),
      getArkadeInfo: async () => ({
        ...JSON.parse(infoBody(String(unilateralExitDelay))),
        unilateralExitDelay: BigInt(unilateralExitDelay),
      }),
    } as never,
    {
      wantAmount: terms.wantAmount,
      wantAsset: asset.AssetId.fromString(USDA),
      emulatorPubkey: '02' + hex.encode(EMULATOR),
    },
  )

const solverOffer = (unilateralExitDelay: number) =>
  offerScriptFrom({
    serverPubkey: SERVER,
    emulatorPubkey: EMULATOR,
    hrp: HRP,
    exitDelay: offerExitDelay(unilateralExitDelay),
  })(terms)

describe('offer address agreement with the protocol client', () => {
  it.each([
    ['seconds-typed, as a public deployment advertises', 605_184],
    ['block-typed, as a regtest deployment advertises', 144],
    ['at the 512 boundary, where the unit flips to seconds', 512],
    ['one below the boundary, still blocks', 511],
  ])('derives the SAME address as the client — %s', async (_name, advertised) => {
    const mine = solverOffer(advertised)
    const theirs = await clientOffer(advertised)

    expect(mine.address).toBe(theirs.address)
    expect(mine.pkScript).toBe(hex.encode(theirs.swapPkScript))
  })

  it('reconstructs the SAME covenant on the settle path', async () => {
    // A rebuild that drops the exit leaf spends what the client never funded.
    const exitDelay = offerExitDelay(605_184)
    const rebuilt = offerFromTerms(terms, xOnlyPubkey(EMULATOR), exitDelay)
    const theirs = await clientOffer(605_184)

    expect(hex.encode(offerContract(rebuilt, SERVER).pkScript)).toBe(hex.encode(theirs.swapPkScript))
  })

  it('moves the address when the advertised delay does', async () => {
    expect(solverOffer(605_184).address).not.toBe(solverOffer(604_672).address)
  })
})

describe('offerExitDelay', () => {
  it('reads the unit off the value, the way BIP68 encodes it', () => {
    expect(offerExitDelay(605_184)).toEqual({ type: 'seconds', value: 605_184n })
    expect(offerExitDelay(144)).toEqual({ type: 'blocks', value: 144n })
  })

  it('refuses a delay no client could build an exit closure from', () => {
    expect(() => offerExitDelay(0)).toThrow(/unilateralExitDelay=0/)
    expect(() => offerExitDelay(-1)).toThrow(/no client can build/)
    expect(() => offerExitDelay(1.5)).toThrow(/unilateralExitDelay=1.5/)
  })

  it('refuses a seconds delay BIP68 cannot encode, rather than leaving it to quote time', async () => {
    // BOTH sides throw, so no deposit is misdirected — legibility, not agreement.
    expect(() => offerExitDelay(605_000)).toThrow(/must be a whole multiple of 512/)
    await expect(clientOffer(605_000)).rejects.toThrow(/multiple of 512/)
    expect(() => offerExitDelay(511)).not.toThrow()
  })
})
