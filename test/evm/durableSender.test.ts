import { afterEach, describe, expect, it } from 'vitest'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import { decodeSignedTransaction } from '@arkade-os/solver-rails-evm/evm/transaction.js'
import { createDurableEvmSender, type DurableEvmRequest } from '@arkade-os/solver-rails-evm/evm/durableSender.js'
import type { JsonRpc } from '@arkade-os/solver-core/ports/evm.js'

const driver = betterSqliteDriver(':memory:')
const key = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 1 : 0))
const request: DurableEvmRequest = { to: new Uint8Array(20).fill(7), data: Uint8Array.from([1, 2, 3]) }
const blockHash = `0x${'ab'.repeat(32)}`
const hex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`
const sent: string[] = []
const receipts = new Map<string, string>()
let throwNextSend = false

const rpc: JsonRpc = async (method, params) => {
  if (method === 'eth_chainId') return '0x1'
  if (method === 'eth_getTransactionCount') return '0x0'
  if (method === 'eth_sendRawTransaction') {
    const raw = String(params[0])
    sent.push(raw)
    if (throwNextSend) {
      throwNextSend = false
      throw new Error('connection reset')
    }
    return hex(decodeSignedTransaction(Buffer.from(raw.slice(2), 'hex')).hash)
  }
  if (method === 'eth_getTransactionReceipt') {
    const hash = String(params[0])
    const status = receipts.get(hash)
    return status === undefined ? null : { transactionHash: hash, blockHash, blockNumber: '0x2', status }
  }
  if (method === 'eth_getBlockByNumber') return { hash: blockHash }
  if (method === 'eth_getTransactionByHash') return null
  throw new Error(`unexpected RPC ${method}`)
}

const sender = (fees: { gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) =>
  createDurableEvmSender({ driver, rpc, chainId: 1n, privateKey: key, ...fees })

afterEach(async () => {
  sent.splice(0)
  receipts.clear()
  throwNextSend = false
  await driver.exec('DELETE FROM evm_transaction_attempts')
  await driver.exec('DELETE FROM evm_transaction_journal')
})

describe('durable EVM sender', () => {
  it('replays the exact authorized bytes after a restart with changed fee configuration', async () => {
    const first = await sender({ gasLimit: 21_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n })
    const prepared = await first.prepare('restart', request)
    const restarted = await sender({ gasLimit: 90_000n, maxFeePerGas: 900n, maxPriorityFeePerGas: 40n })

    const replayed = await restarted.replay('restart', request)

    expect(replayed.rawTransaction).toBe(prepared.rawTransaction)
    expect(sent).toEqual([prepared.rawTransaction])
    expect(replayed.state).toBe('submitted')
  })

  it('returns unknown on ambiguous send and retries the same bytes', async () => {
    const transactions = await sender({ gasLimit: 21_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n })
    throwNextSend = true

    const uncertain = await transactions.submit('ambiguous', request)
    const replayed = await transactions.replay('ambiguous', request)

    expect(uncertain.state).toBe('unknown')
    expect(replayed.state).toBe('submitted')
    expect(sent).toHaveLength(2)
    expect(sent[1]).toBe(sent[0])
  })

  it('replaces only the fee fields under an explicit ceiling and finds an older mined attempt', async () => {
    const transactions = await sender({ gasLimit: 21_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n })
    const original = await transactions.submit('replace', request)

    const replacement = await transactions.replace(
      'replace',
      request,
      { maxFeePerGas: 120n, maxPriorityFeePerGas: 3n },
      150n,
    )
    const originalFields = decodeSignedTransaction(Buffer.from(original.rawTransaction.slice(2), 'hex')).fields
    const replacementFields = decodeSignedTransaction(Buffer.from(replacement.rawTransaction.slice(2), 'hex')).fields
    expect(replacement.hash).not.toBe(original.hash)
    expect(replacementFields).toMatchObject({
      chainId: originalFields.chainId,
      nonce: originalFields.nonce,
      gas: originalFields.gas,
      value: originalFields.value,
      maxFeePerGas: 120n,
      maxPriorityFeePerGas: 3n,
    })
    expect(hex(replacementFields.to)).toBe(hex(originalFields.to))
    expect(hex(replacementFields.data)).toBe(hex(originalFields.data))
    expect((await transactions.broadcastRawTransaction(original.rawTransaction)).hash).toBe(replacement.hash)
    expect(sent[2]).toBe(replacement.rawTransaction)

    receipts.set(original.hash, '0x1')
    expect(await transactions.getPrepared('replace', request)).toMatchObject({ hash: original.hash, state: 'success' })
    expect(await transactions.pending()).toEqual([])
  })

  it('treats a canonical reverted attempt as nonce-consuming', async () => {
    const transactions = await sender({ gasLimit: 21_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n })
    const submitted = await transactions.submit('reverted', request)
    receipts.set(submitted.hash, '0x0')

    expect(await transactions.getPrepared('reverted', request)).toMatchObject({
      hash: submitted.hash,
      state: 'reverted',
    })
    expect(await transactions.pending()).toEqual([])
  })

  it('rejects replacements below the bump, above the ceiling, or with changed payload', async () => {
    const transactions = await sender({ gasLimit: 21_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n })
    await transactions.prepare('policy', request)

    await expect(
      transactions.replace('policy', request, { maxFeePerGas: 109n, maxPriorityFeePerGas: 3n }, 150n),
    ).rejects.toThrow()
    await expect(
      transactions.replace('policy', request, { maxFeePerGas: 120n, maxPriorityFeePerGas: 3n }, 119n),
    ).rejects.toThrow()
    await expect(
      transactions.replace(
        'policy',
        { ...request, data: Uint8Array.from([9]) },
        { maxFeePerGas: 120n, maxPriorityFeePerGas: 3n },
        150n,
      ),
    ).rejects.toThrow(/changed request/)
  })
})
