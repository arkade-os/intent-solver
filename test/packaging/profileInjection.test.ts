import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdk from '@arkade-os/solver-app/index.js'
import { exportConfig } from '@arkade-os/solver-app/config/fromEnv.js'

const REFUSAL = 'this deployment serves no onchain receive'

// As a consumer running the shipped CLI does it: the CLI calls loadConfig itself, with no options.
sdk.registerConfigProfile((doc) => {
  if (doc.corridors?.['onchain:BTC->arkade:BTC']?.enabled === true) throw new Error(REFUSAL)
  return { ...doc, corridors: { ...doc.corridors, 'onchain:BTC->arkade:BTC': { enabled: false } } }
})

const document = (corridors: Record<string, unknown> = {}) => ({
  network: 'regtest',
  rails: {
    arkade: {
      mnemonic: 'test mnemonic, never a real one',
      serverUrl: 'http://localhost:7070',
      emulatorUrl: 'http://localhost:7073',
    },
    lightning: { backend: 'fake' },
  },
  corridors,
})
const load = (doc: unknown) => sdk.loadConfig({ env: { SOLVER_CONFIG_JSON: JSON.stringify(doc) } })

describe('a registered config profile', () => {
  it('reaches every loadConfig that passes none', () => {
    expect(load(document()).corridorEnabled['onchain:BTC->arkade:BTC']).toBe(false)
    expect(() => load(document({ 'onchain:BTC->arkade:BTC': { enabled: true } }))).toThrow(REFUSAL)
  })

  it('gives way to one passed explicitly', () => {
    const config = sdk.loadConfig({ env: { SOLVER_CONFIG_JSON: JSON.stringify(document()) }, profile: (doc) => doc })
    expect(config.corridorEnabled['onchain:BTC->arkade:BTC']).toBe(true)
  })

  it('checks what config-from-env exports', async () => {
    const env = {
      SWAP_NETWORK: 'regtest',
      ARK_MNEMONIC: 'test mnemonic, never a real one',
      ARK_SERVER_URL: 'http://localhost:7070',
      EMULATOR_URL: 'http://localhost:7073',
      LN_BACKEND: 'fake',
      DB_DIR: join(tmpdir(), 'profile-injection-absent'),
      ONCHAIN_RECEIVE_ENABLED: 'true',
    }
    await expect(exportConfig(env)).rejects.toThrow(REFUSAL)
  })

  it('is registered once', () => {
    expect(() => sdk.registerConfigProfile((doc) => doc)).toThrow('a config profile is already registered')
  })
})
