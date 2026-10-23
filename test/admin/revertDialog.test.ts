/**
 * The revert-to-config dialog, run from the shipped `app.js` with a recording `h`.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const appSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
  'utf8',
)

const revertBlock = (): string => {
  const start = appSource.indexOf('const openRevert')
  const end = appSource.indexOf('const editKnob', start)
  if (start === -1 || end === -1) throw new Error('the revert block is gone from app.js')
  return appSource.slice(start, end)
}

interface Node {
  spec: string
  attrs: Record<string, unknown>
  children: unknown[]
}

const h = (spec: string, ...rest: unknown[]): Node => {
  const attrs =
    rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) && !('spec' in (rest[0] as object))
      ? (rest.shift() as Record<string, unknown>)
      : {}
  return { spec, attrs, children: rest.flat(Infinity).filter((child) => child !== null && child !== undefined) }
}

const textOf = (node: unknown): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : node && typeof node === 'object' && 'children' in node
      ? (node as Node).children.map(textOf).join(' ')
      : ''

const find = (node: unknown, match: (node: Node) => boolean): Node[] => {
  if (!node || typeof node !== 'object' || !('spec' in node)) return []
  const here = node as Node
  return [...(match(here) ? [here] : []), ...here.children.flatMap((child) => find(child, match))]
}

const ui = (state: Record<string, unknown>, api = vi.fn(), load = vi.fn(async () => {})) =>
  new Function(
    'state',
    'h',
    'api',
    'render',
    'load',
    'closeConfirm',
    'actButton',
    'fail',
    `${revertBlock()}; return { openRevert, applyRevert, revertDialog, revertButton }`,
  )(
    state,
    h,
    api,
    () => {},
    load,
    () => {
      state.dialog = null
    },
    (spec: string, attrs: Record<string, unknown>, ...label: unknown[]) => h(spec, attrs, ...label),
    (error: Error) => {
      state.banner = error.message
    },
  ) as {
    openRevert: (scope: object) => Promise<void>
    applyRevert: () => Promise<void>
    revertDialog: (d: object) => Node
    revertButton: (scope: object, label: string) => Node | null
  }

const NOW = {
  target: 'USDA',
  marketKey: 'k-usda',
  field: 'rfqSellBase',
  current: 'true',
  config: 'false',
  applies: 'now',
}
const RESTART = {
  target: 'corridors["arkade:BTC->lightning:BTC"].feeBps',
  field: 'value',
  current: '25',
  config: '0',
  applies: 'restart',
}
const plan = (changes: object[]) => ({ changes, basis: 'b'.repeat(64), loadedAt: 1_800_000_000 })

describe('the revert dialog', () => {
  it('groups what applies now apart from what waits for a restart', () => {
    const tree = ui({}).revertDialog({ kind: 'revert', scope: { scope: 'all' }, plan: plan([NOW, RESTART]) })
    const text = textOf(tree)
    expect(text).toContain('Revert to config file')
    expect(text).toContain('Config as loaded at')
    expect(text).toContain('Applies now')
    expect(text).toContain('Applies after restart')
    expect(text).toContain('true → false')
    expect(text).toContain('25 → 0')
    expect(text).toContain('This replaces console changes. To undo, edit them again.')
  })

  it('omits an empty group', () => {
    expect(textOf(ui({}).revertDialog({ kind: 'revert', scope: { scope: 'all' }, plan: plan([NOW]) }))).not.toContain(
      'Applies after restart',
    )
  })

  it('offers review again, not revert, once the preview has gone stale', () => {
    const tree = ui({}).revertDialog({ kind: 'revert', scope: { scope: 'all' }, plan: plan([NOW]), stale: true })
    const labels = find(tree, (node) => node.spec.startsWith('button')).map(textOf)
    expect(labels).toContain('review again')
    expect(labels).not.toContain('revert')
  })
})

describe('the revert button', () => {
  it('says the console matches the config file, and is disabled, when there is nothing to revert', () => {
    const button = ui({ data: { revert: plan([]) } }).revertButton({ scope: 'all' }, 'Revert to config file')!
    expect(button.attrs.disabled).toBe(true)
    expect(textOf(button)).toBe('matches config file')
  })

  it('counts only its own market, and leaves one that already matches to the whole-console button', () => {
    const state = { data: { revert: plan([NOW]) } }
    expect(ui(state).revertButton({ scope: 'market', marketKey: 'k-other' }, 'Revert')).toBeNull()
    expect(ui(state).revertButton({ scope: 'market', marketKey: 'k-usda' }, 'Revert')!.attrs.disabled).toBe(false)
  })

  it('is absent when the preview could not be read', () => {
    expect(ui({ data: { revert: null } }).revertButton({ scope: 'all' }, 'Revert')).toBeNull()
  })
})

describe('where the buttons live', () => {
  const pricingView = (): string => {
    const start = appSource.indexOf('const pricingView = () => {')
    return appSource.slice(start, appSource.indexOf('const auditView', start))
  }

  it('offers the whole revert on the pricing screen, and one market’s beside that market', () => {
    expect(pricingView()).toContain("revertButton({ scope: 'all' }, 'Revert to config file')")
    expect(pricingView()).toMatch(/revertButton\(\s*\{ scope: 'market', marketKey: saved\.marketKey \}/)
  })

  it('reads the preview with the pricing screen, so the button knows before it is pressed', () => {
    const load = appSource.slice(appSource.indexOf('const load = async'), appSource.indexOf('const viewFromHash'))
    expect(load).toMatch(
      /view === 'pricing'[\s\S]*?\/api\/config\/revert[\s\S]*?dryRun: true[\s\S]*?state\.data\.revert = /,
    )
  })

  it('opens from the shared confirm slot', () => {
    expect(appSource).toContain("if (d.kind === 'revert') return revertDialog(d)")
  })
})

describe('applying', () => {
  it('posts the scope and the preview basis, then closes and reloads', async () => {
    const api = vi.fn(async () => ({ applied: [NOW] }))
    const load = vi.fn(async () => {})
    const state: Record<string, unknown> = {
      view: 'pricing',
      dialog: { kind: 'revert', scope: { scope: 'all' }, plan: plan([NOW]) },
    }
    await ui(state, api, load).applyRevert()
    expect(api).toHaveBeenCalledWith('/api/config/revert', {
      method: 'POST',
      body: JSON.stringify({ scope: 'all', dryRun: false, basis: 'b'.repeat(64) }),
    })
    expect(state.dialog).toBeNull()
    expect(load).toHaveBeenCalledWith('pricing')
  })

  it('keeps the dialog open on a stale preview, with the reason in it', async () => {
    const stale = Object.assign(new Error('config or console state changed since the preview; review again'), {
      status: 409,
    })
    const state: Record<string, unknown> = {
      dialog: { kind: 'revert', scope: { scope: 'all' }, plan: plan([NOW]) },
    }
    await ui(
      state,
      vi.fn(async () => Promise.reject(stale)),
    ).applyRevert()
    expect(state.dialog).toMatchObject({ error: stale.message, stale: true })
  })

  it('opens no dialog when the fresh preview has nothing to change, and reloads so the button says so', async () => {
    const load = vi.fn(async () => {})
    const state: Record<string, unknown> = { view: 'pricing', data: {} }
    await ui(
      state,
      vi.fn(async () => plan([])),
      load,
    ).openRevert({ scope: 'all' })
    expect(state.dialog ?? null).toBeNull()
    expect(load).toHaveBeenCalledWith('pricing')
  })

  it('closes a stale dialog whose review finds nothing left to change', async () => {
    const state: Record<string, unknown> = {
      view: 'pricing',
      data: {},
      dialog: { kind: 'revert', scope: { scope: 'all' }, plan: plan([NOW]), stale: true, error: 'changed' },
    }
    await ui(
      state,
      vi.fn(async () => plan([])),
    ).openRevert({ scope: 'all' })
    expect(state.dialog).toBeNull()
  })
})
