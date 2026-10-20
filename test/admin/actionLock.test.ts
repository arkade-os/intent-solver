/**
 * One action at a time, and a visible sign that one is running.
 *
 * The console's action buttons stayed live for the whole request. Every one of
 * them is a POST to a backend that can take seconds — `refund now` waits on a
 * covenant spend, `read payment` on a Lightning backend that may be timing out
 * — and nothing about the page changed while it was outstanding. So the honest
 * reading of a still page was "my click did nothing", and the honest response
 * was to click again. The operator who reported this said exactly that: "my
 * instinct is to click one after the other hoping for action."
 *
 * Two distinct hazards, and they need the same lock:
 *
 * - The SAME button twice. A second `refund-now` is a second refund attempt.
 * - A DIFFERENT button while one is in flight. `refund now` and `claim now` on
 *   one row are two writes racing the same swap, and they are the two that
 *   disagree about where the money should end up.
 *
 * The second is why the lock is console-wide rather than per-button, and why
 * these tests care that the disable is not scoped to the pressed button.
 *
 * `app.js` is a browser module with no exports, no build step and no DOM here,
 * so this reads the source — the same approach and the same reason as
 * `test/admin/armedActions.test.ts`. That makes these structural assertions,
 * not behavioural ones: they are written to fail when the guard is removed or
 * defeated rather than to merely find a string, and each one was checked by
 * mutating `app.js` and watching it go red. What they cannot cover is the
 * render itself, which is verified in a browser.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const appSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
  'utf8',
)

/**
 * The body of a top-level `const NAME = ` arrow function.
 *
 * Anchored on the closing brace at column 0 rather than by counting braces:
 * these bodies carry prose comments, and `runAction`'s own explains that a
 * truncated result panel "is enough to show `{` and lose the verdict" — a lone
 * brace in a comment, which a counter reads as real and then never closes.
 * Column 0 is reliable here because prettier formats the file.
 */
const bodyOf = (name: string): string => {
  const start = appSource.indexOf(`const ${name} = `)
  if (start === -1) throw new Error(`${name} is gone`)
  const end = appSource.indexOf('\n}', appSource.indexOf('{', start))
  if (end === -1) throw new Error(`${name} does not close`)
  return appSource.slice(start, end + 2)
}

describe('runAction — the lock', () => {
  it('refuses a second action while one is in flight', () => {
    expect(bodyOf('runAction')).toMatch(/if \(state\.running\)\s*return/)
  })

  it('takes the lock BEFORE awaiting, not after', () => {
    // A guard that runs after the request has already been sent is decoration:
    // both clicks would be past it before either reply landed. The ordering is
    // the whole mechanism, so it is what gets pinned.
    const body = bodyOf('runAction')
    const taken = body.search(/state\.running = \{/)
    const awaited = body.indexOf('await ')
    expect(taken).toBeGreaterThan(-1)
    expect(awaited).toBeGreaterThan(-1)
    expect(taken).toBeLessThan(awaited)
  })

  it('locks on the whole console, not on the pressed button', () => {
    // Keyed by name, a second DIFFERENT action would sail through — which is
    // the refund/claim race, the more expensive of the two hazards.
    const body = bodyOf('runAction')
    expect(body).not.toMatch(/if \(state\.running(\?\.name)? === name\)/)
    expect(body).not.toMatch(/state\.running\[name\]/)
  })

  it('releases the lock on the failure path as well as the success one', () => {
    // `runAction`'s catch RETURNS early when a dialog is open, so a release
    // written as a line at the end of the body is skipped by exactly the case
    // that needs it most: a failed refund, dialog still up, operator waiting.
    // Latched, nothing moves again until a reload.
    const body = bodyOf('runAction')
    const finallyAt = body.indexOf('} finally {')
    expect(finallyAt).toBeGreaterThan(-1)
    expect(body.slice(finallyAt)).toMatch(/state\.running = null/)
  })

  it('re-renders after releasing, so the buttons come back live', () => {
    const body = bodyOf('runAction')
    expect(body.slice(body.indexOf('} finally {'))).toContain('render()')
  })

  it('starts unlocked', () => {
    // A `state` with no `running` key still reads falsy, so the lock would
    // work — but the initial render would differ from every later one, which
    // is how a first-load-only rendering bug gets in.
    expect(appSource).toMatch(/running: null/)
  })
})

describe('actButton — what the operator sees', () => {
  it('disables every action button while any action runs', () => {
    const body = bodyOf('actButton')
    expect(body).toMatch(/disabled: busy/)
    // `busy` is the console-wide fact; `mine` is only for the label.
    expect(body).toMatch(/const busy = Boolean\(state\.running\)/)
  })

  it('does not un-disable a button that was already disabled for its own reason', () => {
    // The confirm dialog's park button is disabled until a reason is typed. An
    // `||` keeps that; assigning `busy` alone would drop it and arm the button.
    expect(bodyOf('actButton')).toMatch(/disabled: busy \|\| attrs\.disabled === true/)
  })

  it('marks the one that is running, so the wait has a subject', () => {
    const body = bodyOf('actButton')
    expect(body).toMatch(/state\.running\?\.name === attrs\['data-action'\]/)
    expect(body).toContain("h('span.spinner')")
  })

  it('keeps the classes the caller asked for', () => {
    // `armedButton` passes `contrary`/`supported`, which is the colour that
    // tells a fund-moving action from a safe one. Overwriting `class` with
    // just the running flag would strip it.
    expect(bodyOf('actButton')).toMatch(/attrs\.class/)
  })
})

describe('coverage — no action button escapes the lock', () => {
  /**
   * The regression this exists for is not the guard being deleted; it is the
   * NEXT action button being added with a plain `h(...)`, which looks right,
   * renders right, and is live during someone else's refund.
   */
  it('routes every backend action through actButton', () => {
    const raw = [...appSource.matchAll(/\bh\(\s*'button[^']*'\s*,\s*\{[\s\S]{0,400}?\}/g)]
      .filter((m) => /runAction\(|armDialog\(/.test(m[0]))
      .map((m) => m[0].slice(0, 60))
    expect(raw).toEqual([])
  })

  it('covers the actions the incident was reported against', () => {
    // recheck, read payment, and the armed tier — the exact row of buttons the
    // operator described clicking through.
    for (const action of ['tick', 'read-payment', 'pool-plan', 'pool-mint']) {
      expect(appSource, action).toContain(`'data-action': '${action}'`)
    }
    // The armed ones are built from a list, so their attribute is the variable.
    expect(bodyOf('armedButton')).toMatch(/'data-action': name/)
  })

  it('gives the confirm dialog the same treatment', () => {
    // The one button that actually moves money, and the one most likely to be
    // clicked twice: it sits under a scrim with nothing else to look at.
    const dialog = bodyOf('confirmDialog')
    expect(dialog).toMatch(/actButton\(\s*'button\.act\.armed'/)
    expect(dialog).toContain("'data-action': d.name")
  })
})

/**
 * Taking the lock re-renders, and every stream tick re-renders too. When
 * `render` swapped in a new tree, the detail modal came back as a NEW node
 * scrolled to the top (1040 -> 0 on `read payment`, confirmed in a browser) and
 * the search box lost its caret. `render` now patches the live tree in place,
 * so the pane, its scroll and the focused field are the same nodes afterwards;
 * `morph.test.ts` runs that patch against a DOM.
 */
describe('render keeps the live tree', () => {
  it('patches the page instead of tearing it down', () => {
    const body = bodyOf('render')
    expect(body).toContain('morphChildren(root,')
    expect(body).not.toContain('clear(root)')
    expect(body).not.toContain('root.appendChild')
  })

  it('still renders the detail pane as the scrolling dialog', () => {
    expect(appSource).toContain("'div.dialog.detail'")
    expect(bodyOf('render')).toContain('detailDialog()')
  })
})

describe('the spinner is visible without motion', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../../packages/solver-app/src/admin/static/styles.css', import.meta.url)),
    'utf8',
  )

  it('has a rule for the spinner and for a disabled action', () => {
    expect(css).toContain('.spinner')
    expect(css).toMatch(/\.act:disabled/)
  })

  it('still shows the state under prefers-reduced-motion', () => {
    // A spinner that is only a rotation disappears entirely for anyone who has
    // asked for no animation — leaving them the still page this set out to fix.
    const at = css.indexOf('prefers-reduced-motion')
    expect(at).toBeGreaterThan(-1)
    expect(css.slice(at)).toMatch(/animation: none/)
    expect(css.slice(at)).toMatch(/border-right-color: currentColor/)
  })
})
