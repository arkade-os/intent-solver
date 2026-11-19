import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')
const block = source.slice(source.indexOf('/* ---- assets (block owned'), source.indexOf('/* ---- end assets block'))
const wallet = source.slice(source.indexOf('const walletView'), source.indexOf('/* fund sources: the one call'))

type Node = { spec: string; args: unknown[] }
const h = (spec: string, ...args: unknown[]): Node => ({ spec, args })
const nodes = (node: unknown): Node[] =>
  Array.isArray(node)
    ? node.flatMap(nodes)
    : node && typeof node === 'object' && 'spec' in node
      ? [node as Node, ...(node as Node).args.flatMap(nodes)]
      : []
const texts = (node: unknown): string[] =>
  Array.isArray(node)
    ? node.flatMap(texts)
    : node && typeof node === 'object' && 'spec' in node
      ? (node as Node).args.flatMap(texts)
      : typeof node === 'string'
        ? [node]
        : []

const A = 'aa'.repeat(34)
const B = 'bb'.repeat(34)
const C = 'cc'.repeat(34)
const D = 'dd'.repeat(34)
const asset = (assetId: string, amount: string, extra = {}) => ({
  assetId,
  amount,
  shortId: assetId.slice(0, 8),
  ...extra,
})
const market = (quote: string, enabled = true) => ({ key: `BTC/${quote}`, base: 'BTC', quote, enabled })
const balance = {
  assets: [asset(D, '42'), asset(A, '1500', { ticker: 'AAA', decimals: 2 }), asset(C, '7')],
  availableAssets: [asset(D, '42'), asset(A, '1250'), asset(C, '7')],
}
const markets = [market(A), market(B), market(C, false)]

const { assetHoldings, walletAssetsPanel, walletAssets } = new Function(
  'h',
  'legNode',
  'legName',
  'state',
  `${block}; return { assetHoldings, walletAssetsPanel, walletAssets }`,
)(
  h,
  (leg: string) => h('legNode', leg),
  (leg: string) => h('legName', leg),
  { overview: { markets } },
) as {
  assetHoldings: (b: unknown, m: unknown) => { assetId: string; available: string; markets: { key: string }[] }[]
  walletAssetsPanel: (b: unknown, m: unknown) => Node | null
  walletAssets: (w: unknown) => Node
}

const rowOf = (panel: Node | null, assetId: string): Node =>
  nodes(panel).find((n) => n.spec === 'tr' && nodes(n.args).some((c) => c.args.includes(assetId)))!

describe('the wallet shows its assets without opening anything', () => {
  it('lists what an enabled market trades first, held or not, then what is held and traded by none', () => {
    const rows = assetHoldings(balance, markets)
    expect(rows.map((row) => row.assetId)).toEqual([A, B, D, C])
    expect(rows.map((row) => row.markets.map((m) => m.key))).toEqual([[`BTC/${A}`], [`BTC/${B}`], [], []])
  })

  it('shows a traded asset the solver holds none of as a plain zero, never in a risk colour', () => {
    const row = rowOf(walletAssetsPanel(balance, markets), B)
    expect(texts(row)).toEqual(expect.arrayContaining(['0', ' none held', B]))
    expect(nodes(row).filter((n) => /phase|risk|banner|danger/.test(n.spec))).toEqual([])
  })

  it('keeps spendable and held apart when they differ, in base units with decimals as a label', () => {
    const panel = walletAssetsPanel(balance, markets)
    expect(texts(rowOf(panel, A))).toEqual(expect.arrayContaining(['1250', ' of 1500 held', ' (2dp)']))
    expect(texts(nodes(panel).find((n) => n.spec === 'tr' && texts(n).includes('42')))).not.toContain(' of 42 held')
  })

  it('draws no panel for a solver with no asset and no asset market', () => {
    expect(walletAssetsPanel({ assets: [], availableAssets: [] }, [market('BTC')])).toBeNull()
    expect(walletAssetsPanel(null, [])).toBeNull()
  })

  it('keeps the address and the BTC breakdown in Details, and the assets out of it', () => {
    const details = wallet.slice(
      wallet.indexOf("'details.wallet-balance-more'"),
      wallet.indexOf("h('h2', 'Lightning')"),
    )
    expect(details).toContain("h('dt', 'Address')")
    expect(details).toContain("h('dt', 'Balance details')")
    expect(details).not.toMatch(/asset/i)
    expect(wallet).toContain('walletAssets(w)')
  })

  it('leaves a hidden slot when there is nothing to list, so the panel can arrive in place', () => {
    expect(walletAssets({ arkade: { balance } }).spec).toBe('section.panel.wallet-assets')
    expect(walletAssets({ arkade: { balance: { assets: [] } } }).spec).toBe('section.panel.wallet-assets')
    expect(walletAssets({ arkade: { balanceError: 'down', balance: null } }).spec).toBe('div.wallet-assets-slot')
  })

  it('fills that slot in place when the markets land after the balance, without re-rendering the page', () => {
    const paint = source.slice(source.indexOf('const paintStatus'), source.indexOf('const render ='))
    expect(paint).toContain("if (state.view === 'overview') return render()")
    expect(paint).toContain('morph(assets, walletAssets(state.data.wallet))')
  })
})

const card = source.slice(source.indexOf('const marketBounds'), source.indexOf('const marketsPanel'))
const figure = source.slice(
  source.indexOf('const overviewBalancesPanel'),
  source.indexOf('const paintOverviewBalances'),
)
const overviewWith = (data: Record<string, unknown>, balances: unknown = null) =>
  new Function(
    'h',
    'legNode',
    'legName',
    'sats',
    'state',
    `${block}; ${card}; ${figure}; return { marketCard, overviewBalancesPanel }`,
  )(
    h,
    (leg: string) => h('legNode', leg),
    (leg: string) => h('legName', leg),
    String,
    { data, overview: { balances } },
  ) as { marketCard: (m: unknown) => Node; overviewBalancesPanel: () => Node }
const cardMarket = (quote: string) => ({
  ...market(quote),
  active: true,
  serving: ['rfq'],
  gaps: [],
  sellBase: null,
  buyBase: null,
  feeBps: 40,
  toleranceBps: 150,
  sellBaseFeeFlat: '0',
  buyBaseFeeFlat: '0',
})
const spendable = (cardNode: Node): Node => {
  const kv = nodes(cardNode).find((n) => n.spec === 'dl.kv')!
  return kv.args[kv.args.findIndex((n) => texts(n).join('') === 'spendable') + 1] as Node
}

describe('each market card says what the solver can pay out of it', () => {
  it("shows the spendable balance of the market's asset leg, and what is held when that differs", () => {
    const { marketCard } = overviewWith({ overviewBalances: { arkade: balance } })
    expect(texts(spendable(marketCard(cardMarket(A))))).toEqual(
      expect.arrayContaining([A, '1250', ' of 1500 held', ' (2dp)']),
    )
  })

  it('shows a market whose asset the solver holds none of as a plain zero, never in a risk colour', () => {
    const row = spendable(overviewWith({ overviewBalances: { arkade: balance } }).marketCard(cardMarket(B)))
    expect(texts(row)).toEqual([B, ' ', '0', ' none held'])
    expect(nodes(row).filter((n) => /phase|risk|banner|danger/.test(n.spec))).toEqual([])
  })

  it('waits for the balance read rather than showing a zero, and says when it failed', () => {
    expect(texts(spendable(overviewWith({}).marketCard(cardMarket(A))))).toEqual(['…'])
    expect(texts(spendable(overviewWith({ overviewBalanceError: 'down' }).marketCard(cardMarket(A))))).toEqual([
      'unavailable',
    ])
    const failed = overviewWith({ overviewBalances: { arkade: null, arkadeError: 'down' } })
    expect(texts(spendable(failed.marketCard(cardMarket(A))))).toEqual(['unavailable'])
  })

  it('counts the assets held beside the overview balance figure, wrapping before the count, never inside it', () => {
    const count = nodes(overviewWith({ overviewBalances: { arkade: balance } }).overviewBalancesPanel()).find(
      (n) => n.spec === 'span.asset-count',
    )
    expect(count?.args).toEqual(['· 3 assets'])
    const css = readFileSync(new URL('../../packages/solver-app/src/admin/static/styles.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.asset-count \{\s*white-space: nowrap;/)
    expect(
      texts(overviewWith({ overviewBalances: { arkade: { available: 1 } } }).overviewBalancesPanel()).join(''),
    ).not.toMatch(/asset/)
  })

  it('repaints the cards in place when the balance read lands', () => {
    const paint = source.slice(source.indexOf('const paintOverviewBalances'), source.indexOf('const overviewView'))
    const panel = source.slice(source.indexOf('const marketsPanel'), source.indexOf('/** The two balances a swap'))
    expect(panel).toContain("id: 'overview-markets'")
    expect(paint).toContain("getElementById('overview-markets')")
  })
})
