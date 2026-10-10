import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { assertEvmClaimTraceSupport } from '@arkade-os/solver-rails-evm/evm/claimTraceProbe.js'
import type { JsonRpc } from '@arkade-os/solver-core/ports/evm.js'

const address = (value: string) => `0x${value.repeat(40)}`
const hash = (value: string) => `0x${value.repeat(64)}`
const bytes = (value: string) => hex.decode(value.slice(2))
const emitter = bytes(address('4'))

const fixture = () => {
  const log = {
    address: address('4'),
    topics: [hash('1')],
    data: '0x00',
    transactionHash: hash('5'),
    blockHash: hash('6'),
    blockNumber: '0x64',
    logIndex: '0x0',
    removed: false,
  }
  const wallet = address('7')
  const router = address('8')
  const input = '0xabcd'
  const frameLog = { address: log.address, topics: log.topics, data: log.data }
  const answers: Record<string, unknown> = {
    eth_blockNumber: '0x80',
    eth_getLogs: [log],
    eth_getTransactionReceipt: {
      status: '0x1',
      transactionHash: hash('5'),
      blockHash: hash('6'),
      blockNumber: '0x64',
      to: router,
      from: wallet,
      logs: [log],
    },
    eth_getTransactionByHash: {
      hash: hash('5'),
      blockHash: hash('6'),
      blockNumber: '0x64',
      to: router,
      from: wallet,
      input,
    },
    debug_traceTransaction: {
      type: 'CALL',
      from: wallet,
      to: router,
      input,
      calls: [{ type: 'DELEGATECALL', from: router, to: address('9'), input, logs: [frameLog] }],
    },
    eth_getBlockByNumber: { number: '0x64', hash: hash('6') },
  }
  const rpc: JsonRpc = async (method) => answers[method]
  return { answers, log, rpc }
}

describe('EVM callTracer withLog admission probe', () => {
  it('verifies a real canonical emitter log from a successful proxy trace', async () => {
    const f = fixture()
    const rpc: JsonRpc = async (method, params) => {
      if (method === 'eth_getLogs') {
        expect(params).toEqual([{ address: address('4'), fromBlock: '0x1', toBlock: '0x80' }])
      }
      if (method === 'debug_traceTransaction') {
        expect(params).toEqual([hash('5'), { tracer: 'callTracer', tracerConfig: { withLog: true } }])
      }
      return f.rpc(method, params)
    }
    await expect(assertEvmClaimTraceSupport(rpc, emitter)).resolves.toBeUndefined()
  })

  it('fails when there is no recent canonical emitter log to sample', async () => {
    const f = fixture()
    f.answers.eth_getLogs = []
    await expect(assertEvmClaimTraceSupport(f.rpc, emitter)).rejects.toThrow(/recent canonical emitter log/)
  })

  it.each([
    [
      'trace unavailable',
      (f: ReturnType<typeof fixture>) => {
        f.answers.debug_traceTransaction = null
      },
    ],
    [
      'withLog ignored',
      (f: ReturnType<typeof fixture>) => {
        ;(f.answers.debug_traceTransaction as Record<string, unknown>).calls = [{ type: 'DELEGATECALL', logs: [] }]
      },
    ],
    [
      'transaction root mismatch',
      (f: ReturnType<typeof fixture>) => {
        ;(f.answers.debug_traceTransaction as Record<string, unknown>).to = address('9')
      },
    ],
    [
      'noncanonical block recheck',
      (f: ReturnType<typeof fixture>) => {
        f.answers.eth_getBlockByNumber = { number: '0x64', hash: hash('9') }
      },
    ],
  ])('fails closed for %s', async (_name, mutate) => {
    const f = fixture()
    mutate(f)
    await expect(assertEvmClaimTraceSupport(f.rpc, emitter)).rejects.toThrow(/EVM callTracer withLog probe/)
  })

  it('rejects a successful receipt that omits the selected log', async () => {
    const f = fixture()
    ;(f.answers.eth_getTransactionReceipt as Record<string, unknown>).logs = []
    await expect(assertEvmClaimTraceSupport(f.rpc, emitter)).rejects.toThrow(/recent canonical emitter log/)
  })

  it('samples the last 128 logs from a busy emitter without unbounded candidate work', async () => {
    const f = fixture()
    f.answers.eth_getLogs = [...Array.from({ length: 128 }, () => ({ malformed: true })), f.log]
    await expect(assertEvmClaimTraceSupport(f.rpc, emitter)).resolves.toBeUndefined()
    await expect(assertEvmClaimTraceSupport(f.rpc, new Uint8Array(19))).rejects.toThrow(/20-byte address/)
  })
})
