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

/** The arming block inside `detailDialog`. */
const armingBlock = (): string => {
  const start = appSource.indexOf('const detailDialog')
  if (start === -1) throw new Error('detailDialog is gone')
  const armed = appSource.indexOf('const armed', start)
  if (armed === -1) throw new Error('the arming list is gone')
  return appSource.slice(start, appSource.indexOf('return h(', armed))
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
