import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { LOG_RANGE_REJECTIONS, probeLogScanRange } from '@arkade-os/solver-rails-evm/evm/logScanProbe.js'
import type { JsonRpc } from '@arkade-os/solver-core/ports/evm.js'

const CONTRACT = hex.decode('4444444444444444444444444444444444444444')
const TIP = '0x2710' // 10_000

const probeWith = (onGetLogs: () => unknown, tip: unknown = TIP) => {
  const calls: { method: string; params: readonly unknown[] }[] = []
  const rpc: JsonRpc = async (method, params) => {
    calls.push({ method, params })
    if (method === 'eth_blockNumber') return tip
    if (method === 'eth_getLogs') return onGetLogs()
    throw new Error(`unexpected RPC ${method}`)
  }
  return { rpc, calls }
}

const run = (onGetLogs: () => unknown, logScanRange = 1_000, tip: unknown = TIP) => {
  const { rpc, calls } = probeWith(onGetLogs, tip)
  return { result: probeLogScanRange({ rpc, contractAddress: CONTRACT, logScanRange }), calls }
}

describe('the probe asks a real question', () => {
  it('requests exactly the configured width, ending at the tip', async () => {
    const { result, calls } = run(() => [], 1_000)
    await result
    const filter = calls.find((c) => c.method === 'eth_getLogs')!.params[0] as Record<string, string>
    expect(BigInt(filter.toBlock!)).toBe(10_000n)
    expect(BigInt(filter.toBlock!) - BigInt(filter.fromBlock!) + 1n).toBe(1_000n)
  })

  it('filters on a topic no event can carry, so a result-count cap cannot answer a range question', async () => {
    const { result, calls } = run(() => [])
    await result
    const filter = calls.find((c) => c.method === 'eth_getLogs')!.params[0] as { topics: string[] }
    expect(filter.topics[0]).toBe(`0x${'00'.repeat(32)}`)
  })

  it('reports a served request, and how wide it actually was', async () => {
    await expect(run(() => [], 1_000).result).resolves.toEqual({ kind: 'ok', blocks: 1_000n })
  })

  it('cannot ask the full question on a chain shorter than the range', async () => {
    await expect(run(() => [], 5_000, '0x27').result).resolves.toEqual({ kind: 'ok', blocks: 40n })
  })
})

describe('a range rejection is fatal; anything else is not', () => {
  it('names every published phrasing as a range rejection', async () => {
    // The loop iterates the data under test; empty would pass vacuously.
    expect(LOG_RANGE_REJECTIONS.length).toBeGreaterThan(0)
    for (const phrase of LOG_RANGE_REJECTIONS) {
      const { result } = run(() => {
        throw new Error(`eth_getLogs: JSON-RPC error -32602 ${phrase}`)
      })
      await expect(result, phrase).resolves.toMatchObject({ kind: 'range_rejected' })
    }
  })

  it('classifies real provider wordings, stated here rather than read from the set', async () => {
    // Independent of the set: a test fed by the data it checks cannot notice
    // the data being wrong.
    const wordings = [
      'eth_getLogs: JSON-RPC error -32602 You can make eth_getLogs requests with up to a 10K block range',
      'eth_getLogs: JSON-RPC error -32005 query exceeds max block range 100000',
      'eth_getLogs: JSON-RPC error -32000 block range is too large, max is 2000',
      'eth_getLogs: JSON-RPC error -32602 eth_getLogs is limited to 10000 blocks',
    ]
    for (const wording of wordings) {
      const { result } = run(() => {
        throw new Error(wording)
      })
      await expect(result, wording).resolves.toMatchObject({ kind: 'range_rejected' })
    }
  })

  it('matches the phrasing whatever case the provider used', async () => {
    const { result } = run(() => {
      throw new Error('Block Range Is Too Large: please use a smaller range')
    })
    await expect(result).resolves.toMatchObject({ kind: 'range_rejected' })
  })

  it('treats a transport failure as inconclusive rather than as a verdict', async () => {
    for (const blip of ['fetch failed', 'HTTP 503 Service Unavailable', 'The operation was aborted', 'ECONNREFUSED']) {
      const { result } = run(() => {
        throw new Error(blip)
      })
      await expect(result, blip).resolves.toMatchObject({ kind: 'inconclusive' })
    }
  })

  it('does not read a rate limit as a range rejection', async () => {
    const { result } = run(() => {
      throw new Error('eth_getLogs: JSON-RPC error -32005 request rate limit exceeded')
    })
    await expect(result).resolves.toMatchObject({ kind: 'inconclusive' })
  })

  it('does not read a result-count cap as a range rejection', async () => {
    const { result } = run(() => {
      throw new Error('eth_getLogs: query returned more than 10000 results')
    })
    await expect(result).resolves.toMatchObject({ kind: 'inconclusive' })
  })

  it('is inconclusive when the tip itself cannot be read', async () => {
    await expect(run(() => [], 1_000, null).result).resolves.toMatchObject({ kind: 'inconclusive' })
  })

  it('never asks for logs when the tip is unreadable', async () => {
    const { result, calls } = run(() => [], 1_000, 'not-a-quantity')
    await result
    expect(calls.filter((c) => c.method === 'eth_getLogs')).toHaveLength(0)
  })
})
