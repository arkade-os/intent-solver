/**
 * The console's confirm dialog, tested against the shipped expression.
 *
 * ## Why this file exists
 *
 * `confirmKind` was hardcoded in TWO places, and fixing only the server left the
 * bug intact. The client had the mirror image:
 *
 *     expects: definition?.confirmKind === 'literal:MINT' ? 'MINT' : body.id
 *
 * so an armed action with any other literal fell through to `body.id`, which is
 * `undefined` for anything wallet-level. The operator types the right word, the
 * comparison never matches, the button stays disabled — an action that is
 * correct on the server and unusable through the UI. Nothing caught it: the
 * server's own tests pass, and `static.test.ts` only proves the file is served.
 *
 * ## Why it evaluates the file instead of importing it
 *
 * `app.js` is a plain browser script with no build step and no exports — that is
 * a deliberate choice the module header defends, and not one to undo for a test.
 * So this pulls the actual `expects:` expression out of the shipped file and
 * evaluates it. A copy of the logic here would pass forever while the real line
 * drifted, which is exactly the failure being closed.
 *
 * If the expression is moved or renamed the extractor throws rather than
 * silently testing nothing.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { staticRoot } from '../../src/admin/static.js'

const APP = readFileSync(join(staticRoot(), 'app.js'), 'utf8')

/**
 * The shape an expression must have before this file will evaluate it.
 *
 * `new Function` on interpolated text is code injection whenever the text could
 * be hostile. Here it cannot be — the input is a file in this repository, read
 * from disk in a test process, and anyone able to edit it can already edit this
 * test. But "the input happens to be trustworthy today" is a property of the
 * situation rather than of the code, so the allowlist makes it a property of the
 * code: a single expression built from identifiers, member access, string
 * literals and a ternary. No semicolons, no arrows, no template literals, no
 * call syntax beyond the two string methods named. Comparison and boolean
 * operators ARE allowed: refusing them made a perfectly ordinary rewrite fail
 * with 'outside the allowlist' instead of failing the assertion it should.
 *
 * If the dialog ever needs an expression this refuses, that is the signal to
 * extract the mapping into a module both sides import rather than to widen this.
 */
const SAFE_EXPRESSION = /^[\w\s?.:'()[\]!=&|-]*$/
const FORBIDDEN = /=>|;|`|\bimport\b|\brequire\b|\bprocess\b|\beval\b|\bFunction\b|\bglobalThis\b/

/**
 * The shipped expression that decides what the operator must type.
 *
 * Bounded by its own key and the field that follows it in the same object
 * literal, so a match cannot run past the end of the expression.
 */
const expectsExpression = (): string => {
  const match = APP.match(/expects:\s*([\s\S]*?),\r?\n\s*typed:/)
  if (!match?.[1]) {
    throw new Error("the dialog's `expects` expression is gone or renamed — this test is measuring nothing")
  }
  const expression = match[1].trim()
  if (!SAFE_EXPRESSION.test(expression) || FORBIDDEN.test(expression)) {
    throw new Error(`refusing to evaluate an expression outside the allowlist: ${expression}`)
  }
  return expression
}

const expectedWordFor = (confirmKind: string | undefined, body: { id?: string }): unknown =>
  // eslint-disable-next-line no-new-func -- see SAFE_EXPRESSION above
  new Function('definition', 'body', `return (${expectsExpression()})`)({ confirmKind }, body)

describe('the confirm dialog asks for what the server will check', () => {
  it('extracts a real expression, so a rename cannot leave this vacuous', () => {
    expect(expectsExpression()).toMatch(/confirmKind/)
  })

  it.each([
    ['literal:MINT', 'MINT'],
    ['literal:FLOAT', 'FLOAT'],
  ])('asks for the word in %s', (confirmKind, word) => {
    expect(expectedWordFor(confirmKind, {})).toBe(word)
  })

  it('asks for the swap id when the action is scoped to one swap', () => {
    expect(expectedWordFor('swap-id', { id: 'swap-42' })).toBe('swap-42')
  })

  /**
   * The regression, stated as the property rather than as two examples.
   *
   * A literal this file has never heard of must still work, because the whole
   * defect was a UI that only knew one word. If this fails, someone has
   * reintroduced a name- or value-specific branch.
   */
  it.each(['literal:RECOVER', 'literal:DRAIN', 'literal:XYZZY'])(
    'handles %s without the UI having been told about it',
    (confirmKind) => {
      expect(expectedWordFor(confirmKind, {})).toBe(confirmKind.slice('literal:'.length))
    },
  )

  it('never falls back to an undefined id for a wallet-level action', () => {
    // The precise failure: `expects` becoming `undefined` means `typed === expects`
    // can only be satisfied by not typing, and the button is disabled until it is.
    // So an operator has no way to proceed.
    for (const confirmKind of ['literal:MINT', 'literal:FLOAT', 'literal:ANYTHING']) {
      expect(expectedWordFor(confirmKind, {})).not.toBeUndefined()
    }
  })
})
