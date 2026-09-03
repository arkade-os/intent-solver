/**
 * What the markets screen says, read from its source.
 *
 * `app.js` is a browser module with no exports and there is no DOM here, so this
 * reads the file — the approach `armedActions.test.ts` and `quotesView.test.ts`
 * already take, and for the same reason.
 *
 * The claims worth pinning are the honest ones. A console that shows a market as
 * configured and lets an operator read that as "we are trading it" is the
 * failure this screen most easily produces: nothing here reaches a running
 * solver, and a market added since boot cannot be filled against.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const appSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
  'utf8',
)

/**
 * The whole delimited markets block, both markers included.
 *
 * Bounded at both ends deliberately. A slice to end-of-file would let an
 * assertion be satisfied by unrelated code further down, which is how a guard
 * goes green while the thing it names is gone.
 */
const marketsBlock = (): string => {
  const start = appSource.indexOf('/* ==== asset markets — BEGIN')
  const end = appSource.indexOf('/* ==== asset markets — END')
  if (start === -1 || end === -1) throw new Error('the asset markets block is gone from app.js')
  return appSource.slice(start, end)
}

describe('the markets screen is reachable', () => {
  it('is in the nav, the endpoint table and the view table', () => {
    // All three, because two of the three renders a dead tab: a nav entry with
    // no body falls through to the overview and looks like a broken link.
    expect(appSource).toContain("['markets', 'markets']")
    expect(appSource).toContain("markets: () => '/api/markets'")
    expect(appSource).toContain('markets: marketsView')
  })

  it('is exempt from the swap-event reload, like settings', () => {
    // A rebuild mid-typing hands back an input with no focus and a caret at
    // zero — the field looks fine and silently stops accepting characters,
    // which is worse than losing the text.
    expect(appSource).toContain("state.view !== 'markets'")
  })
})

describe('the screen does not let a stored market read as a live one', () => {
  it('shows the restart notice the API sends, standing rather than conditional', () => {
    expect(marketsBlock()).toContain('m.restartNotice')
  })

  it('distinguishes trading from pending restart, using the API’s active list', () => {
    const block = marketsBlock()
    expect(block).toContain('new Set(m.active)')
    expect(block).toMatch(/pending restart/)
    expect(block).toMatch(/trading/)
  })

  it('says what an empty list means, rather than showing a bare "none"', () => {
    // An empty markets table means this solver refuses every offer. Read as
    // "nothing configured yet" it looks like a setup step; read correctly it is
    // the current trading posture.
    expect(marketsBlock()).toMatch(/refuses every offer/)
  })
})

describe('the form does not fight the operator', () => {
  it('keeps the draft outside `state`, so typing does not re-render the console', () => {
    expect(marketsBlock()).toContain('let marketDraft = null')
  })

  it('writes each keystroke to the draft without rendering', () => {
    // `oninput` must not call render(): the input it typed into would be
    // replaced by a new node on every character.
    //
    // Bounded by the declaration that FOLLOWS, not by a brace — an unbounded
    // slice would run to the end of the block and pick up the edit button's
    // legitimate render(), which is how this assertion first went green for the
    // wrong reason.
    const block = marketsBlock()
    const start = block.indexOf('const field =')
    const end = block.indexOf('const saveMarket')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(block.slice(start, end)).not.toContain('render()')
  })

  it('leaves the form open when a write is refused', () => {
    // Every refusal names one field. Closing the form would make the operator
    // retype the other ten to fix it.
    const save = marketsBlock().slice(marketsBlock().indexOf('const saveMarket'))
    const body = save.slice(0, save.indexOf('\n}'))
    const failBranch = body.slice(body.indexOf('catch'))
    expect(failBranch).not.toContain('marketDraft = null')
  })
})

describe('the form speaks the API’s dialect', () => {
  it('sends bounds as strings and the small integers as numbers', () => {
    // An atomic-unit bound is a bigint; a JSON number would lose a ceiling past
    // 2^53 silently, and in the direction that widens it.
    const block = marketsBlock()
    expect(block).toContain('toleranceBps: Number(d.toleranceBps)')
    expect(block).toContain('sellBase: draftBounds(d.sellBaseMin, d.sellBaseMax)')
    expect(block).toMatch(/min: min\.trim\(\), max: max\.trim\(\)/)
  })

  it('omits a bound entirely unless both halves are filled', () => {
    // The server rejects a half-stated bound, so sending one would turn a blank
    // field into an error banner.
    expect(marketsBlock()).toContain("min.trim() === '' && max.trim() === '' ? null")
  })

  it('encodes the market key into the delete path', () => {
    // The key carries `/` and `:`; unencoded it would address a different route.
    expect(marketsBlock()).toContain('encodeURIComponent(key)')
  })
})
