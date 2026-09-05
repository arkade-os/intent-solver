/**
 * Coin selection for an asset payout.
 *
 * Two units have to come out right at once, and each fails differently: too
 * little asset is a payout the solver cannot make, too few sats is a spend the
 * SDK refuses to build. Both are cheap to refuse here and expensive to discover
 * once a client is waiting on a quote already given.
 */

import { describe, it, expect } from 'vitest'
import { selectAssetFunding, type AssetFundingCandidate } from '@arkade-os/solver-corridors/receive/assetFunding.js'

const ASSET = 'ab'.repeat(32) + '0100'
const OTHER = 'cd'.repeat(32) + '0100'
const NOW = 1_800_000_000
const HORIZON = 3_600

const coin = (over: Partial<AssetFundingCandidate> & { units?: bigint | string } = {}): AssetFundingCandidate => {
  const { units, ...rest } = over
  return {
    txid: 'a'.repeat(64),
    vout: 0,
    value: 10_000,
    expiresAt: new Date((NOW + HORIZON * 2) * 1000),
    assets: units === undefined ? [] : [{ assetId: ASSET, amount: units }],
    ...rest,
  }
}

const select = (candidates: AssetFundingCandidate[], over: Partial<Parameters<typeof selectAssetFunding>[0]> = {}) =>
  selectAssetFunding({
    candidates,
    assetId: ASSET,
    units: 500n,
    carrierSats: 330,
    horizonSeconds: HORIZON,
    nowSeconds: NOW,
    reserved: new Set<string>(),
    dustSats: 330,
    ...over,
  })

describe('selectAssetFunding', () => {
  it('takes a coin carrying enough of the asset', () => {
    const result = select([coin({ units: 500n })])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inputs).toHaveLength(1)
    expect(result.units).toBe(500n)
    expect(result.clearedHorizon).toBe(true)
  })

  it('reads the SDK wire form, where an amount is a decimal string', () => {
    expect(select([coin({ units: '500' })]).ok).toBe(true)
  })

  it('treats a malformed amount as nothing held rather than guessing', () => {
    expect(select([coin({ units: '5e2' })])).toMatchObject({ ok: false })
  })

  it('ignores a coin carrying only another asset', () => {
    const wrong = coin()
    wrong.assets = [{ assetId: OTHER, amount: '10000' }]
    expect(select([wrong])).toMatchObject({ ok: false, reason: expect.stringContaining('no unreserved coin') })
  })

  it('never spends a reserved coin, which a renewal settle may be taking', () => {
    expect(select([coin({ units: 500n })], { reserved: new Set(['a'.repeat(64) + ':0']) })).toMatchObject({
      ok: false,
    })
  })

  it('accumulates across coins when no single one covers the payout', () => {
    const result = select([coin({ txid: 'b'.repeat(64), units: 300n }), coin({ txid: 'c'.repeat(64), units: 400n })])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inputs).toHaveLength(2)
    expect(result.units).toBe(700n)
  })

  it('refuses when the float is short, naming both numbers', () => {
    expect(select([coin({ units: 100n })])).toMatchObject({
      ok: false,
      reason: expect.stringContaining('holds 100 of asset'),
    })
  })

  it('refuses when the sats cannot carry the payout', () => {
    // The asset is there; the coin cannot pay for the output that would carry it.
    expect(select([coin({ units: 500n, value: 100 })])).toMatchObject({
      ok: false,
      reason: expect.stringContaining('short of the 330 needed'),
    })
  })

  it('demands dust for the asset change when the payout does not consume the holding', () => {
    // 600 held against 500 quoted leaves 100 riding a change output, and that
    // output must itself clear dust or the spend cannot be built.
    expect(select([coin({ units: 600n, value: 400 })])).toMatchObject({
      ok: false,
      reason: expect.stringContaining('plus 330 for asset change'),
    })
    expect(select([coin({ units: 600n, value: 660 })]).ok).toBe(true)
  })

  it('does not demand change dust when the payout takes the whole holding', () => {
    expect(select([coin({ units: 500n, value: 330 })]).ok).toBe(true)
  })

  it('prefers a coin that outlives the swap, and says so when none does', () => {
    // The expiring coin holds MORE, so a selection ranking only by holding
    // would take it. That is what makes this pin the horizon rather than the
    // sort's incidental order — with equal holdings both rankings coincide.
    const expiring = coin({ txid: 'd'.repeat(64), units: 5000n, expiresAt: new Date((NOW + 60) * 1000) })
    const lasting = coin({ txid: 'e'.repeat(64), units: 500n })
    const result = select([expiring, lasting])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inputs[0]!.txid).toBe('e'.repeat(64))
    expect(result.clearedHorizon).toBe(true)

    const onlyExpiring = select([expiring])
    expect(onlyExpiring.ok).toBe(true)
    if (!onlyExpiring.ok) return
    // Spendable, but the caller is told the lockup inherits a batch that may
    // lapse before the swap resolves.
    expect(onlyExpiring.clearedHorizon).toBe(false)
  })

  it('never counts a height-typed coin as clearing the horizon', () => {
    const byHeight = coin({ txid: 'f'.repeat(64), units: 500n, expiresAt: undefined, expiresAtHeight: 900_000 })
    const result = select([byHeight])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.clearedHorizon).toBe(false)
  })

  it('refuses a non-positive payout rather than building an empty spend', () => {
    expect(select([coin({ units: 500n })], { units: 0n })).toMatchObject({ ok: false })
  })
})
