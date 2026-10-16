import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PricingDraft } from '../../packages/solver-app/src/admin/static/pricingDraft.js'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')
const definitions = source.slice(source.indexOf('const blankMarket'), source.indexOf('const tip'))
const view = source.slice(source.indexOf('/* ---- unified pricing'), source.indexOf('const auditView'))
type Element = { spec: string; props: Record<string, (event: unknown) => void>; children: Element[] }
const h = (spec: string, ...args: unknown[]): Element => ({
  spec,
  props: typeof args[0] === 'object' && !Array.isArray(args[0]) ? (args[0] as Element['props']) : {},
  children: args.filter((arg): arg is Element => !!arg && typeof arg === 'object' && 'spec' in arg),
})
const asset = (hex: string) => hex.repeat(34)
const saved = (hex: string, symbol: string) => ({
  marketKey: `arkade:${asset(hex)}/arkade:btc`,
  base: null,
  quote: asset(hex),
  symbol,
  baseDecimals: 8,
  quoteDecimals: 6,
  feedUrl: 'https://feed.test/price',
  pricePath: '/price',
  toleranceBps: 10,
  feeBps: 50,
  sellBaseFeeFlat: '0',
  buyBaseFeeFlat: '0',
  enabled: true,
  servesOffer: false,
  servesRfq: true,
  rfqSellBase: true,
  rfqBuyBase: true,
  carrierMode: 'inherit',
})

const harness = (answer = { revision: 'r', applied: [] as string[], unapplied: [] }) => {
  const markets = [saved('aa', 'A'), saved('bb', 'B')]
  const knob = { key: 'ASSET_CARRIER_PRICING', value: false, envValue: false, editable: true }
  const sent: unknown[] = []
  const built = new Function(
    'PricingDraft',
    'state',
    'h',
    'api',
    'render',
    'load',
    'tip',
    `
    let marketDraft = null, carrierDefaultDraft = false, previewData = null, previewError = null, previewRequest = 0
    let previewSide = 'from', previewDirection = 'sell_base'
    const readDraftFeed = () => false
    const schedulePreview = () => syncPricingMarket()
    ${definitions}
    ${view}
    return { selectPricing, syncPricingMarket, pricingKnobField, pricingPreviewRequest, applyPricingDraft, pricingDraft,
      stagePricingOverride, removeKnobs: () => state.data.settings.knobs = [],
      setOutcome: value => pricingOutcome = value, outcome: () => pricingOutcome,
      current: () => marketDraft }
  `,
  )(
    PricingDraft,
    { view: 'pricing', data: { markets: { markets }, settings: { knobs: [knob] } } },
    h,
    async (path: string, options: { body: string }) => {
      sent.push({ path, body: JSON.parse(options.body) })
      return answer
    },
    () => {},
    async () => {},
    (text: string) => text,
  ) as {
    selectPricing: (selection: unknown, draft?: unknown) => void
    syncPricingMarket: () => void
    pricingKnobField: (knob: unknown, label: string, explanation: string) => Element[]
    pricingPreviewRequest: () => { market: { feeBps: number }; overrides: Record<string, string> }
    applyPricingDraft: () => Promise<void>
    pricingDraft: PricingDraft
    current: () => Record<string, unknown>
    stagePricingOverride: (key: string, value: string | null) => void
    removeKnobs: () => void
    setOutcome: (value: unknown) => void
    outcome: () => unknown
  }
  const carrierInput = () => built.pricingKnobField(knob, 'carrier', '')[1]!.children[0]!
  return { ...built, markets, sent, carrierInput }
}

describe('the unified pricing editor', () => {
  it('ignores a stale control whose knob is no longer advertised', () => {
    const ui = harness()
    ui.removeKnobs()
    ui.stagePricingOverride('ASSET_CARRIER_PRICING', 'true')
    expect(ui.pricingDraft.size).toBe(0)
  })

  it('clears the previous outcome while a follow-on apply is in flight', async () => {
    const ui = harness()
    ui.setOutcome({ message: 'previous apply succeeded' })
    ui.pricingDraft.stageOverride('ASSET_CARRIER_PRICING', 'true')
    const applying = ui.applyPricingDraft()
    expect(ui.outcome()).toBeNull()
    await applying
  })
  it('keeps unrelated corridor drafts out of market previews but includes them in corridor previews', () => {
    const ui = harness()
    ui.pricingDraft.stageOverride('LN_SEND_MIN_SATS', '200000')
    ui.pricingDraft.stageOverride('LN_SEND_MAX_SATS', '100000')
    ui.selectPricing({ kind: 'market', key: ui.markets[0]!.marketKey })
    expect(ui.pricingPreviewRequest().overrides).toEqual({ ASSET_CARRIER_PRICING: 'false' })
    ui.selectPricing({ kind: 'corridor', key: 'arkade:BTC->lightning:BTC' })
    expect(ui.pricingPreviewRequest().overrides).toEqual({
      ASSET_CARRIER_PRICING: 'false',
      LN_SEND_MIN_SATS: '200000',
      LN_SEND_MAX_SATS: '100000',
    })
  })

  it('keeps both market edits across selection changes and applies them with the carrier default', async () => {
    const keys = [saved('aa', 'A').marketKey, saved('bb', 'B').marketKey]
    const ui = harness({ revision: 'r', applied: [...keys, 'ASSET_CARRIER_PRICING'], unapplied: [] })
    ui.selectPricing({ kind: 'market', key: keys[0] })
    ui.current().feeBps = '60'
    ui.selectPricing({ kind: 'market', key: keys[1] })
    ui.current().feeBps = '35'
    ui.carrierInput().props.onchange!({ target: { checked: true } })
    ui.selectPricing({ kind: 'market', key: keys[0] })
    expect(ui.current().feeBps).toBe('60')
    expect(ui.pricingPreviewRequest()).toMatchObject({
      market: { feeBps: 60 },
      overrides: { ASSET_CARRIER_PRICING: 'true' },
    })
    expect(ui.sent).toEqual([])
    await ui.applyPricingDraft()
    expect(ui.sent).toHaveLength(1)
    expect(ui.sent[0]).toMatchObject({
      path: '/api/pricing/apply',
      body: {
        markets: [
          { symbol: 'A', feeBps: 60 },
          { symbol: 'B', feeBps: 35 },
        ],
        overrides: { ASSET_CARRIER_PRICING: 'true' },
      },
    })
    expect(ui.pricingDraft.size).toBe(0)
  })

  it('reverting the carrier toggle cancels its queued change while a market is open', () => {
    const ui = harness()
    ui.selectPricing({ kind: 'market', key: ui.markets[0]!.marketKey })
    ui.carrierInput().props.onchange!({ target: { checked: true } })
    expect(ui.pricingDraft.payload().overrides).toEqual({ ASSET_CARRIER_PRICING: 'true' })
    ui.carrierInput().props.onchange!({ target: { checked: false } })
    expect(ui.pricingDraft.size).toBe(0)
    expect(ui.pricingPreviewRequest().overrides).toEqual({ ASSET_CARRIER_PRICING: 'false' })
  })

  it('reverting a new market to its blank form removes its previous staged identity', () => {
    const ui = harness()
    ui.selectPricing({ kind: 'market', key: null })
    ui.current().quote = asset('cc')
    ui.syncPricingMarket()
    expect(ui.pricingDraft.size).toBe(1)
    ui.current().quote = ''
    ui.syncPricingMarket()
    expect(ui.pricingDraft.size).toBe(0)
  })
})
