/** Every case below is a change an operator can reach from the market form. */
import { describe, it, expect } from 'vitest'
import { savePassFor, SAVE_FIELDS, type SaveField } from '@arkade-os/solver-core/core/saveOrder.js'
import { carrierSatsFor } from '@arkade-os/solver-app/ops/assetRfqMarkets.js'
import type { CarrierMode } from '@arkade-os/solver-core/core/assetMarketConfig.js'

describe('savePassFor', () => {
  it('puts a lowered ceiling and a raised floor in the narrowing pass', () => {
    expect(savePassFor({ field: 'max', before: 100n, after: 50n })).toBe('narrowing')
    expect(savePassFor({ field: 'min', before: 10n, after: 20n })).toBe('narrowing')
  })

  it('puts a raised ceiling and a lowered floor in the widening pass', () => {
    expect(savePassFor({ field: 'max', before: 50n, after: 100n })).toBe('widening')
    expect(savePassFor({ field: 'min', before: 20n, after: 10n })).toBe('widening')
  })

  it('closes a direction first and opens it last', () => {
    expect(savePassFor({ field: 'rfqSellBase', before: true, after: false })).toBe('narrowing')
    expect(savePassFor({ field: 'rfqSellBase', before: false, after: true })).toBe('widening')
  })

  it('disables first and enables last, on the market and on the corridor', () => {
    expect(savePassFor({ field: 'enabled', before: true, after: false })).toBe('narrowing')
    expect(savePassFor({ field: 'enabled', before: false, after: true })).toBe('widening')
    expect(savePassFor({ field: 'corridorEnabled', before: true, after: false })).toBe('narrowing')
    expect(savePassFor({ field: 'servesOffer', before: false, after: true })).toBe('widening')
    expect(savePassFor({ field: 'servesRfq', before: false, after: true })).toBe('widening')
  })

  it('treats turning carrier pricing ON as narrowing', () => {
    expect(savePassFor({ field: 'carrierPriced', before: false, after: true })).toBe('narrowing')
    expect(savePassFor({ field: 'carrierPriced', before: true, after: false })).toBe('widening')
  })

  it('treats a raised fee as narrowing and a widened tolerance as widening', () => {
    expect(savePassFor({ field: 'feeBps', before: 10, after: 25 })).toBe('narrowing')
    expect(savePassFor({ field: 'toleranceBps', before: 10, after: 25 })).toBe('widening')
    expect(savePassFor({ field: 'toleranceBps', before: 25, after: 10 })).toBe('narrowing')
    expect(savePassFor({ field: 'maxExposedSats', before: 1n, after: 2n })).toBe('widening')
    expect(savePassFor({ field: 'maxExposedSats', before: 2n, after: 1n })).toBe('narrowing')
  })

  it('orders a LOWERED per-direction fee like a lowered feeBps, not unconditionally', () => {
    expect(savePassFor({ field: 'feeBps', before: 900, after: 100 })).toBe('widening')
    expect(savePassFor({ field: 'feeBps', before: 0n, after: 330n })).toBe('narrowing')
  })

  it('lengthens the funding window last and shortens it first', () => {
    expect(savePassFor({ field: 'lockupTimeoutSeconds', before: 3_600, after: 7_200 })).toBe('widening')
    expect(savePassFor({ field: 'lockupTimeoutSeconds', before: 7_200, after: 3_600 })).toBe('narrowing')
  })

  it('calls an unchanged value narrowing, so a no-op never rides the relaxing pass', () => {
    expect(savePassFor({ field: 'max', before: 50n, after: 50n })).toBe('narrowing')
    expect(savePassFor({ field: 'carrierPriced', before: true, after: true })).toBe('narrowing')
  })

  it('treats a bound appearing as narrowing and one disappearing as widening', () => {
    expect(savePassFor({ field: 'max', before: null, after: 50n })).toBe('narrowing')
    expect(savePassFor({ field: 'max', before: 50n, after: null })).toBe('widening')
    expect(savePassFor({ field: 'min', before: null, after: 50n })).toBe('narrowing')
    expect(savePassFor({ field: 'min', before: 50n, after: null })).toBe('widening')
  })

  it('names every field it has an opinion about, so the route cannot pass an unclassified one', () => {
    const fields: SaveField[] = [
      'max',
      'min',
      'feeBps',
      'toleranceBps',
      'maxExposedSats',
      'lockupTimeoutSeconds',
      'enabled',
      'servesOffer',
      'servesRfq',
      'rfqSellBase',
      'rfqBuyBase',
      'corridorEnabled',
      'carrierPriced',
    ]
    expect([...SAVE_FIELDS].sort()).toEqual([...fields].sort())
  })
})

describe('the per-direction bps pair resolves before it is classified', () => {
  // `null` is INHERIT `feeBps`, not absence. Passing it through would take the
  // classifier's appearing/disappearing arms and get both of these backwards.
  const pass = (own: number | null, next: number | null, feeBps: number) =>
    savePassFor({ field: 'feeBps', before: own ?? feeBps, after: next ?? feeBps })

  it('calls clearing an explicit high spread back to inherited a relaxation', () => {
    expect(pass(900, null, 25)).toBe('widening')
  })

  it('calls setting an explicit LOW spread over a high inherited fee a relaxation too', () => {
    expect(pass(null, 0, 900)).toBe('widening')
  })

  it('still calls a rise a restriction, whichever side was inherited', () => {
    expect(pass(null, 900, 25)).toBe('narrowing')
    expect(pass(25, null, 900)).toBe('narrowing')
  })

  it('gets both of those backwards when the null is passed through unresolved', () => {
    expect(savePassFor({ field: 'feeBps', before: null, after: 0 })).toBe('narrowing')
    expect(pass(null, 0, 900)).toBe('widening')
  })
})

describe('carrierPriced resolves against the live default', () => {
  // `'inherit'` is not a value, it is a POINTER at ASSET_CARRIER_PRICING. The
  // classifier cannot see it, so the route resolves before calling.
  const priced = (mode: CarrierMode, pricedByDefault: boolean) =>
    carrierSatsFor(mode, { dustSats: 330n, pricedByDefault }) > 0n

  it('calls priced -> inherit a RELAXATION where the deployment default is off', () => {
    expect(
      savePassFor({ field: 'carrierPriced', before: priced('priced', false), after: priced('inherit', false) }),
    ).toBe('widening')
  })

  it('calls the same edit a no-op where the default is on', () => {
    const before = priced('priced', true)
    const after = priced('inherit', true)
    expect(before).toBe(after)
  })

  it('would call that relaxation NARROWING on the cheap `mode !== off` spelling', () => {
    const cheap = (mode: CarrierMode) => mode !== 'off'
    expect(savePassFor({ field: 'carrierPriced', before: cheap('priced'), after: cheap('inherit') })).toBe('narrowing')
  })
})
