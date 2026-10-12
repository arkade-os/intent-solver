import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')
const loading = source.slice(source.indexOf('const ENDPOINTS'), source.indexOf('const go ='))
const activitySections = ['swaps', 'quotes', 'offers', 'refusals']
const harness = (hash = '#activity', failOffers = false, response?: (path: string) => Promise<unknown>) => {
  const state = {
    view: 'activity',
    overview: null as unknown,
    overviewError: null as string | null,
    data: {} as Record<string, unknown>,
    activityErrors: {},
    filters: { q: '', corridor: '', phase: '' },
    pnl: { window: '24h', bucket: '' },
  }
  const renders: unknown[] = []
  let headerUpdates = 0,
    balanceUpdates = 0
  const render = () => renders.push(structuredClone(state))
  const requests: string[] = []
  const api = async (path: string) => {
    requests.push(path)
    if (failOffers && path === '/api/offers') throw new Error('offer store unavailable')
    if (response) return response(path)
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
    'paintStatus',
    'paintOverviewBalances',
    `
    ${loading}
    return { load, viewFromHash }
  `,
  )(
    state,
    api,
    render,
    { hash },
    { activity: () => {} },
    activitySections,
    3,
    () => {
      headerUpdates++
      if (state.view === 'overview') render()
    },
    () => {
      balanceUpdates++
    },
  ) as {
    load: (view: string) => Promise<void>
    viewFromHash: () => string
  }
  return {
    ...ui,
    state,
    requests,
    renders,
    headerUpdates: () => headerUpdates,
    balanceUpdates: () => balanceUpdates,
    recoverOffers: () => {
      failOffers = false
    },
  }
}

describe('one activity page', () => {
  it('keeps changed P&L filters separate and ignores their older response', async () => {
    const pending: ((value: unknown) => void)[] = []
    const ui = harness('#activity', false, async (path) => {
      if (!path.startsWith('/api/pnl')) return { path }
      return new Promise((resolve) => pending.push(resolve))
    })
    ui.state.view = 'pnl'
    const older = ui.load('pnl')
    ui.state.pnl.window = '7d'
    const newer = ui.load('pnl')
    expect(pending).toHaveLength(2)
    pending[1]!({ revision: 'newer' })
    await newer
    pending[0]!({ revision: 'older' })
    await older
    expect(ui.state.data.pnl).toEqual({ revision: 'newer' })
    expect(ui.renders).toHaveLength(1)
  })

  it.each(['wallet', 'backends'])('completes a slow %s read despite repeated refreshes', async (view) => {
    let finish!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      finish = resolve
    })
    const ui = harness('#activity', false, async (path) => (path === `/api/${view}` ? pending : { path }))
    ui.state.view = view
    const reads = [ui.load(view), ui.load(view), ui.load(view)]
    expect(ui.requests.filter((path) => path === `/api/${view}`)).toHaveLength(1)
    finish({ revision: 'completed' })
    await Promise.all(reads)
    expect(ui.state.data[view]).toEqual({ revision: 'completed' })
    expect(ui.renders).toHaveLength(1)
    await ui.load(view)
    expect(ui.requests.filter((path) => path === `/api/${view}`)).toHaveLength(2)
  })

  it.each(['activity', 'pricing'])(
    'renders %s before a slow overview and does not rebuild it when status arrives',
    async (view) => {
      let finish!: (value: unknown) => void
      const pending = new Promise((resolve) => {
        finish = resolve
      })
      const ui = harness('#activity', false, async (path) => (path.startsWith('/api/overview') ? pending : { path }))
      ui.state.view = view
      const loading = ui.load(view)
      await vi.waitFor(() => expect(ui.renders).toHaveLength(1), { timeout: 250 })
      expect(ui.requests).toContain('/api/overview?balances=false')
      const renders = ui.renders.length
      finish({ exposure: { exposedCount: 1 } })
      await loading
      expect(ui.renders).toHaveLength(renders)
      expect(ui.headerUpdates()).toBe(1)
    },
  )

  it('still displays Activity when the shared status request fails', async () => {
    const ui = harness('#activity', false, async (path) => {
      if (path.startsWith('/api/overview')) throw new Error('status offline')
      return { path }
    })
    await ui.load('activity')
    expect(Object.keys(ui.state.data).sort()).toEqual([...activitySections].sort())
    expect(ui.state.overviewError).toBe('status offline')
    expect(ui.state.activityErrors).toEqual({})
  })

  it('loads Overview risk data before balances and coalesces overlapping balance reads', async () => {
    let finish!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      finish = resolve
    })
    const ui = harness('#activity', false, async (path) =>
      path === '/api/overview' ? pending : { exposure: { exposedCount: 1 } },
    )
    ui.state.view = 'overview'
    const first = ui.load('overview')
    const second = ui.load('overview')
    await vi.waitFor(() => expect(ui.state.overview).toEqual({ exposure: { exposedCount: 1 } }), { timeout: 250 })
    expect(ui.requests.filter((path) => path === '/api/overview')).toHaveLength(1)
    expect(ui.state.data.overviewBalances).toBeUndefined()
    finish({ balances: { lightningSats: 100 } })
    await Promise.all([first, second])
    expect(ui.state.data.overviewBalances).toEqual({ lightningSats: 100 })
    expect(ui.balanceUpdates()).toBe(1)
  })

  it.each([false, true])('ignores an older status response or error (error=%s)', async (failed) => {
    let finish!: (value: unknown) => void, reject!: (error: Error) => void
    const pending = new Promise((resolve, fail) => {
      finish = resolve
      reject = fail
    })
    let reads = 0
    const ui = harness('#activity', false, async (path) => {
      if (!path.startsWith('/api/overview')) return { path }
      return ++reads === 1 ? pending : { exposure: { exposedCount: 1 } }
    })
    const old = ui.load('activity')
    await ui.load('swaps')
    if (failed) reject(new Error('old failure'))
    else finish({ exposure: { exposedCount: 0 } })
    await old
    expect(ui.state.overview).toEqual({ exposure: { exposedCount: 1 } })
    expect(ui.state.overviewError).toBeNull()
  })

  it('leaves an editor intact when a balance read finishes after navigating away', async () => {
    let finish!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      finish = resolve
    })
    const ui = harness('#activity', false, async (path) => (path === '/api/overview' ? pending : { path }))
    ui.state.view = 'overview'
    const old = ui.load('overview')
    await vi.waitFor(() => expect(ui.headerUpdates()).toBe(1), { timeout: 250 })
    ui.state.view = 'pricing'
    await ui.load('pricing')
    const renders = ui.renders.length
    finish({ balances: { lightningSats: 100 } })
    await old
    expect(ui.renders).toHaveLength(renders)
    expect(ui.balanceUpdates()).toBe(0)
  })
  it.each(activitySections.flatMap((key) => ['activity', key].map((olderView) => ({ key, olderView }))))(
    'ignores older $olderView results and errors for $key after a newer section load',
    async ({ key, olderView }) => {
      for (const staleError of [false, true]) {
        const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = []
        const ui = harness('#activity', false, async (path) => {
          const endpoint = key === 'swaps' ? '/api/swaps?' : key === 'refusals' ? '/api/rfq-refusals' : `/api/${key}`
          if (!path.startsWith(endpoint)) return { path }
          return new Promise((resolve, reject) => pending.push({ resolve, reject }))
        })
        const older = ui.load(olderView)
        await vi.waitFor(() => expect(pending).toHaveLength(1))
        ui.state.filters.phase = 'exposed'
        const newer = ui.load(key)
        await vi.waitFor(() => expect(pending).toHaveLength(2))
        pending[1]!.resolve({ revision: 'newer' })
        await newer
        if (staleError) pending[0]!.reject(new Error('old request failed'))
        else pending[0]!.resolve({ revision: 'older' })
        await older
        expect(ui.state.data[key]).toEqual({ revision: 'newer' })
        expect(ui.state.activityErrors).toEqual({})
      }
    },
  )
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
    expect(ui.requests).toEqual(['/api/overview?balances=false', '/api/swaps?phase=exposed'])
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
