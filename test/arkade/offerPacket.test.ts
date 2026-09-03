/**
 * The intake half of the taker: a funding transaction in, a decided-about offer out.
 *
 * Every input here is ATTACKER-SUPPLIED. `streamOfferTxs` yields whatever arkd
 * matched, and arkd's filter proves only that a packet of type 3 is present —
 * not that its bytes decode, not that its terms are sane, and not that the
 * transaction carrying it funds the script the packet names. So the cases that
 * matter are the refusals, and that each refusal is a `null` rather than a throw:
 * one malformed packet must cost one offer, never the discovery loop.
 */
import { describe, it, expect } from 'vitest'
import { Extension, UnknownPacket, asset, type ExtensionPacket } from '@arkade-os/sdk'
import { encodeOffer, OFFER_PACKET_TYPE, type Offer } from '@arkade-os/swap'
import { Transaction } from '@scure/btc-signer'
import { base64, hex } from '@scure/base'
import { offerFromFundingTx } from '@arkade-os/solver-arkade/arkade/offerPacket.js'

const USD = '41bcbb06921a0e9f6fe4f1b003b878cbb43d9ca3f6d14cab7940090458765a390000'
const SWAP_SCRIPT = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xab)])
const MAKER_SCRIPT = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xcd)])

/** A maker depositing USD and wanting sats — the direction the fill pays in sats. */
const offer = (over: Partial<Offer> = {}): Offer =>
  ({
    swapPkScript: SWAP_SCRIPT,
    wantAmount: 1_000n,
    offerAsset: asset.AssetId.fromString(USD),
    makerPkScript: MAKER_SCRIPT,
    makerPublicKey: new Uint8Array(32).fill(0x11),
    emulatorPubkey: new Uint8Array(32).fill(0x22),
    ...over,
  }) as Offer

/**
 * A funding transaction as the stream delivers one: base64 PSBT, an extension
 * output carrying the packet, and a deposit at the offer's own script.
 */
const fundingTx = (args: {
  packets?: readonly ExtensionPacket[]
  outputs?: readonly { script: Uint8Array; amount: bigint }[]
}): string => {
  const tx = new Transaction({ allowUnknownOutputs: true, disableScriptCheck: true })
  for (const output of args.outputs ?? [{ script: SWAP_SCRIPT, amount: 5_000n }]) {
    tx.addOutput({ script: output.script, amount: output.amount })
  }
  if (args.packets) {
    const out = Extension.create([...args.packets]).txOut()
    tx.addOutput({ script: out.script, amount: out.amount })
  }
  return base64.encode(tx.toPSBT())
}

const offerPacket = (bytes: Uint8Array): ExtensionPacket => new UnknownPacket(OFFER_PACKET_TYPE, bytes)

describe('offerFromFundingTx', () => {
  it('recovers the offer, its deposit outpoint and the sats sitting on it', () => {
    const published = offer()
    const raw = fundingTx({ packets: [offerPacket(encodeOffer(published))] })

    const found = offerFromFundingTx(raw)
    expect(found).not.toBeNull()
    expect(hex.encode(found!.offer.swapPkScript)).toBe(hex.encode(SWAP_SCRIPT))
    expect(found!.offer.wantAmount).toBe(1_000n)
    expect(found!.offer.offerAsset?.toString()).toBe(USD)
    expect(found!.vout).toBe(0)
    expect(found!.value).toBe(5_000)
  })

  it('takes the txid from the BYTES, never from what announced them', () => {
    // The stream announces a txid beside the transaction. Deriving it here
    // instead means the outpoint recorded is the outpoint of the offer we
    // actually decoded, so a relay that announced A and shipped B cannot get a
    // row keyed on A while settlement spends B.
    const raw = fundingTx({ packets: [offerPacket(encodeOffer(offer()))] })
    const expected = Transaction.fromPSBT(base64.decode(raw)).id
    expect(offerFromFundingTx(raw)!.txid).toBe(expected)
  })

  it('finds the deposit wherever it sits, not at output 0', () => {
    const raw = fundingTx({
      packets: [offerPacket(encodeOffer(offer()))],
      outputs: [
        { script: MAKER_SCRIPT, amount: 700n },
        { script: SWAP_SCRIPT, amount: 5_000n },
      ],
    })
    const found = offerFromFundingTx(raw)
    expect(found!.vout).toBe(1)
    expect(found!.value).toBe(5_000)
  })

  it('refuses a packet whose script this transaction never funded', () => {
    // The packet is well-formed and says nothing false about itself — it simply
    // rides a transaction that funds something else. Recording an intent here
    // would key a row to an outpoint that is not the deposit.
    const raw = fundingTx({
      packets: [offerPacket(encodeOffer(offer()))],
      outputs: [{ script: MAKER_SCRIPT, amount: 5_000n }],
    })
    expect(offerFromFundingTx(raw)).toBeNull()
  })

  it('returns null, never throws, on a packet that does not decode', () => {
    const raw = fundingTx({ packets: [offerPacket(new Uint8Array([0xff, 0xff, 0xff]))] })
    expect(offerFromFundingTx(raw)).toBeNull()
  })

  it('returns null for a transaction carrying no extension at all', () => {
    expect(offerFromFundingTx(fundingTx({}))).toBeNull()
  })

  it('returns null for an extension carrying no offer packet', () => {
    const raw = fundingTx({ packets: [new UnknownPacket(9, new Uint8Array([0x01]))] })
    expect(offerFromFundingTx(raw)).toBeNull()
  })

  it('returns null for bytes that are not a transaction', () => {
    expect(offerFromFundingTx('not base64 at all !!!')).toBeNull()
    expect(offerFromFundingTx(base64.encode(new Uint8Array([1, 2, 3])))).toBeNull()
  })
})
