/**
 * `solver.example.json` is the operator's checklist, and `solver-config.schema.json` what an editor
 * checks a document against. Both must stay true to the loader.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadConfig } from '@arkade-os/solver-app/config/load.js'
import { documentSchema, parseDocument } from '@arkade-os/solver-app/config/document.js'
import { PATHS } from '@arkade-os/solver-app/config/knobs.js'
import { configJsonSchema } from '../../scripts/gen-config-schema.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const read = (name: string): Record<string, any> => JSON.parse(readFileSync(join(root, name), 'utf8'))
const example = read('solver.example.json')
const at = (doc: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc)

// Exactly one of each pair may be set; the example shows the file form.
const ALTERNATIVES = new Set(['rails.lightning.lnd.cert', 'rails.lightning.lnd.macaroon'])
const SECRETS = [
  'rails.arkade.mnemonic',
  'rails.evm.arbitrum.privateKey',
  'notify.telegramBotToken',
  'notify.slackWebhookUrl',
  'sentry.dsn',
]

describe('solver.example.json', () => {
  it('is a well-formed document', () => {
    expect(() => parseDocument(example, [])).not.toThrow()
  })

  it('holds every setting the document knows', () => {
    const missing = PATHS.map(([path]) => path).filter(
      (path) => !ALTERNATIVES.has(path) && at(example, path) === undefined,
    )
    expect(missing).toEqual([])
  })

  it('ships every secret as an obvious placeholder', () => {
    for (const path of SECRETS) expect(at(example, path), path).toMatch(/^<.+>$/)
  })

  it('loads once its placeholders are swapped for regtest values', () => {
    const doc = structuredClone(example)
    doc.network = 'regtest'
    doc.rails.arkade.mnemonic = 'test mnemonic, never a real one'
    doc.rails.lightning.backend = 'fake'
    doc.rails.evm.arbitrum.privateKey = `0x${'22'.repeat(32)}`
    doc.sentry.dsn = 'https://key@o0.ingest.sentry.io/1'
    expect(loadConfig({ env: { SOLVER_CONFIG_JSON: JSON.stringify(doc) } }).network).toBe('regtest')
  })
})

describe('solver-config.schema.json', () => {
  it('is what the generator makes of the document schema today', () => {
    expect(read('solver-config.schema.json')).toEqual(configJsonSchema(documentSchema([])))
  })

  it('types a 256-bit amount as a decimal string', () => {
    const schema = read('solver-config.schema.json')
    expect(schema.properties.offers.properties.minFillAmount).toMatchObject({ type: 'string', pattern: '^\\d+$' })
  })
})
