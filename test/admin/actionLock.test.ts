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

const appSource = readFileSync(fileURLToPath(new URL('../../src/admin/static/app.js', import.meta.url)), 'utf8')

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
    // The confirm dialog's `run it` is disabled until the operator has typed
    // the swap id. An `||` keeps that; assigning `busy` alone would drop it
    // and arm the one button that actually moves money.
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
 * Taking the lock re-renders, and `render` rebuilds the whole tree — so the
 * detail modal is a NEW node and its scroll resets to the top.
 *
 * Confirmed in a browser before this was written: with the modal scrolled to
 * its action row, clicking `read payment` moved scrollTop 1040 -> 0, and the
 * node identity check said the dialog had been replaced. The operator clicks a
 * button at the bottom of a long timeline and is thrown to the top — so they
 * cannot see the spinner that click was supposed to show them, and the result
 * lands off-screen too.
 *
 * The same rebuild already reset the modal at the END of every action, and on
 * every `swaps` event from the stream: that listener skips a reload while the
 * CONFIRM dialog is open but not while the detail modal is, so on a busy solver
 * a reader gets thrown to the top by an unrelated swap. Preserving the offset
 * in `render` fixes all three, which is why it goes there rather than in the
 * lock.
 */
describe('the detail modal keeps its place', () => {
  it('reads the scroll offset before tearing the tree down', () => {
    const body = bodyOf('render')
    const read = body.indexOf('scrollTop')
    expect(read).toBeGreaterThan(-1)
    expect(read).toBeLessThan(body.indexOf('clear(root)'))
  })

  it('restores it after the modal is back in the document', () => {
    // Assigning scrollTop to a detached node silently does nothing, so the
    // order here is half the fix.
    const body = bodyOf('render')
    const appended = body.indexOf('root.appendChild(detail)')
    expect(appended).toBeGreaterThan(-1)
    expect(body.indexOf('scrollTop', appended)).toBeGreaterThan(appended)
  })

  it('restores onto the scrolling pane, not the scrim around it', () => {
    // The other half, and the one that was shipped wrong: `detailDialog`
    // returns the SCRIM, and the scrim does not scroll. Assigning to it is a
    // silent no-op — every structural check above still passed while the modal
    // went on jumping to the top, which only rendering it caught.
    const restore = bodyOf('render').slice(bodyOf('render').indexOf('root.appendChild(detail)'))
    expect(restore).toContain("querySelector('.dialog.detail')")
    expect(restore).toMatch(/scrollTop = detailScroll/)
  })

  it('targets the detail modal specifically, not whichever dialog is first', () => {
    // The confirm dialog is a `.dialog` too, and both are in the document at
    // once while a refund is armed.
    expect(appSource).toContain("'div.dialog.detail'")
    expect(bodyOf('render')).toContain('.dialog.detail')
  })
})

describe('the spinner is visible without motion', () => {
  const css = readFileSync(fileURLToPath(new URL('../../src/admin/static/styles.css', import.meta.url)), 'utf8')

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

/**
 * The search box re-renders while the operator is still typing.
 *
 * `render` rebuilds the whole tree, so the input that comes back is a NEW node
 * with no focus and a caret at zero. Confirmed in a browser before this was
 * written: typing into the search field and pausing moved `document.activeElement`
 * to `body` and `selectionStart` to 0. The value survives, because it lives in
 * `state.filters.q` — so the field looks fine and simply stops accepting input,
 * which is worse than losing the text.
 *
 * It is the same fault as the detail modal's scroll, and it has the same fix:
 * read the state before the teardown, put it back once the node is in the
 * document.
 */
describe('the search box survives its own re-render', () => {
  const renderBody = () => bodyOf('render')

  it('reads focus and selection before tearing the tree down', () => {
    const body = renderBody()
    const read = body.search(/selectionStart/)
    expect(read).toBeGreaterThan(-1)
    expect(read).toBeLessThan(body.indexOf('clear(root)'))
  })

  it('restores focus after the tree is rebuilt', () => {
    const body = renderBody()
    const cleared = body.indexOf('clear(root)')
    expect(body.indexOf('.focus()', cleared)).toBeGreaterThan(cleared)
  })

  it('puts the caret back where it was, not at the end', () => {
    // Editing the middle of a pasted hash otherwise jumps the cursor on every
    // debounce, which is the same bug wearing a different hat.
    expect(renderBody()).toContain('setSelectionRange')
  })
})
