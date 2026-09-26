import { afterEach, describe, expect, it, vi } from 'vitest'
import { RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk'
import {
  TimedArkProvider,
  TimedIndexerProvider,
  withProviderTimingScope,
} from '@arkade-os/solver-arkade/arkade/latencyProviders.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('latency providers', () => {
  it('forwards indexer queries and logs only counts and timings', async () => {
    const response = { vtxos: [] }
    const fetch = vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue(response)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const query = { scripts: ['sensitive-script'], pageIndex: 0, pageSize: 500 }

    vi.stubEnv('SOLVER_LATENCY_DIAGNOSTICS', '1')
    await expect(
      withProviderTimingScope('swap-ref', () => new TimedIndexerProvider('http://localhost').getVtxos(query)),
    ).resolves.toBe(response)

    expect(fetch).toHaveBeenCalledWith(query)
    expect(output).toHaveBeenCalledWith(
      expect.any(String),
      'indexer_vtxos_timing',
      expect.stringContaining('"scripts":1'),
    )
    expect(output.mock.calls[0]?.join(' ')).not.toContain('sensitive-script')
    expect(output.mock.calls[0]?.join(' ')).toContain('"scope":"swap-ref"')
  })

  it('rethrows an ambiguous submit failure unchanged', async () => {
    const failure = new Error('submission response lost')
    vi.spyOn(RestArkProvider.prototype, 'submitTx').mockRejectedValue(failure)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const provider = new TimedArkProvider('http://localhost')

    vi.stubEnv('SOLVER_LATENCY_DIAGNOSTICS', '1')
    await expect(withProviderTimingScope('swap-ref', () => provider.submitTx('signed-transaction', []))).rejects.toBe(
      failure,
    )
    expect(output.mock.calls[0]?.join(' ')).toContain('"outcome":"failed"')
    expect(output.mock.calls[0]?.join(' ')).toContain('"scope":"swap-ref"')
  })
})
