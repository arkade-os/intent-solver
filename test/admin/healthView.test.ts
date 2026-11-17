import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')
const view = source.slice(source.indexOf('const healthView'), source.indexOf('/** The swap last asked for'))

type Node = { spec: string; args: unknown[] }
const texts = (node: unknown): string[] =>
  Array.isArray(node)
    ? node.flatMap(texts)
    : node && typeof node === 'object' && 'spec' in node
      ? (node as Node).args.flatMap(texts)
      : typeof node === 'string'
        ? [node]
        : []

const render = (btcRail?: boolean) => {
  const figures: unknown[][] = []
  let probed: { name: string }[] = []
  const tree = new Function(
    'state',
    'h',
    'figure',
    'backendsView',
    'discoveryView',
    'ago',
    'duration',
    'corridorLabel',
    'sats',
    `${view}; return healthView()`,
  )(
    {
      data: {
        diagnostics: {
          ...(btcRail === undefined ? {} : { btcRail }),
          backends: ['lightning', 'arkade', 'emulator', 'onchain', 'relay'].map((name) => ({
            name,
            ok: name !== 'lightning' && name !== 'onchain',
          })),
          corridors: [{ corridor: 'arkade:BTC->lightning:BTC', payoutRail: 'lightning', canHonourMax: false }],
          uptimeSeconds: 60,
          mode: 'relay',
        },
      },
    },
    (spec: string, ...args: unknown[]): Node => ({ spec, args }),
    (...args: unknown[]) => (figures.push(args), null),
    (backends: { name: string }[]) => ((probed = backends), null),
    () => null,
    String,
    String,
    String,
    String,
  )
  return { figures, probed: probed.map((backend) => backend.name), text: texts(tree) }
}

describe('the health page', () => {
  it('drops the BTC rail rows and their alarms when the deployment has no BTC rail', () => {
    const page = render(false)
    expect(page.probed).toEqual(['arkade', 'emulator', 'relay'])
    expect(page.figures[0]).toEqual(['backends down', '0', 'of 3', null])
    expect(page.figures.map(([label]) => label)).not.toContain('short of max')
    expect(page.text).not.toContain('payout headroom')
  })

  it('renders as before when the server does not say', () => {
    const page = render()
    expect(page.probed).toHaveLength(5)
    expect(page.figures[0]).toEqual(['backends down', '2', 'of 5', 'c-loss'])
    expect(page.figures.map(([label]) => label)).toContain('short of max')
    expect(page.text).toContain('payout headroom')
  })
})
