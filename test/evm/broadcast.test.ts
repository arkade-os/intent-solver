/**
 * The broadcaster's one money rule: WHEN A RESERVED NONCE MAY BE GIVEN BACK.
 *
 * Releasing after a transaction reached the mempool turns the NEXT transaction
 * into a replacement of it. On a claim, that means replacing the claim.
 */

import { describe, it, expect, vi } from 'vitest'
import { createEvmBroadcaster, nonceSourceFor } from '@arkade-os/solver-rails-evm/evm/broadcast.js'
import { createNonceSource } from '@arkade-os/solver-rails-evm/evm/nonce.js'

const KEY = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'))
const CALL = { to: Uint8Array.from(Buffer.from('22'.repeat(20), 'hex')), data: Uint8Array.from([1, 2, 3, 4]) }

const rpcFake = (over: Record<string, unknown> = {}) =>
  vi.fn(async (method: string) => {
    const answers: Record<string, unknown> = {
      eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
      eth_maxPriorityFeePerGas: '0x5f5e100',
      eth_getTransactionCount: '0x7',
      eth_sendRawTransaction: '0xdeadbeef',
      ...over,
    }
    if (!(method in answers)) throw new Error('unexpected rpc ' + method)
    return answers[method]
  })

const deps = (over: Partial<Parameters<typeof createEvmBroadcaster>[0]> = {}) => ({
  rpc: rpcFake(),
  privateKey: KEY,
  chainId: 8453,
  nonces: createNonceSource(async () => 7n),
  gasLimit: 300_000n,
  maxFeeCeilingPerGas: 10n ** 12n,
  headroomSeconds: 3600,
  fastestSecondsPerBlock: 2,
  ...over,
})

describe('createEvmBroadcaster', () => {
  it('signs and sends, returning the hash the node gave', async () => {
    const broadcast = createEvmBroadcaster(deps())
    expect(await broadcast(CALL)).toBe('0xdeadbeef')
  })

  it('KEEPS the nonce burnt when the SEND ITSELF THROWS', async () => {
    // FOUND BY MUTATION. The first version of this test made the send RETURN a
    // bad value, so the throw happened after the rpc had already succeeded —
    // which meant adding a release around the send passed it. The real hazard is
    // a TRANSPORT error: the transaction may already be in the mempool, and
    // giving the nonce back would make the next transaction a replacement of it.
    // On a claim, that is replacing the claim.
    const nonces = createNonceSource(async () => 7n)
    const release = vi.spyOn(nonces, 'release')
    const rpc = vi.fn(async (method: string) => {
      if (method === 'eth_sendRawTransaction') throw new Error('socket hang up')
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x3b9aca00' }
      if (method === 'eth_maxPriorityFeePerGas') return '0x5f5e100'
      throw new Error('unexpected rpc ' + method)
    })
    const broadcast = createEvmBroadcaster(deps({ nonces, rpc: rpc as never }))
    await expect(broadcast(CALL)).rejects.toThrow(/socket hang up/)
    expect(release).not.toHaveBeenCalled()
  })

  it('refuses a node answer that is not a hash, without releasing either', async () => {
    const nonces = createNonceSource(async () => 7n)
    const release = vi.spyOn(nonces, 'release')
    const broadcast = createEvmBroadcaster(
      deps({ nonces, rpc: rpcFake({ eth_sendRawTransaction: undefined }) as never }),
    )
    await expect(broadcast(CALL)).rejects.toThrow(/expected a hash/)
    expect(release).not.toHaveBeenCalled()
  })

  it('gives the nonce back when SIGNING fails, because nothing was sent', async () => {
    // A negative gas limit cannot be RLP-encoded, so this fails INSIDE the try
    // where the nonce is still safe to return. Nothing left the process, so
    // holding it would burn a slot and stall every later transaction behind it.
    //
    // Deliberately not a short private key: `addressFromPrivateKey` runs when the
    // broadcaster is CREATED, so that throws before there is a nonce to release
    // and would test the wrong thing while looking like it tested this.
    const nonces = createNonceSource(async () => 7n)
    const release = vi.spyOn(nonces, 'release')
    const broadcast = createEvmBroadcaster(deps({ nonces, gasLimit: -1n }))
    await expect(broadcast(CALL)).rejects.toThrow(/must not be negative/)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('surfaces a fee capped by policy rather than proceeding quietly', async () => {
    // A capped fee means the transaction is NOT priced for its full window.
    const onCappedByPolicy = vi.fn()
    const broadcast = createEvmBroadcaster(deps({ maxFeeCeilingPerGas: 1n, onCappedByPolicy }))
    await broadcast(CALL)
    expect(onCappedByPolicy).toHaveBeenCalledWith(CALL)
  })

  it('refuses a node answer that is not a hash', async () => {
    const broadcast = createEvmBroadcaster(deps({ rpc: rpcFake({ eth_sendRawTransaction: 42 }) as never }))
    await expect(broadcast(CALL)).rejects.toThrow(/expected a hash/)
  })

  it('refuses a block with no base fee rather than pricing against NaN', async () => {
    const broadcast = createEvmBroadcaster(deps({ rpc: rpcFake({ eth_getBlockByNumber: {} }) as never }))
    await expect(broadcast(CALL)).rejects.toThrow(/baseFeePerGas/)
  })
})

describe('nonceSourceFor', () => {
  it('asks the node for the account it is about to sign for', async () => {
    const rpc = rpcFake()
    const source = nonceSourceFor(rpc as never)
    const address = Uint8Array.from(Buffer.from('33'.repeat(20), 'hex'))
    expect(await source.next(address)).toBe(7n)
    expect(rpc).toHaveBeenCalledWith('eth_getTransactionCount', ['0x' + '33'.repeat(20), 'pending'])
  })
})
