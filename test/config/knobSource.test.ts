import { describe, it, expect, afterEach } from 'vitest'
import { arkDbPath, configFromKnobs, sentryOptionsFromKnobs, swapDbPath } from '@arkade-os/solver-app/config.js'
import { latencyDiagnosticsEnabled, setLatencyDiagnostics } from '@arkade-os/solver-core/util/diagnostics.js'
import { createServicesBody } from '../support/createServicesBody.js'

const minimalRegtestKnobs = {
  SWAP_NETWORK: 'regtest',
  ARK_MNEMONIC: 'test mnemonic, never a real one',
  ARK_SERVER_URL: 'http://localhost:7070',
  EMULATOR_URL: 'http://localhost:7073',
  LN_BACKEND: 'fake',
}

const savedNetwork = process.env.SWAP_NETWORK

afterEach(() => {
  if (savedNetwork === undefined) delete process.env.SWAP_NETWORK
  else process.env.SWAP_NETWORK = savedNetwork
  setLatencyDiagnostics(false)
})

describe('configFromKnobs', () => {
  it('reads only the knobs it is handed', () => {
    process.env.SWAP_NETWORK = 'bitcoin'
    const config = configFromKnobs({ ...minimalRegtestKnobs, SWAP_NETWORK: 'regtest' })
    expect(config.network).toBe('regtest')
  })

  it('carries the name and card relays that card.ts used to read itself', () => {
    const config = configFromKnobs({ ...minimalRegtestKnobs, SOLVER_NAME: 'x', SOLVER_CARD_RELAYS: 'wss://a, wss://b' })
    expect(config.solverName).toBe('x')
    expect(config.cardRelays).toEqual(['wss://a', 'wss://b'])
  })

  it('leaves the name null and the relays empty when unset', () => {
    const config = configFromKnobs(minimalRegtestKnobs)
    expect(config.solverName).toBeNull()
    expect(config.cardRelays).toEqual([])
  })

  it('turns latency diagnostics on only for 1', () => {
    expect(configFromKnobs(minimalRegtestKnobs).latencyDiagnostics).toBe(false)
    expect(configFromKnobs({ ...minimalRegtestKnobs, SOLVER_LATENCY_DIAGNOSTICS: '1' }).latencyDiagnostics).toBe(true)
  })

  it('loads the EVM chain with the rest of the config', () => {
    expect(configFromKnobs(minimalRegtestKnobs).evmChain).toBeNull()
    expect(() => configFromKnobs({ ...minimalRegtestKnobs, EVM_RPC_URL: 'http://localhost:8545' })).toThrow(
      /EVM_FASTEST_SECONDS_PER_BLOCK is not set/,
    )
  })

  it('resolves database paths and Sentry from the knobs too', () => {
    expect(swapDbPath({ DB_DIR: '/data' })).toMatch(/^[\\/]data[\\/]swaps\.sqlite$/)
    expect(arkDbPath({ ARK_DB_PATH: '/w/ark.sqlite' })).toBe('/w/ark.sqlite')
    expect(sentryOptionsFromKnobs({})).toBeNull()
  })
})

describe('latency diagnostics flag', () => {
  it('is off until set, and follows the setter', () => {
    expect(latencyDiagnosticsEnabled()).toBe(false)
    setLatencyDiagnostics(true)
    expect(latencyDiagnosticsEnabled()).toBe(true)
  })

  it('is set by createServices before anything that reads it is built', () => {
    const body = createServicesBody()
    const set = body.indexOf('setLatencyDiagnostics(config.latencyDiagnostics)')
    expect(set).toBeGreaterThan(-1)
    expect(set).toBeLessThan(body.indexOf('createArkadeContext('))
  })

  it('reads the EVM chain from the config rather than the environment', () => {
    expect(createServicesBody()).toContain('const evmChain = config.evmChain')
  })
})
