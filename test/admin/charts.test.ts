/**
 * The chart module's arithmetic, run for real.
 *
 * `app.js` is tested by reading its source (see `quotesView.test.ts`) because
 * it is a browser module with no exports and no DOM here. `charts.js` is
 * neither: it exports pure functions whose only DOM need is
 * `createElementNS`/`createTextNode`, so a thirty-line stub buys an actual
 * execution of the scales, the tick rounding and the zero-split — which is
 * where a chart goes wrong in a way nobody sees. A path that comes out `NaN`
 * renders as nothing at all, and an empty panel reads as "no trading" rather
 * than "the chart broke".
 */
import { describe, it, expect, beforeAll } from 'vitest'

interface Stub {
  tag: string
  attributes: Record<string, string>
  children: Stub[]
  text: string | null
}

const flatten = (node: Stub): Stub[] => [node, ...node.children.flatMap(flatten)]
const withClass = (node: Stub, name: string): Stub[] =>
  flatten(node).filter((child) => (child.attributes.class ?? '').split(' ').includes(name))
const titles = (node: Stub): string[] =>
  flatten(node)
    .filter((child) => child.tag === 'title')
    .flatMap((child) => child.children.map((text) => text.text ?? ''))

let charts: typeof import('../../packages/solver-app/src/admin/static/charts.js')

beforeAll(async () => {
  class FakeNode {
    constructor(
      readonly tag = '',
      readonly attributes: Record<string, string> = {},
      readonly children: FakeNode[] = [],
      readonly text: string | null = null,
    ) {}
    setAttribute(key: string, value: string): void {
      this.attributes[key] = value
    }
    appendChild(child: FakeNode): FakeNode {
      this.children.push(child)
      return child
    }
  }
  const globals = globalThis as unknown as Record<string, unknown>
  globals.Node = FakeNode
  globals.document = {
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => new FakeNode('#text', {}, [], text),
  }
  charts = (await import('../../packages/solver-app/src/admin/static/charts.js')) as never
})

const point = (
  over: Partial<{ at: number; grossSats: number; cumulativeGrossSats: number; count: number; atRiskSats: number }>,
) => ({
  at: 1_000,
  grossSats: 0,
  cumulativeGrossSats: 0,
  count: 1,
  atRiskSats: 0,
  ...over,
})

/** Every number that reached a coordinate attribute. A NaN here draws nothing. */
const coordinates = (node: Stub): number[] =>
  flatten(node).flatMap((child) =>
    ['x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'width', 'height']
      .map((key) => child.attributes[key])
      .filter((value): value is string => value !== undefined)
      .map(Number),
  )

const paths = (node: Stub): string[] =>
  flatten(node)
    .map((child) => child.attributes.d)
    .filter((d): d is string => d !== undefined)

describe('cumulativeChart', () => {
  it('draws a FLAT series rather than dividing by a zero span', () => {
    // A book that made nothing all week is a real and common state. A naive
    // scale gives max === min, every coordinate becomes NaN, and the panel
    // renders empty — which reads as "no trading", not "flat".
    const svg = charts.cumulativeChart([point({ at: 1_000 }), point({ at: 2_000 })]) as unknown as Stub
    expect(coordinates(svg).every(Number.isFinite)).toBe(true)
    expect(paths(svg).every((d) => !d.includes('NaN'))).toBe(true)
  })

  it('draws a single point without collapsing its axis', () => {
    const svg = charts.cumulativeChart([
      point({ at: 1_000, grossSats: 300, cumulativeGrossSats: 300 }),
    ]) as unknown as Stub
    expect(coordinates(svg).every(Number.isFinite)).toBe(true)
  })

  it('splits the fill at zero so an underwater book is coloured as a loss', () => {
    const svg = charts.cumulativeChart([
      point({ at: 1_000, cumulativeGrossSats: 500 }),
      point({ at: 2_000, cumulativeGrossSats: -500 }),
    ]) as unknown as Stub
    expect(withClass(svg, 'c-area')).toHaveLength(2)
    expect(withClass(svg, 'c-loss')).toHaveLength(1)
  })

  it('gives every drawn bucket a hoverable exact figure', () => {
    const svg = charts.cumulativeChart([
      point({ at: 1_000, grossSats: 300, cumulativeGrossSats: 300, count: 2 }),
    ]) as unknown as Stub
    expect(titles(svg).join(' ')).toContain('+300 sats this bucket')
    expect(titles(svg).join(' ')).toContain('2 swaps')
  })

  it('omits a dot on an empty bucket, so a gap reads as a gap', () => {
    const svg = charts.cumulativeChart([
      point({ at: 1_000, count: 1, cumulativeGrossSats: 300 }),
      point({ at: 2_000, count: 0, cumulativeGrossSats: 300 }),
    ]) as unknown as Stub
    expect(withClass(svg, 'c-dot')).toHaveLength(1)
  })

  it('renders an empty window as an empty frame rather than throwing', () => {
    expect(() => charts.cumulativeChart([])).not.toThrow()
  })
})

describe('barsChart', () => {
  it('draws at-risk sats DOWNWARD and in the risk colour — a loss is not a smaller profit', () => {
    const svg = charts.barsChart([point({ at: 1_000, grossSats: 300, atRiskSats: 50_000 })]) as unknown as Stub
    const risk = withClass(svg, 'c-risk')
    const gain = withClass(svg, 'c-bar').filter((node) => !(node.attributes.class ?? '').includes('c-risk'))
    expect(risk).toHaveLength(1)
    expect(Number(risk[0]!.attributes.y)).toBeGreaterThanOrEqual(Number(gain[0]!.attributes.y))
    expect(titles(svg).join(' ')).toContain('50,000 sats at risk')
  })

  it('marks a negative bucket as a loss', () => {
    const svg = charts.barsChart([point({ at: 1_000, grossSats: -300 })]) as unknown as Stub
    expect(withClass(svg, 'c-loss')).toHaveLength(1)
  })

  it('never emits a zero-height bar that would be invisible', () => {
    const svg = charts.barsChart([
      point({ at: 1_000, grossSats: 1 }),
      point({ at: 2_000, grossSats: 1_000_000 }),
    ]) as unknown as Stub
    for (const bar of withClass(svg, 'c-bar')) expect(Number(bar.attributes.height)).toBeGreaterThanOrEqual(1)
  })
})

describe('categoryChart', () => {
  const rows = [
    { corridor: 'arkade:BTC->lightning:BTC', grossSats: 900 },
    { corridor: 'arkade:BTC->onchain:BTC', grossSats: -300 },
  ]
  const build = () =>
    charts.categoryChart(rows, {
      label: (row: (typeof rows)[number]) => row.corridor,
      value: (row: (typeof rows)[number]) => row.grossSats,
    }) as unknown as Stub

  it('grows a bar in each direction from the zero line', () => {
    const bars = withClass(build(), 'c-bar')
    expect(bars).toHaveLength(2)
    expect(withClass(build(), 'c-loss')).toHaveLength(1)
  })

  it('keeps every coordinate finite when a single category is all there is', () => {
    const svg = charts.categoryChart([rows[0]!], {
      label: (row: (typeof rows)[number]) => row.corridor,
      value: (row: (typeof rows)[number]) => row.grossSats,
    }) as unknown as Stub
    expect(coordinates(svg).every(Number.isFinite)).toBe(true)
  })
})

describe('a bad value never blanks a whole chart', () => {
  /**
   * Every coordinate in these charts feeds a SHARED domain and, in the
   * cumulative chart, a shared path string — so one non-finite number made
   * `Math.min`/`Math.max` NaN and every mark on the panel vanished. An empty
   * panel reads as "nothing traded", which is the one thing it must never say
   * by accident.
   */
  it('drops the unusable point and still draws the rest', () => {
    const svg = charts.cumulativeChart([
      point({ at: 1_000, count: 1, cumulativeGrossSats: 300 }),
      { at: Number.NaN, count: 1, grossSats: 0, cumulativeGrossSats: Number.NaN, atRiskSats: 0 },
      point({ at: 3_000, count: 1, cumulativeGrossSats: 500 }),
    ]) as unknown as Stub
    expect(withClass(svg, 'c-dot')).toHaveLength(2)
    expect(coordinates(svg).every(Number.isFinite)).toBe(true)
    expect(paths(svg).every((d) => !d.includes('NaN'))).toBe(true)
  })

  it('does the same on the decay chart, where duration feeds the x-domain', () => {
    const svg = charts.decayChart([
      { id: 'ok', at: 1_000, durationSeconds: 30, rate: 500, driftBps: 5 },
      { id: 'bad', at: 2_000, durationSeconds: Number.NaN, rate: 500, driftBps: 5 },
    ]) as unknown as Stub
    expect(withClass(svg, 'c-dot')).toHaveLength(1)
    expect(coordinates(svg).every(Number.isFinite)).toBe(true)
  })
})

describe('chart labelling', () => {
  it('lets the caller name the quantity, because the chart does not know it', () => {
    const svg = charts.categoryChart([{ label: 'a', v: 1 }], {
      title: 'Realized margin in basis points',
      label: (row: { label: string }) => row.label,
      value: (row: { v: number }) => row.v,
    }) as unknown as Stub
    expect(svg.attributes['aria-label']).toBe('Realized margin in basis points')
  })

  it('gives two charts on one page distinct clip ids, so neither clips the other', () => {
    const clips = (node: Stub) =>
      flatten(node)
        .map((child) => child.attributes.id)
        .filter((id): id is string => id !== undefined)
    const first = clips(charts.cumulativeChart([point({ at: 1_000, cumulativeGrossSats: 1 })]) as unknown as Stub)
    const second = clips(charts.cumulativeChart([point({ at: 1_000, cumulativeGrossSats: 1 })]) as unknown as Stub)
    expect(first).toHaveLength(2)
    expect(first.filter((id) => second.includes(id))).toEqual([])
  })
})

describe('barsChart bar width', () => {
  /**
   * 7 days at a 5-minute bucket is 2,016 points and a slot 0.32px wide. A flat
   * one-pixel floor made every bar three times its own slot, so they
   * overlapped into a solid block that read as one enormous value.
   */
  it('never draws a bar wider than its own slot, however many buckets there are', () => {
    const many = Array.from({ length: 2_016 }, (_, i) => point({ at: 1_000 + i * 300, grossSats: 100 }))
    const svg = charts.barsChart(many) as unknown as Stub
    const slot = (720 - 62 - 14) / many.length
    for (const bar of withClass(svg, 'c-bar')) expect(Number(bar.attributes.width)).toBeLessThanOrEqual(slot)
  })
})

describe('decayChart', () => {
  const fills = [
    { id: 'fast', at: 1_000, durationSeconds: 5, rate: 500, driftBps: 12 },
    { id: 'slow', at: 2_000, durationSeconds: 7_200, rate: 490, driftBps: -80 },
  ]

  it('colours only the fills that came in WORSE than their peers', () => {
    const svg = charts.decayChart(fills) as unknown as Stub
    expect(withClass(svg, 'c-dot')).toHaveLength(2)
    expect(withClass(svg, 'c-loss')).toHaveLength(1)
  })

  it('places a slower fill to the RIGHT of a faster one', () => {
    const dots = withClass(charts.decayChart(fills) as unknown as Stub, 'c-dot')
    expect(Number(dots[1]!.attributes.cx)).toBeGreaterThan(Number(dots[0]!.attributes.cx))
  })

  it('keeps an instant fill on the axis rather than at minus infinity', () => {
    const svg = charts.decayChart([
      { id: 'instant', at: 1_000, durationSeconds: 0, rate: 500, driftBps: 0 },
    ]) as unknown as Stub
    expect(coordinates(svg).every(Number.isFinite)).toBe(true)
  })

  it('names the swap behind each point, so a dot leads back to a row', () => {
    expect(titles(charts.decayChart(fills) as unknown as Stub).join(' ')).toContain('slow')
  })
})
