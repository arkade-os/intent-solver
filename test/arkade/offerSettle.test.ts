/**
 * The exit: turning a recorded intent back into the spend that fills it.
 *
 * `OfferFillRow` deliberately stores the offer's TERMS and not the offer — the
 * store's comment is that the covenant is derived from those values, so a row
 * that could edit them could describe a contract that was never funded. That
 * leaves settlement having to recover the offer itself, and the only honest
 * source is the funding transaction the row is keyed to.
 *
 * So every case here is a DISAGREEMENT between that transaction and the row,
 * and every one of them must refuse before `fulfillOffer` is reached. None can
 * happen through `consider()` alone: they are tripwires on the last step before
 * someone else's deposit is spent, and a tripwire that only fires after the
 * spend is not one.
 *
 * The construction of the fill is NOT covered here, for the reason
 * `offerFulfill.test.ts` gives: `test/e2e/assetOffer.e2e.test.ts` settles a real
 * one instead.
 */
import { describe, it, expect, vi } from 'vitest'
import { Extension, UnknownPacket, asset, type ExtensionPacket } from '@arkade-os/sdk'
import { encodeOffer, OFFER_PACKET_TYPE, type Offer } from '@arkade-os/swap'
import { Transaction } from '@scure/btc-signer'
import { base64, hex } from '@scure/base'
import { offerSettleFor, type OfferFillIntent } from '@arkade-os/solver-arkade/arkade/offerSettle.js'
import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'

const USD = '41bcbb06921a0e9f6fe4f1b003b878cbb43d9ca3f6d14cab7940090458765a390000'
const EUR = '7cfc24fc9b275633780502ba8d7bf8431501b52246856df8d402e4bc9627ebc90000'
const SWAP_SCRIPT = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xab)])
const SWAP_SCRIPT_HEX = hex.encode(SWAP_SCRIPT)
const MAKER_SCRIPT = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xcd)])
const DEPOSIT_SATS = 5_000

/** A maker depositing USD and wanting sats. */
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

const fundingTx = (published: Offer, sats = DEPOSIT_SATS): string => {
  const tx = new Transaction({ allowUnknownOutputs: true, disableScriptCheck: true })
  tx.addOutput({ script: published.swapPkScript, amount: BigInt(sats) })
  const packet: ExtensionPacket = new UnknownPacket(OFFER_PACKET_TYPE, encodeOffer(published))
  const out = Extension.create([packet]).txOut()
  tx.addOutput({ script: out.script, amount: out.amount })
  return base64.encode(tx.toPSBT())
}

const txidOf = (raw: string): string => Transaction.fromPSBT(base64.decode(raw)).id

/** Nothing is reached on it: `fulfill` is injected in every case here. */
const ctx = {} as unknown as ArkadeContext

/** The row `consider()` would have written for `published`. */
const intentFor = (published: Offer, raw: string, over: Partial<OfferFillIntent> = {}): OfferFillIntent => ({
  offerTxid: txidOf(raw),
  offerVout: 0,
  offerPkScript: hex.encode(published.swapPkScript),
  wantAssetId: published.wantAsset?.toString() ?? null,
  wantAmount: published.wantAmount,
  offerAssetId: published.offerAsset?.toString() ?? null,
  offerAmount: 900n,
  ...over,
})

const build = (raw: string | null, over: Partial<Parameters<typeof offerSettleFor>[0]> = {}) => {
  const fulfill = vi.fn(async () => 'f'.repeat(64))
  const settle = offerSettleFor({
    ctx,
    emulatorUrl: 'http://emulator.test',
    fetchTx: async () => raw,
    fulfill,
    ...over,
  })
  return { settle, fulfill }
}

describe('offerSettleFor — the fill it submits', () => {
  it('recovers the offer from its funding transaction and fills it', async () => {
    const published = offer()
    const raw = fundingTx(published)
    const { settle, fulfill } = build(raw)

    expect(await settle(intentFor(published, raw))).toBe('f'.repeat(64))
    expect(fulfill).toHaveBeenCalledTimes(1)
    const [, emulatorUrl, filled, deposit] = fulfill.mock.calls[0]! as unknown as [
      unknown,
      string,
      Offer,
      { txid: string; vout: number; value: number; assetAmount?: bigint },
    ]
    expect(emulatorUrl).toBe('http://emulator.test')
    // The offer handed to the spend is the one decoded from the chain, never a
    // reconstruction from the row's columns.
    expect(hex.encode(filled.swapPkScript)).toBe(SWAP_SCRIPT_HEX)
    expect(filled.makerPkScript).toEqual(MAKER_SCRIPT)
    expect(deposit).toEqual({ txid: txidOf(raw), vout: 0, value: DEPOSIT_SATS, assetAmount: 900n })
  })

  it('carries no asset amount when the deposit is sats', async () => {
    // `assetAmount` is what vin 0 is DECLARED to hold. A BTC deposit holds no
    // asset, and declaring one would describe an input that does not exist.
    const published = offer({ offerAsset: undefined, wantAsset: asset.AssetId.fromString(USD) })
    const raw = fundingTx(published)
    const { settle, fulfill } = build(raw)

    await settle(intentFor(published, raw, { offerAmount: BigInt(DEPOSIT_SATS) }))
    const deposit = (fulfill.mock.calls[0]! as unknown as unknown[])[3] as Record<string, unknown>
    expect(deposit.assetAmount).toBeUndefined()
  })
})

describe('offerSettleFor — it refuses before it spends', () => {
  const published = offer()
  const raw = fundingTx(published)

  it('when the funding transaction cannot be fetched', async () => {
    const { settle, fulfill } = build(null)
    await expect(settle(intentFor(published, raw))).rejects.toThrow(/no funding transaction/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('when the funding transaction carries no offer any more', async () => {
    const bare = new Transaction({ allowUnknownOutputs: true, disableScriptCheck: true })
    bare.addOutput({ script: SWAP_SCRIPT, amount: BigInt(DEPOSIT_SATS) })
    const { settle, fulfill } = build(base64.encode(bare.toPSBT()))
    await expect(settle(intentFor(published, raw))).rejects.toThrow(/carries no offer/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('when the fetch answered with a DIFFERENT transaction', async () => {
    // The row names one funding transaction. A source that answers with another
    // would have us spend an outpoint nothing decided about.
    const other = fundingTx(offer({ wantAmount: 4_000n }))
    const { settle, fulfill } = build(other)
    await expect(settle(intentFor(published, raw))).rejects.toThrow(/is not the funding transaction/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('when the deposit is not at the vout the intent recorded', async () => {
    const { settle, fulfill } = build(raw)
    await expect(settle(intentFor(published, raw, { offerVout: 1 }))).rejects.toThrow(/vout/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('when the offer script is not the one the intent was recorded against', async () => {
    const { settle, fulfill } = build(raw)
    const wrong = intentFor(published, raw, { offerPkScript: '51' + '20' + 'ee'.repeat(32) })
    await expect(settle(wrong)).rejects.toThrow(/script/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('when the maker now asks for MORE than the intent priced', async () => {
    // The one that costs money rather than a retry: `fulfillOffer` pays
    // `offer.wantAmount` out of our own coins, so a want the row never priced is
    // an overpayment nothing approved.
    const { settle, fulfill } = build(raw)
    await expect(settle(intentFor(published, raw, { wantAmount: 900n }))).rejects.toThrow(/wants 1000/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('when the maker now asks to be paid in a DIFFERENT asset', async () => {
    const wanted = offer({ offerAsset: undefined, wantAsset: asset.AssetId.fromString(USD) })
    const wantedRaw = fundingTx(wanted)
    const { settle, fulfill } = build(wantedRaw)
    const wrong = intentFor(wanted, wantedRaw, { wantAssetId: EUR, offerAmount: BigInt(DEPOSIT_SATS) })
    await expect(settle(wrong)).rejects.toThrow(/want asset/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('when the deposit is now in a different asset than the intent recorded', async () => {
    const { settle, fulfill } = build(raw)
    await expect(settle(intentFor(published, raw, { offerAssetId: EUR }))).rejects.toThrow(/deposit asset/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('when a SATS deposit holds less than the intent was priced against', async () => {
    // `offerDepositFrom` sums every live output at the offer's script, and
    // identical offers derive an identical address — so a row can be priced
    // against more sats than the single outpoint it names actually holds. The
    // fill would still pay `wantAmount` in full, for a deposit worth less than
    // the decision believed.
    const sats = offer({ offerAsset: undefined, wantAsset: asset.AssetId.fromString(USD) })
    const satsRaw = fundingTx(sats)
    const { settle, fulfill } = build(satsRaw)
    const overpriced = intentFor(sats, satsRaw, { offerAmount: BigInt(DEPOSIT_SATS) + 1n })
    await expect(settle(overpriced)).rejects.toThrow(/holds 5000 sats/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('accepts a sats deposit that grew after the decision', async () => {
    // The safe direction: more at the outpoint than was priced costs us nothing.
    const sats = offer({ offerAsset: undefined, wantAsset: asset.AssetId.fromString(USD) })
    const satsRaw = fundingTx(sats)
    const { settle, fulfill } = build(satsRaw)
    await settle(intentFor(sats, satsRaw, { offerAmount: BigInt(DEPOSIT_SATS) - 1n }))
    expect(fulfill).toHaveBeenCalledTimes(1)
  })
})
