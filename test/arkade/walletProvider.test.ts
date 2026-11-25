import { afterEach, describe, expect, it, vi } from 'vitest'
import { RestArkProvider, Wallet } from '@arkade-os/sdk'
import { SQLiteBatchRegistrationRepository } from '@arkade-os/sdk/repositories/sqlite'
import { createArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { setLatencyDiagnostics } from '@arkade-os/solver-core/util/diagnostics.js'
import {
  SharedSyncIndexerProvider,
  TimedArkadeProvider,
  TimedIndexerProvider,
} from '@arkade-os/solver-arkade/arkade/latencyProviders.js'

vi.mock('better-sqlite3', () => ({
  default: class {
    pragma() {}
  },
}))

afterEach(() => {
  setLatencyDiagnostics(false)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('configured Arkade wallet provider', () => {
  it.each(['0', '1'])('keeps the configured server with latency diagnostics %s', async (diagnostics) => {
    setLatencyDiagnostics(diagnostics === '1')
    const stopped = new Error('wallet configuration captured')
    const create = vi.spyOn(Wallet, 'create').mockRejectedValue(stopped)
    await expect(
      createArkadeContext({
        mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        operatorUrl: 'http://configured-arkd.test:7070',
        databasePath: ':memory:',
        isMainnet: false,
        arkadeHrp: 'tark',
        expectedArkdNetwork: 'regtest',
      }),
    ).rejects.toBe(stopped)
    const config = create.mock.calls[0]![0]
    expect(config.storage?.intentRepository).toBeInstanceOf(SQLiteBatchRegistrationRepository)
    expect(config.arkProvider).toBeInstanceOf(RestArkProvider)
    expect((config.arkProvider as RestArkProvider).serverUrl).toBe('http://configured-arkd.test:7070')
    expect(config).not.toHaveProperty('operatorUrl')
    if (diagnostics === '1') {
      expect(config.arkProvider).toBeInstanceOf(TimedArkadeProvider)
      expect(config.indexerProvider).toBeInstanceOf(TimedIndexerProvider)
    } else {
      expect(config.arkProvider).not.toBeInstanceOf(TimedArkadeProvider)
      expect(config.indexerProvider).toBeInstanceOf(SharedSyncIndexerProvider)
    }
  })
})
