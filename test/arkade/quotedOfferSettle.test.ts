/**
 * The guards on the RFQ route's spend.
 *
 * Every one of them is a way the row and the chain can disagree, and none is
 * reachable through the orchestrator alone — they are tripwires on someone
 * else's deposit, not error handling. A throw leaves the row `stuck`, which is
 * what a disagreement needs.
 *
 * `fulfill` is injected, so what is exercised here is the decision to spend
 * rather than the spend.
 */
import { describe, it, expect, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { offerScriptFrom } from '@arkade-os/solver-arkade/arkade/offerTerms.js'
import { quotedOfferSettleFor, type QuotedOfferIntent } from '@arkade-os/solver-arkade/arkade/quotedOfferSettle.js'
import type { OfferOutpoint } from '@arkade-os/solver-arkade/arkade/offerOutpoints.js'
import type { fulfillOffer } from '@arkade-os/solver-arkade/arkade/offerFulfill.js'

const xonly = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const derivation = { serverPubkey: xonly(2), emulatorPubkey: xonly(4), hrp: 'tark' }
const USDA = '11'.repeat(34)
const MAKER_SCRIPT = '5120' + 'cc'.repeat(32)
const MAKER_KEY = hex.encode(xonly(3))
const TXID = 'a'.repeat(64)

/** A BTC deposit buying the asset — the direction the e2e drives. */
const intent = (over: Partial<QuotedOfferIntent> = {}): QuotedOfferIntent => {
  const base = {
    fromAssetId: null,
    fromAmount: 20_000n,
    toAssetId: USDA,
    toAmount: 19_900n,
    makerPkScript: MAKER_SCRIPT,
    makerPublicKey: MAKER_KEY,
    depositTxid: TXID,
    depositVout: 1,
    ...over,
  }
  const derived = offerScriptFrom(derivation)({
    wantAmount: base.toAmount,
    wantAssetId: base.toAssetId,
    offerAssetId: base.fromAssetId,
    makerPkScript: base.makerPkScript,
    makerPublicKey: base.makerPublicKey,
  })
  return { offerPkScript: derived.pkScript, ...base }
}

const funded = (over: Partial<OfferOutpoint> = {}): OfferOutpoint => ({
  txid: TXID,
  vout: 1,
  sats: 20_000n,
  assets: [],
  ...over,
})

const settleWith = (
  outpoints: OfferOutpoint[],
  // Typed from the real function: an untyped `vi.fn` infers `[]` for its call
  // tuple, so every argument assertion below silently checks nothing.
  fulfill = vi.fn<typeof fulfillOffer>(async () => 'fill'.padEnd(64, '0')),
) => ({
  fulfill,
  settle: quotedOfferSettleFor({
    ctx: {} as never,
    emulatorUrl: 'http://emulator.test',
    derivation,
    outpointsAt: async () => outpoints,
    fulfill,
  }),
})

describe('quotedOfferSettleFor', () => {
  it('spends the outpoint the row recorded, at the value the chain reports', async () => {
    const { settle, fulfill } = settleWith([funded({ vout: 0, sats: 999n }), funded()])
    await settle(intent())
    expect(fulfill).toHaveBeenCalledWith(expect.anything(), 'http://emulator.test', expect.anything(), {
      txid: TXID,
      vout: 1,
      value: 20_000,
      assetAmount: undefined,
    })
  })

  it('hands `fulfill` an offer whose script is the DERIVED one', async () => {
    const { settle, fulfill } = settleWith([funded()])
    const row = intent()
    await settle(row)
    expect(hex.encode(fulfill.mock.calls[0]![2].swapPkScript)).toBe(row.offerPkScript)
  })

  it('returns whatever txid the fill landed as', async () => {
    const { settle } = settleWith(
      [funded()],
      vi.fn(async () => 'c'.repeat(64)),
    )
    expect(await settle(intent())).toBe('c'.repeat(64))
  })

  it('refuses a row that records no deposit outpoint', async () => {
    const { settle, fulfill } = settleWith([funded()])
    await expect(settle(intent({ depositTxid: null }))).rejects.toThrow(/records no deposit outpoint/)
    await expect(settle(intent({ depositVout: null }))).rejects.toThrow(/records no deposit outpoint/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('refuses when the row terms no longer derive its own offer script', async () => {
    // A hand-edited row, or a rotated emulator key. Spending the recorded
    // script would spend a covenant these terms do not open.
    const { settle, fulfill } = settleWith([funded()])
    await expect(settle({ ...intent(), offerPkScript: '5120' + 'ee'.repeat(32) })).rejects.toThrow(
      /derive .*, not the offer script/,
    )
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('refuses when the recorded outpoint is no longer live', async () => {
    const { settle, fulfill } = settleWith([funded({ vout: 4 })])
    await expect(settle(intent())).rejects.toThrow(/is no longer live at/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('never falls back to another outpoint at the same script', async () => {
    // Identical terms compile to one address, so a second deposit can land
    // beside the one the fill decision was made about. Spending it would be
    // paying the quoted payout against money nobody evaluated.
    const { settle, fulfill } = settleWith([funded({ txid: 'b'.repeat(64), sats: 10n ** 6n })])
    await expect(settle(intent())).rejects.toThrow(/is no longer live at/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('refuses an outpoint holding less than the quote was priced against', async () => {
    const { settle, fulfill } = settleWith([funded({ sats: 19_999n })])
    await expect(settle(intent())).rejects.toThrow(/holds 19999 of the deposit leg/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('spends an outpoint holding MORE, which only ever favours the solver', async () => {
    const { settle, fulfill } = settleWith([funded({ sats: 25_000n })])
    await settle(intent())
    expect(fulfill.mock.calls[0]![3].value).toBe(25_000)
  })
})

describe('an asset DEPOSIT, where the packet declares what vin 0 carries', () => {
  const assetIntent = () => intent({ fromAssetId: USDA, fromAmount: 500n, toAssetId: null, toAmount: 20_000n })
  const carrying = (amount: bigint) => funded({ sats: 330n, assets: [{ assetId: USDA, amount }] })

  it('declares what the outpoint holds, not what was quoted', async () => {
    // Under-declaring leaves the surplus unaccounted for on an input the packet
    // must describe completely; `buildAssetPacket` routes the remainder back to
    // this solver.
    const { settle, fulfill } = settleWith([carrying(700n)])
    await settle(assetIntent())
    expect(fulfill.mock.calls[0]![3].assetAmount).toBe(700n)
  })

  it('refuses when the asset leg is short, even with the sats value intact', async () => {
    const { settle, fulfill } = settleWith([carrying(499n)])
    await expect(settle(assetIntent())).rejects.toThrow(/holds 499 of the deposit leg/)
    expect(fulfill).not.toHaveBeenCalled()
  })

  it('reads the asset the row names, not any asset on the outpoint', async () => {
    const other = funded({ sats: 330n, assets: [{ assetId: '22'.repeat(34), amount: 10n ** 9n }] })
    const { settle } = settleWith([other])
    await expect(settle(assetIntent())).rejects.toThrow(/holds 0 of the deposit leg/)
  })
})
