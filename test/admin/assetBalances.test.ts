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

const { assetHoldings, walletAssetsPanel } = new Function(
  'h',
  'legNode',
  'legName',
  `${block}; return { assetHoldings, walletAssetsPanel }`,
)(
  h,
  (leg: string) => h('legNode', leg),
  (leg: string) => h('legName', leg),
) as {
  assetHoldings: (b: unknown, m: unknown) => { assetId: string; available: string; markets: { key: string }[] }[]
  walletAssetsPanel: (b: unknown, m: unknown) => Node | null
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
    expect(wallet).toContain('walletAssetsPanel(w.arkade.balance, state.overview?.markets)')
  })

  it('repaints the wallet when the markets it names land after its balance', () => {
    const paint = source.slice(source.indexOf('const paintStatus'), source.indexOf('const render ='))
    expect(paint).toContain("state.view === 'wallet'")
  })
})
