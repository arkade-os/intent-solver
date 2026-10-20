import { describe, expect, it } from 'vitest'
import { BLOCK_NUMBER_INITCODE, probeTimelockClock } from '@arkade-os/solver-rails-evm/evm/timelockClock.js'
import { createEvmHtlcBackend } from '@arkade-os/solver-rails-evm/evm/backend.js'
import type { JsonRpc } from '@arkade-os/solver-core/ports/evm.js'

const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`
const hexOf = (n: bigint) => `0x${n.toString(16)}`
const BASE = 52_640_692n
const ARBITRUM = { height: 514_431_756n, clock: 26_193_574n }

const rpcWith = (height: unknown, call: () => unknown) => {
  const calls: unknown[] = []
  const rpc: JsonRpc = async (method, params) => {
    if (method === 'eth_blockNumber') return height
    if (method === 'eth_call') {
      calls.push(params)
      return call()
    }
    throw new Error(`unexpected RPC ${method}`)
  }
  return { rpc, calls }
}
const backend = (rpc: JsonRpc, timelockClockIsHeight?: boolean) =>
  createEvmHtlcBackend({ contractAddress: new Uint8Array(20), rpc, timelockClockIsHeight })

describe('timelock clock probe', () => {
  it('finds one clock when contracts read the height, asked at that height', async () => {
    const { rpc, calls } = rpcWith(hexOf(BASE), () => word(BASE))
    await expect(probeTimelockClock(rpc)).resolves.toEqual({ kind: 'same', height: BASE })
    expect(calls).toEqual([[{ data: BLOCK_NUMBER_INITCODE }, hexOf(BASE)]])
  })

  it('finds a distinct clock where block.number is the parent chain height', async () => {
    const { rpc } = rpcWith(hexOf(ARBITRUM.height), () => word(ARBITRUM.clock))
    await expect(probeTimelockClock(rpc)).resolves.toEqual({ kind: 'distinct', ...ARBITRUM })
  })

  it.each([
    ['a malformed height', 'tip', () => word(1n)],
    ['a call that returns no word', '0x1', () => '0x'],
    ['a call the node rejects', '0x1', () => Promise.reject(new Error('method not allowed'))],
  ])('is inconclusive on %s', async (_name, height, call) => {
    const { rpc } = rpcWith(height, call)
    await expect(probeTimelockClock(rpc)).resolves.toMatchObject({ kind: 'inconclusive' })
  })
})

describe('backend timelock clock', () => {
  it('reads block.number pinned to the tip', async () => {
    const { rpc, calls } = rpcWith(hexOf(BASE), () => word(BASE))
    await expect(backend(rpc).timelockClock()).resolves.toBe(Number(BASE))
    expect(calls).toEqual([[{ data: BLOCK_NUMBER_INITCODE }, hexOf(BASE)]])
  })

  it('returns the parent chain height once the operator has given it a cadence', async () => {
    const { rpc } = rpcWith(hexOf(ARBITRUM.height), () => word(ARBITRUM.clock))
    await expect(backend(rpc, false).timelockClock()).resolves.toBe(Number(ARBITRUM.clock))
  })

  it('refuses a distinct clock while the config says the two are one', async () => {
    const { rpc } = rpcWith(hexOf(ARBITRUM.height), () => word(ARBITRUM.clock))
    await expect(backend(rpc).timelockClock()).rejects.toThrow(/EVM_TIMELOCK_FASTEST_SECONDS_PER_BLOCK/)
  })

  it('never falls back to the height when block.number cannot be read', async () => {
    const { rpc } = rpcWith(hexOf(BASE), () => Promise.reject(new Error('header not found')))
    await expect(backend(rpc).timelockClock()).rejects.toThrow(/header not found/)
    const empty = rpcWith(hexOf(BASE), () => '0x').rpc
    await expect(backend(empty, false).timelockClock()).rejects.toThrow(/block.number read/)
  })
})
