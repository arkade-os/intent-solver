import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PricingDraft } from '../../packages/solver-app/src/admin/static/pricingDraft.js'
import * as simpleMarket from '../../packages/solver-app/src/admin/static/simpleMarket.js'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')
const definitions = source.slice(source.indexOf('const blankMarket'), source.indexOf('const tip'))
const view = source.slice(source.indexOf('/* ---- unified pricing'), source.indexOf('const auditView'))
type Element = { spec: string; props: Record<string, (event: unknown) => void>; children: Element[]; text: string }
const h = (spec: string, ...args: unknown[]): Element => ({
  spec,
  props: typeof args[0] === 'object' && !Array.isArray(args[0]) ? (args[0] as Element['props']) : {},
  children: args.flat().filter((arg): arg is Element => !!arg && typeof arg === 'object' && 'spec' in arg),
  text: args.filter((arg) => typeof arg === 'string').join(''),
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
  sellBase: { min: '1000000', max: '1000000000' },
  buyBase: { min: '10000', max: '1000000' },
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
    ...Object.keys(simpleMarket),
    `
    let marketDraft = null, carrierDefaultDraft = false, previewData = null, previewError = null, previewRequest = 0
    let previewSide = 'from', previewDirection = 'sell_base', previewAmounts = { sell_base: '', buy_base: '' }
    const readDraftFeed = () => false
    const schedulePreview = () => syncPricingMarket()
    const legNode = (leg) => h('span', String(leg))
    ${definitions}
    ${view}
    return { selectPricing, syncPricingMarket, pricingKnobField, pricingPreviewRequest, applyPricingDraft, pricingDraft,
      stagePricingOverride, removeKnobs: () => state.data.settings.knobs = [],
      setOutcome: value => pricingOutcome = value, outcome: () => pricingOutcome,
      current: () => marketDraft, selection: () => pricingSelection, adoptSavedPair, blankMarket, marketBody,
      table: () => pricingTable(pricingOverrides(), pricingRows()),
      ask: (direction, text) => ((previewDirection = direction), (previewAmounts[direction] = text)) }
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
    ...Object.values(simpleMarket),
  ) as {
    selectPricing: (selection: unknown, draft?: unknown) => void
    syncPricingMarket: () => void
    pricingKnobField: (knob: unknown, label: string, explanation: string) => Element[]
    pricingPreviewRequest: () => Record<string, unknown> & {
      market: { feeBps: number }
      overrides: Record<string, string>
    }
    applyPricingDraft: () => Promise<void>
    pricingDraft: PricingDraft
    current: () => Record<string, unknown>
    selection: () => Record<string, unknown>
    adoptSavedPair: () => boolean
    blankMarket: () => Record<string, unknown>
    marketBody: (draft: Record<string, unknown>) => Record<string, unknown>
    table: () => Element
    ask: (direction: 'sell_base' | 'buy_base', text: string) => void
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

  it('refuses to apply a market that opens a direction without both limits', async () => {
    const ui = harness()
    const { marketKey, ...body } = saved('cc', 'C')
    ui.pricingDraft.stageMarket(marketKey, { ...body, sellBase: null })
    await ui.applyPricingDraft()
    expect(ui.sent).toEqual([])
    expect(ui.outcome()).toMatchObject({ failed: true, message: expect.stringContaining('BTC → C') })
    expect(ui.pricingDraft.size).toBe(1)
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

describe('adding a market for a pair that is already stored', () => {
  it('opens the stored row instead of laying the blank form over it', () => {
    const ui = harness()
    ui.selectPricing({ kind: 'market', key: null }, ui.blankMarket())
    ui.current().quote = asset('aa').slice(0, 10)
    ui.syncPricingMarket()
    expect(ui.pricingDraft.size).toBe(1)
    ui.current().quote = asset('aa')
    expect(ui.adoptSavedPair()).toBe(true)
    expect(ui.selection()).toMatchObject({ kind: 'market', key: ui.markets[0]!.marketKey, adopted: 'saved' })
    expect(ui.current()).toMatchObject({ symbol: 'A', feeBps: '50', carrierMode: 'inherit', quoteDecimals: '6' })
    expect(ui.pricingDraft.size).toBe(0)
  })

  it('keeps edits already staged on that row', () => {
    const ui = harness()
    ui.selectPricing({ kind: 'market', key: ui.markets[0]!.marketKey })
    ui.current().feeBps = '60'
    ui.selectPricing({ kind: 'market', key: null }, ui.blankMarket())
    ui.current().quote = asset('aa')
    ui.adoptSavedPair()
    expect(ui.current().feeBps).toBe('60')
    expect(ui.pricingDraft.payload().markets).toMatchObject([{ symbol: 'A', feeBps: 60 }])
  })

  it('leaves a pair nothing stores as a new market', () => {
    const ui = harness()
    ui.selectPricing({ kind: 'market', key: null }, ui.blankMarket())
    ui.current().quote = asset('cc')
    expect(ui.adoptSavedPair()).toBe(false)
    expect(ui.selection().key).toBeNull()
  })

  it('reopens a pair already pending in the draft instead of laying the blank form over it', () => {
    const ui = harness()
    const key = simpleMarket.pairKey('BTC', asset('cc'))
    ui.selectPricing({ kind: 'market', key: null }, ui.blankMarket())
    Object.assign(ui.current(), { quote: asset('cc'), feeBps: '25' })
    ui.selectPricing({ kind: 'market', key: null }, ui.blankMarket())
    ui.current().quote = asset('cc')
    expect(ui.adoptSavedPair()).toBe(true)
    expect(ui.selection()).toMatchObject({ kind: 'market', key, adopted: 'pending' })
    expect(ui.current().feeBps).toBe('25')
    ui.syncPricingMarket()
    expect(ui.pricingDraft.payload().markets).toMatchObject([{ quote: asset('cc'), feeBps: 25 }])
  })

  it('does not adopt its own staged entry when the same id arrives again', () => {
    const ui = harness()
    ui.selectPricing({ kind: 'market', key: null }, ui.blankMarket())
    ui.current().quote = asset('cc')
    ui.syncPricingMarket()
    expect(ui.adoptSavedPair()).toBe(false)
  })
})

describe('the market preview request', () => {
  it('carries the typed amount in atomic units of the leg the client sends, and omits it when blank', () => {
    const ui = harness()
    ui.selectPricing({ kind: 'market', key: ui.markets[0]!.marketKey })
    ui.ask('sell_base', '0.01')
    expect(ui.pricingPreviewRequest()).toMatchObject({ direction: 'sell_base', side: 'from', amount: '1000000' })
    ui.ask('buy_base', '12.5')
    expect(ui.pricingPreviewRequest()).toMatchObject({ direction: 'buy_base', amount: '12500000' })
    for (const text of ['', '1.1234567', 'abc']) {
      ui.ask('buy_base', text)
      expect(ui.pricingPreviewRequest(), text).not.toHaveProperty('amount')
    }
  })

  it('lists a staged market whose fee box was cleared with a dash, not "null bps"', () => {
    const ui = harness()
    ui.selectPricing({ kind: 'market', key: ui.markets[0]!.marketKey })
    ui.current().feeBps = ''
    ui.syncPricingMarket()
    const fees = ui.table().children.map((row) => row.children[1]!.text)
    expect(fees).toContain('—')
    expect(fees.join(' ')).not.toContain('null')
  })

  it('sends blank decimals as null for the server to refuse, never as 0', () => {
    const ui = harness()
    expect(ui.marketBody(ui.blankMarket())).toMatchObject({ baseDecimals: 8, quoteDecimals: null })
    expect(ui.marketBody({ ...ui.blankMarket(), feeBps: ' ', toleranceBps: '1e1' })).toMatchObject({
      feeBps: null,
      toleranceBps: '1e1',
    })
  })
})
