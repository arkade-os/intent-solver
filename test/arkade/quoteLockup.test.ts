import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { arkadeAddressPkScript, clientFundedLockupScript } from '@arkade-os/solver-arkade/arkade/quoteLockup.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'

const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const key = (fill: number): string => hex.encode(keyBytes(fill))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])
const SERVER = 3

const scriptOn = (server: number) =>
  new CovenantSwapScript({
    receiver: keyBytes(5),
    server: keyBytes(server),
    preimageHash: new Uint8Array(20).fill(9),
    refundLocktime: 1_800_000_000,
    claimDelay: 4096,
    client: keyBytes(11),
    clientRefundDelay: 1024,
    refundWithoutServerDelay: 2048,
    nonInteractiveParameters: {
      emulatorPubkey: keyBytes(9),
      receiverPkScript: p2tr(keyBytes(13)),
      senderPkScript: p2tr(keyBytes(5)),
    },
  })
const addressOn = (server: number, hrp = 'ark') => scriptOn(server).address(hrp, keyBytes(server)).encode()

describe('arkadeAddressPkScript', () => {
  const ours = addressOn(SERVER)

  it('gives the pkScript of an address on this network, in either case', () => {
    const expected = hex.encode(scriptOn(SERVER).pkScript)
    expect(hex.encode(arkadeAddressPkScript(ours, 'ark', null)!)).toBe(expected)
    expect(hex.encode(arkadeAddressPkScript(ours.toUpperCase(), 'ark', null)!)).toBe(expected)
  })

  it('refuses another network, and what is not an address at all', () => {
    for (const bad of [addressOn(SERVER, 'tark'), 'not-an-address', '', ours.slice(0, -3), `${ours}x`, 'ark1qqqq']) {
      expect(arkadeAddressPkScript(bad, 'ark', null)).toBeNull()
    }
  })

  it('looks at the server only when given one, and refuses when the one given is missing', () => {
    const foreign = addressOn(SERVER + 1)
    expect(arkadeAddressPkScript(foreign, 'ark', null)).not.toBeNull()
    expect(arkadeAddressPkScript(foreign, 'ark', key(SERVER))).toBeNull()
    expect(arkadeAddressPkScript(ours, 'ark', key(SERVER))).not.toBeNull()
    expect(arkadeAddressPkScript(ours, 'ark', undefined as never)).toBeNull()
  })
})

describe('clientFundedLockupScript', () => {
  const arkade = {
    providerPubkey: key(1),
    serverPubkey: key(SERVER),
    emulatorPubkey: key(9),
    receiverPkScript: hex.encode(p2tr(keyBytes(1))),
  }
  const paymentHash = 'ab'.repeat(32)
  const refundPkScript = p2tr(keyBytes(5))
  const delays = { unilateralClaimDelay: 4096, unilateralRefundDelay: 4608, unilateralRefundWithoutReceiverDelay: 5120 }

  it('builds the script the corridors built by hand, with each delay on its own leaf', () => {
    const byHand = new CovenantSwapScript({
      receiver: keyBytes(1),
      server: keyBytes(SERVER),
      preimageHash: scriptHashFromPaymentHash(paymentHash),
      refundLocktime: 1_800_000_000,
      claimDelay: 4096,
      client: keyBytes(11),
      clientRefundDelay: 5120,
      refundWithoutServerDelay: 4608,
      nonInteractiveParameters: {
        emulatorPubkey: keyBytes(9),
        receiverPkScript: p2tr(keyBytes(1)),
        senderPkScript: refundPkScript,
      },
    })
    const built = clientFundedLockupScript(arkade, {
      paymentHash,
      refundLocktime: 1_800_000_000,
      delays,
      clientRefundPubkey: key(11),
      refundPkScript,
    })
    expect(hex.encode(built.pkScript)).toBe(hex.encode(byHand.pkScript))
    expect(hex.encode(built.encode())).toBe(hex.encode(byHand.encode()))
  })

  it('gives a different script when two delays trade places', () => {
    const lockup = { paymentHash, refundLocktime: 1_800_000_000, clientRefundPubkey: key(11), refundPkScript }
    const swapped = { ...delays, unilateralRefundDelay: 5120, unilateralRefundWithoutReceiverDelay: 4608 }
    expect(hex.encode(clientFundedLockupScript(arkade, { ...lockup, delays }).pkScript)).not.toBe(
      hex.encode(clientFundedLockupScript(arkade, { ...lockup, delays: swapped }).pkScript),
    )
  })
})
