/**
 * Which armed actions the detail dialog offers, and on what.
 *
 * `app.js` is a browser module with no exports and no DOM here, so this reads
 * the source the way `test/cli/corridorEnabled.test.ts` reads `cli.ts` — the
 * same reason, a file that cannot be imported and called.
 *
 * Worth pinning because the failure is silent and was shipped: the arming list
 * was keyed on CORRIDOR alone, so a delivered swap — `claimed`, its lockup
 * already spent by the solver's own claim — still offered `refund-now`. It
 * moves no money (`refundNow` returns `NOTHING_AT_SCRIPT` when the script is
 * empty), which is exactly what makes it corrosive: an armed-tier confirmation
 * that always no-ops is how an operator learns to click through the ones that
 * do move funds.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const appSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
  'utf8',
)

const actionsSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/admin/routes/actions.ts', import.meta.url)),
  'utf8',
)

/** The arming block inside `detailDialog`. */
const armingBlock = (): string => {
  const start = appSource.indexOf('const detailDialog')
  if (start === -1) throw new Error('detailDialog is gone')
  const armed = appSource.indexOf('const armed', start)
  if (armed === -1) throw new Error('the arming list is gone')
  return appSource.slice(start, appSource.indexOf('return h(', armed))
}

/**
 * The WHOLE of `detailDialog`, buttons included.
 *
 * Wider than {@link armingBlock}, which stops at `return h(`: the armed list
 * sits above that line and the action buttons below it.
 */
const dialogBlock = (): string => {
  const start = appSource.indexOf('const detailDialog')
  if (start === -1) throw new Error('detailDialog is gone')
  const end = appSource.indexOf('const attentionPanel', start)
  return appSource.slice(start, end === -1 ? start + 12_000 : end)
}

/** Just the `armed` array literal, where the per-corridor ternaries live. */
const armedList = (): string => {
  const block = armingBlock()
  const at = block.indexOf('const armed')
  const end = block.indexOf('.filter(Boolean)', at)
  return block.slice(at, end === -1 ? block.length : end)
}

describe('detailDialog — arming the unwind actions', () => {
  it('withholds every armed action on a delivered swap', () => {
    const block = armingBlock()
    // The gate itself, and that it feeds the list rather than sitting beside it.
    expect(block).toContain("d.swap.phase === 'done'")
    expect(block).toMatch(/const armed = \w+\s*\?\s*\[\]/)
  })

  it('still offers them on every other phase', () => {
    // `failed` is the one that matters: a `refused` or `stuck` row can hold a
    // funded lockup, and unwinding it is what these actions are for. A gate
    // written as "only when open" would silently strand those.
    const block = armingBlock()
    for (const phase of ['open', 'exposed', 'failed']) {
      expect(block).not.toContain(`'${phase}'`)
    }
  })

  it('keeps each action on the corridor that can perform it', () => {
    const block = armingBlock()
    expect(block).toMatch(/'arkade:BTC->lightning:BTC' \? 'refund-now'/)
    expect(block).toMatch(/'arkade:BTC->onchain:BTC' \? 'onchain-refund-now'/)
    expect(block).toMatch(/'arkade:BTC->onchain:BTC' \? 'reclaim-l1-htlc'/)
  })
})

describe('the phase vocabulary this relies on', () => {
  it('treats delivery as the only phase with nothing left to unwind', async () => {
    // `refunded` is deliberately NOT delivery — it ended safely but did not
    // deliver. If it ever moved into `done`, the gate above would start hiding
    // the actions on rows that may still need them, so pin the classification
    // the gate reads rather than trusting it stays put.
    const { phaseOf } = await import('@arkade-os/solver-app/admin/projection.js')
    expect(phaseOf('arkade:BTC->lightning:BTC', 'claimed')).toBe('done')
    expect(phaseOf('arkade:BTC->onchain:BTC', 'claimed')).toBe('done')
    expect(phaseOf('arkade:BTC->lightning:BTC', 'refused')).toBe('failed')
    expect(phaseOf('arkade:BTC->lightning:BTC', 'refunded')).toBe('failed')
  })
})

/**
 * The overview must SHOW the rows waiting on a human, not merely serve them.
 *
 * `/api/overview` carrying `attention.stuck` is not the fix on its own: an
 * operator reads the console, not the JSON. The first version of this change
 * added the field and stopped there, which would have shipped a stuck-row
 * alert nobody could see — the exact failure it was written to prevent.
 */
describe('overviewView — rows that need a human', () => {
  const overview = (): string => {
    const start = appSource.indexOf('const attentionPanel')
    if (start === -1) throw new Error('attentionPanel is gone')
    return appSource.slice(start, appSource.indexOf('const overviewView', start) + 400)
  }

  it('renders the stuck rows on the overview', () => {
    expect(overview()).toContain('o.attention?.stuck')
    // Wired into the view, not merely defined beside it.
    expect(appSource).toContain('attentionPanel(o)')
  })

  it('links each row to its detail, where read payment lives', () => {
    // "3 stuck" with no way to reach them is a nag, not a tool: the next thing
    // an operator needs is `read payment`, and that is on the detail dialog.
    expect(overview()).toContain('openDetail(row)')
  })

  it('renders nothing at all when none are stuck', () => {
    // A permanent empty panel is how a page teaches you to skip that position,
    // which is precisely where the number has to be noticed.
    expect(overview()).toMatch(/stuck\.length === 0\) return null/)
  })

  it('puts the count in the status bar too, on a proven colour pair', () => {
    // `.status .at-risk` is `--exposed` on `--ground`, which
    // `test/admin/contrast.test.ts` already declares. The panel stays plain
    // rather than introducing an undeclared pair.
    expect(appSource).toContain('o.attention?.stuckCount')
    expect(appSource).not.toContain("'section.panel.at-risk'")
  })
})

/**
 * An action pressed on the detail modal answers a question about the row the
 * operator is looking at — and `read payment`'s verdict is the one they then
 * act on with real money. Rendered as a page banner it was BOTH hidden behind
 * the modal's scrim AND cut to 160 characters, which is enough to show `{` and
 * lose the verdict.
 */
describe('detailDialog — an action’s answer belongs in the modal', () => {
  const detail = (): string => {
    const start = appSource.indexOf('const detailDialog')
    if (start === -1) throw new Error('detailDialog is gone')
    return appSource.slice(start, appSource.indexOf('const confirmDialog', start))
  }

  it('renders the result inside the dialog, keyed to this swap', () => {
    expect(detail()).toContain('state.result.forSwap === d.swap.id')
  })

  it('does not truncate it there', () => {
    // The 160-char cap belongs to the page banner, which sits above a table an
    // operator is scanning. Nothing is being scanned in the modal.
    const block = detail()
    expect(block).not.toContain('slice(0, 160)')
    expect(block).toContain('JSON.stringify(state.result.result, null, 2)')
  })

  it('puts it ABOVE the buttons, between the verdict and the money', () => {
    // Anchored on the rendered button itself, not on the `armed` list computed
    // at the top of the dialog — that list mentions the same action names and
    // would make this pass for the wrong reason.
    const block = detail()
    expect(block.indexOf('state.result.forSwap === d.swap.id')).toBeLessThan(block.indexOf("'recheck'"))
  })

  it('records which swap an action was run from', () => {
    expect(appSource).toContain('forSwap: state.detail?.swap.id ?? null')
  })

  it('does not also render it as a banner behind the scrim', () => {
    expect(appSource).toContain('state.detail?.swap.id === state.result.forSwap')
  })

  it('drops a result belonging to a different swap when another is opened', () => {
    expect(appSource).toMatch(/state\.result\.forSwap !== row\.id\) state\.result = null/)
  })
})

/**
 * The actions the detail dialog offers on EVERY row, and the one rule they all
 * have to obey.
 *
 * The console LISTS the registry — `admin/routes/swaps.ts` pages the reader set,
 * so an EVM token corridor's swaps and an injected corridor's swaps appear like
 * any other row. Operator ACTIONS stay closed, keyed to the four BTC pairs, and
 * that split is deliberate. What it silently creates is one defect class: an
 * action rendered on every row whose implementation only knows four corridors.
 *
 * There were exactly two, and both shipped broken. `tick` refused an EVM row by
 * NAME ("must be one of …") on a screen that had just rendered it and, through
 * `nextStep`, advised pressing it. `park-swap` was worse — it did not dispatch
 * at all, reaching the Lightning-send store directly, so it threw on
 * onchain-send, both receive legs and every EVM pair, on the only lever that
 * stops the sweep re-driving a row.
 *
 * Nothing stopped a third. This is that.
 */
describe('detailDialog — actions offered on every corridor', () => {
  /** An action's `run` body in `actions.ts`, by name. */
  const runBlockOf = (name: string): string => {
    const key = new RegExp(`^  '?${name}'?: \{$`, 'm')
    const at = actionsSource.search(key)
    if (at === -1) throw new Error(`no action named ${name} in actions.ts`)
    const end = actionsSource.indexOf('\n  },', at)
    return actionsSource.slice(at, end === -1 ? at + 2000 : end)
  }

  /**
   * Derived, not listed — a new universal button has to trip this rather than
   * arrive unnoticed.
   *
   * Two shapes carry an action into the dialog: an `actButton` wired to
   * `runAction('x')`, and a bare string in the `armed` array. In both, the
   * corridor gate is a `d.swap.corridor === '…' ?` ternary sitting IMMEDIATELY
   * before the thing it guards, so proximity is what distinguishes a gated
   * action from one offered everywhere. The distances are not close: a gated
   * button's ternary is ~60 characters ahead of its `actButton(`, an ungated
   * one's nearest comparison is thousands away and belongs to something else.
   */
  const universalActions = (): string[] => {
    const block = dialogBlock()
    const found = new Set<string>()

    for (const m of block.matchAll(/runAction\('([a-z-]+)'/g)) {
      const before = block.slice(0, m.index)
      const gate = before.lastIndexOf('d.swap.corridor ===')
      const button = before.lastIndexOf('actButton(')
      const name = m[1]
      if (name && !(gate !== -1 && gate < button && button - gate < 120)) found.add(name)
    }

    const armed = armedList()
    for (const m of armed.matchAll(/'([a-z][a-z-]+)'/g)) {
      const before = armed.slice(Math.max(0, m.index - 120), m.index)
      const name = m[1]
      if (name && !/corridor ===/.test(before)) found.add(name)
    }
    return [...found].sort()
  }

  it('is exactly the two known ones — a third must be a decision, not a surprise', () => {
    // Pinned so the derivation above cannot quietly stop working: if a refactor
    // moves the gates and every action starts reading as universal, this fails
    // rather than passing an emptier rule.
    expect(universalActions()).toEqual(['park-swap', 'tick'])
  })

  it('dispatches each of them through the corridor REGISTRY, not the closed union', () => {
    for (const name of universalActions()) {
      const run = runBlockOf(name)
      expect(run, `${name} must resolve its corridor from services.corridors`).toContain('services.corridors.get(')
      // `requireCorridor` is the closed-union validator and belongs to
      // `read-payment`, which is genuinely Lightning-send-only. On an action
      // rendered everywhere it is the bug: it refuses by naming four pairs.
      expect(run, `${name} must not validate against the closed CORRIDORS union`).not.toMatch(/requireCorridor\(/)
    }
  })
})
