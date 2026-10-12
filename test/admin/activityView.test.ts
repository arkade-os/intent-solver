import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')
const loading = source.slice(source.indexOf('const ENDPOINTS'), source.indexOf('const go ='))
const activitySections = ['swaps', 'quotes', 'offers', 'refusals']
const harness = (hash = '#activity', failOffers = false) => {
  const state = { data: {} as Record<string, unknown>, activityErrors: {}, filters: { q: '', corridor: '', phase: '' } }
  const requests: string[] = []
  const api = async (path: string) => {
    requests.push(path)
    if (failOffers && path === '/api/offers') throw new Error('offer store unavailable')
    return { path }
  }
  const ui = new Function(
    'state',
    'api',
    'render',
    'location',
    'BODIES',
    'ACTIVITY_SECTIONS',
    'MIN_SEARCH',
    `
    ${loading}
    return { load, viewFromHash }
  `,
  )(state, api, () => {}, { hash }, { activity: () => {} }, activitySections, 3) as {
    load: (view: string) => Promise<void>
    viewFromHash: () => string
  }
  return {
    ...ui,
    state,
    requests,
    recoverOffers: () => {
      failOffers = false
    },
  }
}

describe('one activity page', () => {
  it('loads swaps, awaiting quotes, offer fills and request refusals together', async () => {
    const ui = harness()
    await ui.load('activity')
    expect(ui.requests).toEqual(
      expect.arrayContaining(['/api/swaps?', '/api/quotes', '/api/offers', '/api/rfq-refusals']),
    )
    expect(Object.keys(ui.state.data).sort()).toEqual([...activitySections].sort())
  })

  it.each(activitySections)('keeps the old #%s link reachable on the activity page', (view) => {
    expect(harness(`#${view}`).viewFromHash()).toBe('activity')
  })

  it('keeps successful sections visible and marks a failed section instead of showing stale rows', async () => {
    const ui = harness('#activity', true)
    ui.state.data.offers = { stale: true }
    await ui.load('activity')
    expect(ui.state.data.swaps).toEqual({ path: '/api/swaps?' })
    expect(ui.state.data.quotes).toEqual({ path: '/api/quotes' })
    expect(ui.state.data.offers).toBeUndefined()
    expect(ui.state.activityErrors).toEqual({ offers: 'offer store unavailable' })
    ui.recoverOffers()
    await ui.load('offers')
    expect(ui.state.data.offers).toEqual({ path: '/api/offers' })
    expect(ui.state.activityErrors).toEqual({})
  })

  it('refreshes only the filtered swap list without replacing the other sections', async () => {
    const ui = harness()
    await ui.load('activity')
    const offers = ui.state.data.offers
    ui.requests.length = 0
    ui.state.filters.phase = 'exposed'
    await ui.load('swaps')
    expect(ui.requests).toEqual(['/api/overview', '/api/swaps?phase=exposed'])
    expect(ui.state.data.offers).toBe(offers)
  })

  it('keeps swap filters usable after an invalid corridor request', () => {
    const state = {
      data: {},
      activityErrors: { swaps: 'unknown_corridor' },
      filters: { q: '', corridor: 'onchain:BTC->arkade:BTC', phase: '' },
    }
    const controls: { spec: string; args: unknown[] }[] = []
    const h = (spec: string, ...args: unknown[]) => {
      const node = { spec, args }
      controls.push(node)
      return node
    }
    const swaps = source.slice(source.indexOf('const swapsView'), source.indexOf('const quotesView'))
    new Function('state', 'h', 'load', 'corridorLabel', 'MIN_SEARCH', 'activityError', `${swaps}; swapsView()`)(
      state,
      h,
      () => {},
      (s: string) => s,
      3,
      () => h('p.banner', 'unknown_corridor'),
    )
    const corridor = controls.find((node) => node.spec === 'select')
    expect(corridor).toBeDefined()
    const props = corridor!.args[0] as { onchange: (event: unknown) => void }
    props.onchange({ target: { value: '' } })
    expect(state.filters.corridor).toBe('')
    expect(controls.some((node) => node.spec === 'table')).toBe(false)
  })

  it('offers a single navigation entry for all four sections', () => {
    const nav = source.slice(source.indexOf('const VIEWS'), source.indexOf('const fail'))
    expect(nav).toContain("['activity', 'activity']")
    for (const view of activitySections) expect(nav).not.toContain(`['${view}',`)
  })
})
