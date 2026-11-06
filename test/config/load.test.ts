import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { swapDbPath } from '@arkade-os/solver-app/config.js'
import {
  loadConfig,
  loadKnobsForInspection,
  loadSentryOptions,
  NoConfigDocument,
} from '@arkade-os/solver-app/config/load.js'
import type { SolverDocument } from '@arkade-os/solver-app/config/document.js'

const minimalDoc = {
  network: 'regtest',
  rails: {
    arkade: {
      mnemonic: 'test mnemonic, never a real one',
      operatorUrl: 'http://localhost:7070',
      emulatorUrl: 'http://localhost:7073',
    },
    lightning: { backend: 'fake' },
  },
}

const inline = (doc: unknown, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  SOLVER_CONFIG_JSON: JSON.stringify(doc),
  ...extra,
})

const errorOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    return String(error)
  }
  throw new Error('expected a throw')
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempFile = (content: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'solver-config-'))
  dirs.push(dir)
  const path = join(dir, 'solver.json')
  writeFileSync(path, content)
  return path
}

describe('loadConfig — where the document comes from', () => {
  it('refuses both sources', () => {
    expect(() => loadConfig({ env: { SOLVER_CONFIG: '/x.json', SOLVER_CONFIG_JSON: '{}' } })).toThrow(
      'set only one of SOLVER_CONFIG or SOLVER_CONFIG_JSON',
    )
  })

  it('refuses neither source, and says how to get one', () => {
    expect(() => loadConfig({ env: {} })).toThrow(/set SOLVER_CONFIG .*config-from-env/)
    expect(() => loadConfig({ env: {} })).toThrow(NoConfigDocument)
  })

  it('reports invalid JSON by position and never echoes content', () => {
    const env = { SOLVER_CONFIG_JSON: '{"rails":{"arkade":{"mnemonic":"seed words here"}},' }
    const message = errorOf(() => loadConfig({ env }))
    expect(message).toMatch(/SOLVER_CONFIG_JSON: invalid JSON at position \d+/)
    expect(message).not.toContain('seed words')
  })

  it('refuses a key repeated in one object, naming it, where JSON.parse would keep only the last', () => {
    const env = {
      SOLVER_CONFIG_JSON:
        '{"admin":{"allowedHosts":["solver.example.com"]},"rails":{"arkade":{"mnemonic":"seed words"}},' +
        '"admin":{"port":8788}}',
    }
    const message = errorOf(() => loadConfig({ env }))
    expect(message).toContain('SOLVER_CONFIG_JSON: key "admin" appears more than once')
    expect(message).not.toContain('seed words')
  })

  it('reads the same key in sibling objects as no repeat', () => {
    const doc = { ...minimalDoc, admin: { port: 8788 }, corridors: { a: { enabled: true }, b: { enabled: false } } }
    expect(() => loadConfig({ env: inline(doc) })).not.toThrow(/more than once/)
  })

  it('never echoes content when the parser would quote it either', () => {
    expect(errorOf(() => loadConfig({ env: { SOLVER_CONFIG_JSON: 'seed words here' } }))).not.toContain('seed')
  })

  it('loads a file path', () => {
    const config = loadConfig({ env: { SOLVER_CONFIG: tempFile(JSON.stringify(minimalDoc)) } })
    expect(config.network).toBe('regtest')
  })

  it('reads a file an editor saved with a byte-order mark', () => {
    const config = loadConfig({ env: { SOLVER_CONFIG: tempFile(`﻿${JSON.stringify(minimalDoc)}`) } })
    expect(config.network).toBe('regtest')
  })

  it('names the file it could not read', () => {
    expect(() => loadConfig({ env: { SOLVER_CONFIG: '/no/such/solver.json' } })).toThrow(
      /SOLVER_CONFIG \/no\/such\/solver\.json: cannot be read/,
    )
  })
})

describe('loadConfig — the old environment', () => {
  it('refuses a lingering legacy variable, naming it', () => {
    expect(() => loadConfig({ env: inline(minimalDoc, { LN_SEND_FEE_BPS: '5', ARK_MNEMONIC: 'x' }) })).toThrow(
      /legacy environment variables are set and would be ignored: ARK_MNEMONIC, LN_SEND_FEE_BPS/,
    )
  })

  it('refuses a legacy variable built from a token symbol', () => {
    expect(() => loadConfig({ env: inline(minimalDoc, { EVM_SEND_USDC_MAX_SATS: '5' }) })).toThrow(
      'EVM_SEND_USDC_MAX_SATS',
    )
  })

  it('ignores a platform PORT/HOST', () => {
    const config = loadConfig({ env: inline(minimalDoc, { PORT: '3000', HOST: '0.0.0.0' }) })
    expect(config.port).toBe(8787)
    expect(config.host).toBe('127.0.0.1')
  })

  it('leaves the variables Kubernetes derives from a service name alone', () => {
    const links = {
      LND_SERVICE_HOST: '10.0.0.5',
      LND_PORT: 'tcp://10.0.0.5:10009',
      LND_PORT_10009_TCP_PORT: '10009',
      EVM_RPC_SERVICE_HOST: '10.0.0.6',
      EVM_RPC_SERVICE_PORT_HTTP: '8545',
      EVM_RPC_PORT: 'tcp://10.0.0.6:8545',
      EVM_RPC_PORT_8545_TCP_ADDR: '10.0.0.6',
      ASSET_FEED_SERVICE_PORT: '80',
    }
    expect(() => loadConfig({ env: inline(minimalDoc, links) })).not.toThrow()
    expect(() => loadConfig({ env: inline(minimalDoc, { LND_SOCKET: 'lnd:10009' }) })).toThrow(/LND_SOCKET/)
  })

  it('refuses, all at once, every credential the boot printout named and nobody put back', () => {
    const arkade = { ...minimalDoc.rails.arkade, mnemonic: '<ARK_MNEMONIC>' }
    const notify = { telegramBotToken: '<TELEGRAM_BOT_TOKEN>', slackWebhookUrl: '<ARK_MNEMONIC>' }
    expect(() =>
      loadConfig({ env: inline({ ...minimalDoc, rails: { ...minimalDoc.rails, arkade }, notify }) }),
    ).toThrow(
      "the config document still holds <ARK_MNEMONIC>, <TELEGRAM_BOT_TOKEN>: put each variable's value in its place",
    )
  })

  it('leaves the test harness and runtime variables alone', () => {
    expect(() =>
      loadConfig({ env: inline(minimalDoc, { PAYEE_MNEMONIC: 'x', NODE_ENV: 'test', CI: '1' }) }),
    ).not.toThrow()
  })
})

describe('loadConfig — the document', () => {
  it('disables BTC corridors absent from an asset-only document', () => {
    const DEPIX = '11'.repeat(34)
    const doc = {
      network: 'regtest',
      rails: { arkade: minimalDoc.rails.arkade },
      assets: { DEPIX: { kind: 'arkade', assetId: DEPIX } },
      corridors: {
        'arkade:BTC->DEPIX': { enabled: true },
        'DEPIX->arkade:BTC': { enabled: true },
      },
    }
    const config = loadConfig({ env: inline(doc) })
    expect(config.lnBackend).toBeNull()
    expect(config.corridorEnabled).toMatchObject({
      'arkade:BTC->lightning:BTC': false,
      'lightning:BTC->arkade:BTC': false,
      'arkade:BTC->onchain:BTC': false,
    })
    expect(config.assetRfqTokens[0]!.enabled).toEqual({ clientGivesAsset: true, clientGetsAsset: true })
  })

  it('enables a BTC corridor whose block is present without an explicit enabled value', () => {
    const doc = {
      ...minimalDoc,
      corridors: { 'arkade:BTC->lightning:BTC': {} },
    }
    const config = loadConfig({ env: inline(doc) })
    expect(config.corridorEnabled).toMatchObject({
      'arkade:BTC->lightning:BTC': true,
      'lightning:BTC->arkade:BTC': false,
      'arkade:BTC->onchain:BTC': false,
    })
  })

  it('names BTC corridor paths when a present corridor needs the omitted backend', () => {
    const doc = {
      network: 'regtest',
      rails: { arkade: minimalDoc.rails.arkade },
      corridors: { 'arkade:BTC->lightning:BTC': {} },
    }
    const message = errorOf(() => loadConfig({ env: inline(doc) }))
    expect(message).toContain('rails.lightning.backend must be set')
    expect(message).toContain('corridors["arkade:BTC->lightning:BTC"].enabled')
    expect(message).toContain('corridors["lightning:BTC->arkade:BTC"].enabled')
    expect(message).toContain('corridors["arkade:BTC->onchain:BTC"].enabled')
    expect(message).not.toMatch(/LN_BACKEND|<STEM>|_ENABLED/)
  })

  it('names the JSON path in a validation error', () => {
    const doc = { ...minimalDoc, corridors: { 'arkade:BTC->lightning:BTC': { feeBps: 10000 } } }
    expect(() => loadConfig({ env: inline(doc) })).toThrow(
      'corridors["arkade:BTC->lightning:BTC"].feeBps must be an integer between 0 and 9999, got 10000',
    )
  })

  it('names the JSON path of a missing requirement', () => {
    const doc = {
      ...minimalDoc,
      rails: { ...minimalDoc.rails, arkade: { operatorUrl: 'http://x', emulatorUrl: 'http://y' } },
    }
    expect(() => loadConfig({ env: inline(doc) })).toThrow('rails.arkade.mnemonic is not set')
  })

  it('applies the profile before validation', () => {
    const profile = (doc: SolverDocument): SolverDocument => ({
      ...doc,
      corridors: { ...doc.corridors, 'lightning:BTC->arkade:BTC': { enabled: false } },
    })
    expect(loadConfig({ env: inline(minimalDoc), profile }).corridorEnabled['lightning:BTC->arkade:BTC']).toBe(false)
  })

  it('checks what the profile returns as it checks the file', () => {
    const profile = (doc: SolverDocument): SolverDocument => ({ ...doc, relay: { urll: 'wss://x' } }) as SolverDocument
    expect(() => loadConfig({ env: inline(minimalDoc), profile })).toThrow('relay.urll: unknown key')
  })

  it('carries where each setting lives', () => {
    expect(loadConfig({ env: inline(minimalDoc) }).configPaths.get('LN_SEND_FEE_BPS')).toBe(
      'corridors["arkade:BTC->lightning:BTC"].feeBps',
    )
  })
})

describe('loadKnobsForInspection', () => {
  it('needs no mnemonic, and no refusal of the old environment', () => {
    const env = inline({ network: 'regtest' }, { ARK_MNEMONIC: 'still here mid-migration' })
    expect(swapDbPath(loadKnobsForInspection(env))).toBe(join('.data', 'swaps.sqlite'))
  })

  it('still reads the storage the document names', () => {
    expect(swapDbPath(loadKnobsForInspection(inline({ storage: { dir: 'vol' } })))).toBe(join('vol', 'swaps.sqlite'))
  })
})

describe('loadSentryOptions', () => {
  it('refuses a malformed DSN under its path', () => {
    expect(() => loadSentryOptions(inline({ sentry: { dsn: 'not a url' } }))).toThrow(/^sentry\.dsn is not a URL$/)
  })

  it('is off, not refused, before any document exists', () => {
    expect(loadSentryOptions({})).toBeNull()
  })

  it('still reports a document that is wrong somewhere else', () => {
    const doc = { sentry: { dsn: 'https://key@o1.ingest.sentry.io/42' }, corridors: { x: { feeBsp: 1 } } }
    expect(loadSentryOptions(inline(doc))?.dsn.publicKey).toBe('key')
  })
})
