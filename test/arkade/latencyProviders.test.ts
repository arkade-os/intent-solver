import { afterEach, describe, expect, it, vi } from 'vitest'
import { RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk'
import {
  SharedSyncIndexerProvider,
  TimedArkProvider,
  TimedIndexerProvider,
  sendPhaseTimings,
  withProviderTimingScope,
} from '@arkade-os/solver-arkade/arkade/latencyProviders.js'
import { setLatencyDiagnostics } from '@arkade-os/solver-core/util/diagnostics.js'

afterEach(() => {
  vi.restoreAllMocks()
  setLatencyDiagnostics(false)
})

describe('latency providers', () => {
  it('forwards indexer queries and logs only counts and timings', async () => {
    const response = { vtxos: [] }
    const fetch = vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue(response)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const query = { scripts: ['sensitive-script'], pageIndex: 0, pageSize: 500 }

    setLatencyDiagnostics(true)
    await expect(
      withProviderTimingScope({ fundRef: 'swap-ref' }, () =>
        new TimedIndexerProvider('http://localhost').getVtxos(query),
      ),
    ).resolves.toBe(response)

    expect(fetch).toHaveBeenCalledWith(query)
    expect(output).toHaveBeenCalledWith(
      expect.any(String),
      'indexer_vtxos_timing',
      expect.stringContaining('"scripts":1'),
    )
    expect(output.mock.calls[0]?.join(' ')).not.toContain('sensitive-script')
    expect(output.mock.calls[0]?.join(' ')).toContain('"fundRef":"swap-ref"')
  })

  it('rethrows an ambiguous submit failure unchanged', async () => {
    const failure = new Error('submission response lost')
    vi.spyOn(RestArkProvider.prototype, 'submitTx').mockRejectedValue(failure)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const provider = new TimedArkProvider('http://localhost')

    setLatencyDiagnostics(true)
    await expect(
      withProviderTimingScope({ fundRef: 'swap-ref' }, () => provider.submitTx('signed-transaction', [])),
    ).rejects.toBe(failure)
    expect(output.mock.calls[0]?.join(' ')).toContain('"outcome":"failed"')
    expect(output.mock.calls[0]?.join(' ')).toContain('"fundRef":"swap-ref"')
  })

  it('times finalization and preserves the funding correlation across both network calls', async () => {
    vi.spyOn(RestArkProvider.prototype, 'submitTx').mockResolvedValue({
      arkTxid: 'tx',
      finalArkTx: 'signed',
      signedCheckpointTxs: [],
    })
    vi.spyOn(RestArkProvider.prototype, 'finalizeTx').mockResolvedValue(undefined)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const provider = new TimedArkProvider('http://localhost')
    const scope = { fundRef: 'swap-ref' }
    setLatencyDiagnostics(true)

    const started = performance.now()
    await withProviderTimingScope(scope, async () => {
      await provider.submitTx('signed-transaction', [])
      await provider.finalizeTx('tx', [])
    })
    const phases = sendPhaseTimings(scope, started, performance.now())

    expect(phases.submitMs).toBeGreaterThanOrEqual(0)
    expect(phases.finalizeMs).toBeGreaterThanOrEqual(0)
    expect(phases.afterFinalizeMs).toBeGreaterThanOrEqual(0)
    expect(output.mock.calls.some((call) => call.join(' ').includes('ark_finalize_timing'))).toBe(true)
    expect(output.mock.calls.at(-1)?.join(' ')).toContain('"fundRef":"swap-ref"')
  })
})

describe('SharedSyncIndexerProvider', () => {
  const sync = { scripts: ['a', 'b'], after: 1_792_057_682_680, pageIndex: 0, pageSize: 500 }

  it('sends ONE request for concurrent identical windowed reads, handing each caller its own copy', async () => {
    let answer!: (result: { vtxos: { txid: string }[] }) => void
    const fetch = vi
      .spyOn(RestIndexerProvider.prototype, 'getVtxos')
      .mockImplementation(() => new Promise((resolve) => (answer = resolve as typeof answer)))
    const provider = new SharedSyncIndexerProvider('http://localhost')

    const reads = Promise.all([1, 2, 3].map(() => provider.getVtxos(sync)))
    answer({ vtxos: [{ txid: 't' }] })
    const [first, second] = await reads
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)

    fetch.mockResolvedValueOnce({ vtxos: [] })
    await provider.getVtxos(sync)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('never shares an unwindowed read: an event-driven re-read must see what landed after it was asked', async () => {
    const fetch = vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: [] })
    const provider = new SharedSyncIndexerProvider('http://localhost')
    await Promise.all([1, 2].map(() => provider.getVtxos({ scripts: ['a'], spendableOnly: true })))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('logs one timing line per request it actually sends', async () => {
    vi.spyOn(RestIndexerProvider.prototype, 'getVtxos').mockResolvedValue({ vtxos: [] })
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const provider = new TimedIndexerProvider('http://localhost')
    await Promise.all([1, 2, 3].map(() => provider.getVtxos(sync)))
    expect(output.mock.calls.filter((call) => call.includes('indexer_vtxos_timing'))).toHaveLength(1)
  })
})
