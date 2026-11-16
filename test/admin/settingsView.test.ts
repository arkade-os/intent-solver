/**
 * The settings screen names each knob where the operator writes it: its path in
 * the config document. Read from source, as the other `app.js` views are.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const appSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
  'utf8',
)

const settingsView = (): string => {
  const start = appSource.indexOf('const settingsView = () => {')
  const end = appSource.indexOf('/* ==== asset markets — BEGIN')
  if (start === -1 || end === -1 || end < start) throw new Error('the settings view is gone from app.js')
  return appSource.slice(start, end)
}

describe('the settings screen', () => {
  it('labels a knob by its config path, with the setting id on hover', () => {
    expect(settingsView()).toContain("h('td', { title: knob.key }, knob.path ?? knob.key)")
  })

  it('calls a value the console did not set config, not env', () => {
    expect(settingsView()).toContain("h('span.faint', 'config')")
    expect(settingsView()).not.toContain("'env'")
  })
})

describe('no screen tells the operator to edit the environment', () => {
  it.each([
    'OFFER_MARKETS is unset',
    'in the environment',
    'use environment value',
    'environment only',
    'ADMIN_RESTART_ENABLED',
    '_ENABLED in the',
    "'Use env'",
    'NOSTR_AD_PUBLISH is off',
    'follows ASSET_CARRIER_PRICING',
    "'ASSET_CARRIER_PRICING, deployment-wide",
  ])('%s', (phrase) => {
    expect(appSource).not.toContain(phrase)
  })

  it('names a setting waiting for a restart by its config path', () => {
    expect(appSource).toMatch(
      /const pendingItem = \(item\) =>\s*h\('span\.mono', \{ title: item\.key \}, item\.path \?\? item\.key/,
    )
  })
})
