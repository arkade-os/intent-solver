/**
 * The console's palette, held to WCAG AA.
 *
 * This exists because "looks readable to me" is not a check. The console is read
 * by a tired operator deciding whether a swap paid out, and the two tokens that
 * failed when this was first measured were the worst possible two: `--text-faint`
 * (the JSON row dump and the timeline — small monospace) at 3.16:1, and
 * `--failed` (the FAILURE colour) at 4.40:1 on the page and 3.85:1 on its own
 * chip. Both under the 4.5:1 AA floor for body text.
 *
 * Two halves, deliberately:
 *
 *   - the VALUES are parsed out of `styles.css`, so a token cannot be retuned
 *     without this noticing;
 *   - the PAIRS are declared here, because CSS cannot tell you which foreground
 *     is composed over which background. The list below is therefore a written
 *     statement of what the console actually renders, and adding a pair to it is
 *     how you say "this combination now appears on screen".
 *
 * It also holds LIGHT mode to the same bar as dark, which matters more than it
 * sounds: whoever adds a theme cannot see both at once, so the bar has to be
 * mechanical rather than visual.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/admin/static/styles.css', import.meta.url)),
  'utf8',
)

/** Relative luminance, per WCAG 2.1. */
const luminance = (hex: string): number => {
  const clean = hex.replace('#', '')
  const channels = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255)
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** Every `--token: #hex` inside the block a selector opens. */
const tokensIn = (selector: string): Record<string, string> => {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`no ${selector} block in styles.css`)
  const block = css.slice(start, css.indexOf('}', start))
  const tokens: Record<string, string> = {}
  for (const [, name, value] of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[name!] = value!
  }
  return tokens
}

/**
 * What the console composes over what.
 *
 * `ground` is the page, `raised` is a card or dialog. A token appearing against
 * both is listed twice, because clearing AA on the darker one says nothing about
 * the lighter one.
 */
const PAIRS: readonly (readonly [fg: string, bg: string, where: string])[] = [
  ['text', 'ground', 'body copy'],
  ['text', 'raised', 'body copy in a card'],
  ['text-dim', 'ground', 'secondary labels'],
  ['text-dim', 'raised', 'secondary labels in a card'],
  ['text-faint', 'ground', 'the raw row JSON and timeline cells'],
  ['text-faint', 'raised', 'the same inside the detail dialog'],
  ['failed', 'ground', 'failure text'],
  ['failed', 'failed-bg', 'the failed chip'],
  ['exposed', 'ground', 'exposed text'],
  ['exposed', 'exposed-bg', 'the exposed chip'],
  ['focus', 'ground', 'focus ring against the page'],
]

const AA = 4.5

describe.each([
  ['dark', ':root {'],
  ['light', "[data-theme='light'] {"],
])('%s palette', (theme, selector) => {
  const tokens = tokensIn(selector)

  it('defines every token the console renders', () => {
    const needed = new Set(PAIRS.flatMap(([fg, bg]) => [fg, bg]))
    for (const name of needed) {
      expect(tokens[name], `${theme} is missing --${name}`).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it.each(PAIRS)('reads at AA: --%s on --%s (%s)', (fg, bg, where) => {
    const ratio = contrast(tokens[fg]!, tokens[bg]!)
    expect(
      ratio,
      `--${fg} on --${bg} (${where}) is ${ratio.toFixed(2)}:1 in ${theme}, under the ${AA}:1 AA floor`,
    ).toBeGreaterThanOrEqual(AA)
  })
})

describe('the two themes stay distinct', () => {
  it('inverts the page rather than shipping the same palette twice', () => {
    // Cheap sanity check on a copy-paste: a light theme whose ground is still
    // near-black would pass every contrast assertion above and be useless.
    const dark = tokensIn(':root {')
    const light = tokensIn("[data-theme='light'] {")
    expect(luminance(light['ground']!)).toBeGreaterThan(luminance(dark['ground']!))
    expect(luminance(light['text']!)).toBeLessThan(luminance(dark['text']!))
  })
})
