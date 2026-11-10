import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')

const slice = (start: string, end: string) => {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error(`missing source slice ${start}`)
  return source.slice(from, to)
}

const h = (spec: string, ...rest: any[]) => {
  const [tag, ...classes] = String(spec).split('.')
  const first = rest[0]
  const attrs =
    first && typeof first === 'object' && !Array.isArray(first) && !Object.hasOwn(first, 'tag') ? rest.slice(1) : rest
  return {
    tag,
    classes,
    children: attrs.flat(Infinity).filter((child: any) => child !== null && child !== undefined),
  }
}

const text = (node: any): string =>
  typeof node === 'object' && node !== null ? node.children.map(text).join('') : String(node)

const find = (node: any, tag: string): any[] => {
  if (typeof node !== 'object' || node === null) return []
  return [...(node.tag === tag ? [node] : []), ...node.children.flatMap((child: any) => find(child, tag))]
}

const reconAtomic = new Function(`${slice('const reconAtomic =', 'const reconDelta =')} return reconAtomic`)()

const nativePnl = new Function(
  'h',
  'legNode',
  'reconAtomic',
  `${slice('const nativeAmount =', 'const pnlFigures =')} return { nativePnlBreakdown, nativePnlPanel }`,
)(h, (assetId: string) => h('span', assetId), reconAtomic)

describe('the native asset P&L view', () => {
  it('shows flat fees and spread separately without converting them to BTC', () => {
    expect(source).toContain("'native P&L by asset'")
    expect(source).toContain("'input flat fee'")
    expect(source).toContain("'output spread'")
    expect(source).toContain('with no BTC conversion')
    expect(source).toContain('hasScale ? decimals : 0, 36')
    expect(source).toContain('atomic units; decimals unknown')
    expect(source).toContain('nativePnlBreakdown(record.nativePnl)')
    expect(source).toContain('nativePnlPanel(data.summary.nativePnl)')
  })

  it('renders native totals and the per-swap split in their own units', () => {
    const panel = nativePnl.nativePnlPanel({
      recordCount: 1,
      assets: [
        { assetId: 'usdt', decimals: 6, inputFlatFee: '30000000', outputSpread: '0', total: '30000000' },
        { assetId: 'eurt', decimals: 6, inputFlatFee: '0', outputSpread: '5000000', total: '5000000' },
      ],
    })
    const rows = find(panel, 'tr').map(text)
    expect(rows).toContain('usdt+30 usdt0 usdt+30 usdt')
    expect(rows).toContain('eurt0 eurt+5 eurt+5 eurt')

    const breakdown = nativePnl.nativePnlBreakdown([
      { assetId: 'usdt', amount: '30000000', decimals: 6, source: 'input_flat_fee' },
      { assetId: 'eurt', amount: '5000000', decimals: 6, source: 'output_spread' },
    ])
    expect(text(breakdown)).toBe(
      'native fee revenue before execution fees: input flat fee +30 usdt / output spread +5 eurt',
    )
  })
})
