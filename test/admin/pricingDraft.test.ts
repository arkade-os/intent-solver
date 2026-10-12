import { describe, expect, it } from 'vitest'
import { PricingDraft } from '../../packages/solver-app/src/admin/static/pricingDraft.js'

describe('the shared pricing draft', () => {
  it('holds markets and settings until one combined apply', async () => {
    const draft = new PricingDraft()
    const requests: unknown[] = []
    draft.stageMarket('a', { symbol: 'A', feeBps: 50 })
    draft.stageMarket('b', { symbol: 'B', feeBps: 20 })
    draft.stageOverride('LN_SEND_FEE_BPS', '30')
    draft.stageOverride('ASSET_CARRIER_PRICING', 'true')
    expect(draft.size).toBe(4)
    await draft.apply(async (path, options) => {
      requests.push({ path, body: JSON.parse(options!.body!) })
      return { revision: 'r', applied: ['a', 'b', 'LN_SEND_FEE_BPS', 'ASSET_CARRIER_PRICING'], unapplied: [] }
    })
    expect(requests).toEqual([
      {
        path: '/api/pricing/apply',
        body: {
          markets: [
            { symbol: 'A', feeBps: 50 },
            { symbol: 'B', feeBps: 20 },
          ],
          overrides: { LN_SEND_FEE_BPS: '30', ASSET_CARRIER_PRICING: 'true' },
        },
      },
    ])
    expect(draft.size).toBe(0)
  })

  it('keeps refused and unattempted changes after a partial apply', async () => {
    const draft = new PricingDraft()
    draft.stageMarket('a', { symbol: 'A' })
    draft.stageMarket('b', { symbol: 'B' })
    draft.stageOverride('LN_SEND_MAX_SATS', '9000')
    await expect(
      draft.apply(async () => ({
        revision: 'r',
        applied: ['a'],
        unapplied: [{ key: 'b', reason: 'feed unavailable' }],
      })),
    ).rejects.toThrow('feed unavailable')
    expect(draft.payload()).toEqual({ markets: [{ symbol: 'B' }], overrides: { LN_SEND_MAX_SATS: '9000' } })
  })

  it('does not clear unattempted changes when a reload stopped the route early', async () => {
    const draft = new PricingDraft()
    draft.stageOverride('LN_SEND_MAX_SATS', '9000')
    await draft.apply(async () => ({ revision: 'r', applied: [], unapplied: [] }))
    expect(draft.size).toBe(1)
  })

  it('keeps all work when the request fails without an apply report', async () => {
    const draft = new PricingDraft()
    draft.stageMarket('a', { symbol: 'A' })
    await expect(
      draft.apply(async () => {
        throw new Error('connection lost')
      }),
    ).rejects.toThrow('connection lost')
    expect(draft.payload().markets).toEqual([{ symbol: 'A' }])
    expect(draft.busy).toBe(false)
  })

  it('previews saved settings plus draft overrides, with clears reverting to the environment', () => {
    const draft = new PricingDraft()
    draft.stageOverride('LN_SEND_FEE_BPS', null)
    draft.stageOverride('ASSET_CARRIER_PRICING', 'true')
    expect(
      draft.previewOverrides([
        { key: 'LN_SEND_FEE_BPS', value: 50, envValue: 10, editable: true },
        { key: 'LN_SEND_MAX_SATS', value: 5000, envValue: 1000, editable: true },
        { key: 'ASSET_CARRIER_PRICING', value: false, envValue: false, editable: true },
        { key: 'LN_BACKEND', value: 'lnd', editable: false },
      ]),
    ).toEqual({ LN_SEND_FEE_BPS: '10', LN_SEND_MAX_SATS: '5000', ASSET_CARRIER_PRICING: 'true' })
  })

  it('does not write an empty draft or let an apply race with edits', async () => {
    const draft = new PricingDraft()
    await expect(
      draft.apply(async () => {
        throw new Error('must not call')
      }),
    ).resolves.toBeNull()
    draft.stageMarket('a', { symbol: 'A' })
    let finish!: (value: unknown) => void
    const applying = draft.apply(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    expect(draft.busy).toBe(true)
    expect(() => draft.stageOverride('LN_SEND_FEE_BPS', '99')).toThrow('applying')
    expect(() => draft.discard()).toThrow('applying')
    await expect(draft.apply(async () => null)).rejects.toThrow('applying')
    finish({ revision: 'r', applied: ['a'], unapplied: [] })
    await applying
    expect(draft.busy).toBe(false)
  })

  it('snapshots market bodies so later form edits cannot change a queued request', () => {
    const draft = new PricingDraft()
    const body = { symbol: 'A', sellBase: { min: '100', max: '1000' } }
    draft.stageMarket('a', body)
    body.sellBase.max = '9999'
    expect(draft.payload().markets).toEqual([{ symbol: 'A', sellBase: { min: '100', max: '1000' } }])
    draft.discard()
    expect(draft.size).toBe(0)
  })
})
