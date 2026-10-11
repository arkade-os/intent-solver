import { afterEach, describe, expect, it, vi } from 'vitest'
import { RestArkProvider, Wallet } from '@arkade-os/sdk'
import { createArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { TimedArkProvider, TimedIndexerProvider } from '@arkade-os/solver-arkade/arkade/latencyProviders.js'

vi.mock('better-sqlite3', () => ({
  default: class {
    pragma() {}
  },
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('configured Arkade wallet provider', () => {
  it.each(['0', '1'])('keeps the configured server with latency diagnostics %s', async (diagnostics) => {
    vi.stubEnv('SOLVER_LATENCY_DIAGNOSTICS', diagnostics)
    const stopped = new Error('wallet configuration captured')
    const create = vi.spyOn(Wallet, 'create').mockRejectedValue(stopped)
    await expect(
      createArkadeContext({
        mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        arkServerUrl: 'http://configured-arkd.test:7070',
        databasePath: ':memory:',
        isMainnet: false,
        arkadeHrp: 'tark',
        expectedArkdNetwork: 'regtest',
      }),
    ).rejects.toBe(stopped)
    const config = create.mock.calls[0]![0]
    expect(config.arkProvider).toBeInstanceOf(RestArkProvider)
    expect((config.arkProvider as RestArkProvider).serverUrl).toBe('http://configured-arkd.test:7070')
    expect(config).not.toHaveProperty('arkServerUrl')
    if (diagnostics === '1') {
      expect(config.arkProvider).toBeInstanceOf(TimedArkProvider)
      expect(config.indexerProvider).toBeInstanceOf(TimedIndexerProvider)
    } else {
      expect(config.arkProvider).not.toBeInstanceOf(TimedArkProvider)
      expect(config.indexerProvider).toBeUndefined()
    }
  })
})
