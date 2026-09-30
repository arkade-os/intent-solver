import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { concatBytes } from '@noble/hashes/utils.js'
import {
  CLAIM_FOR_SIGNATURE,
  addressWord,
  claimEventTopic,
  encodeClaim,
  selectorFor,
  uintWord,
  type Erc20SwapLock,
} from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'
import { verifyEvmClaimEvidence } from '@arkade-os/solver-rails-evm/evm/claimEvidence.js'
import type { JsonRpc } from '@arkade-os/solver-core/ports/evm.js'

const address = (value: string) => `0x${value.repeat(40)}`
const hash = (value: string) => `0x${value.repeat(64)}`
const bytes = (value: string) => hex.decode(value.slice(2))
const asHex = (value: Uint8Array) => `0x${hex.encode(value)}`
const contract = bytes(address('4'))
const preimage = bytes(hash('a'))
const lock: Erc20SwapLock = {
  preimageHash: sha256(preimage),
  amount: 1_000n,
  tokenAddress: bytes(address('1')),
  claimAddress: bytes(address('2')),
  refundAddress: bytes(address('3')),
  timelock: 200n,
}
const policy = { minConfirmations: 3, minAgeSeconds: 100, nowSeconds: 1_000 }
const fixture = () => {
  const log = {
    address: asHex(contract),
    topics: [asHex(claimEventTopic()), asHex(lock.preimageHash)],
    data: asHex(preimage),
    transactionHash: hash('5'),
    blockHash: hash('6'),
    blockNumber: '0x64',
    logIndex: '0x1',
    removed: false,
  }
  const receipt = {
    status: '0x1',
    transactionHash: hash('5'),
    blockHash: hash('6'),
    blockNumber: '0x64',
    to: asHex(contract),
    from: asHex(lock.claimAddress),
    logs: [{ ...log }],
  }
  const transaction = {
    hash: hash('5'),
    to: asHex(contract),
    from: asHex(lock.claimAddress),
    input: asHex(encodeClaim(preimage, lock)),
    blockHash: hash('6'),
    blockNumber: '0x64',
  }
  const block = { hash: hash('6'), number: '0x64', timestamp: '0x320' }
  const answers: Record<string, unknown> = {
    eth_getTransactionReceipt: receipt,
    eth_getTransactionByHash: transaction,
    eth_getBlockByNumber: block,
    eth_blockNumber: '0x66',
  }
  const rpc: JsonRpc = async (method) => {
    if (!(method in answers)) throw new Error(`Unexpected RPC ${method}`)
    return answers[method]
  }
  return { log, receipt, transaction, block, answers, rpc }
}

describe('successful canonical exact HTLC claim evidence', () => {
  it('returns a preimage only after its exact receipt and configured depth/age are established', async () => {
    const f = fixture()
    await expect(verifyEvmClaimEvidence(f.rpc, contract, lock, f.log, policy)).resolves.toEqual(preimage)
    await expect(
      verifyEvmClaimEvidence(f.rpc, contract, lock, f.log, { ...policy, minConfirmations: 4 }),
    ).resolves.toBeNull()
    await expect(
      verifyEvmClaimEvidence(f.rpc, contract, lock, f.log, { ...policy, minAgeSeconds: 201 }),
    ).resolves.toBeNull()
  })

  it('binds the six-argument claim to its explicit claimant even when submitted by another account', async () => {
    const f = fixture()
    f.transaction.input = asHex(
      concatBytes(
        selectorFor(CLAIM_FOR_SIGNATURE),
        preimage,
        uintWord(lock.amount, 'amount'),
        addressWord(lock.tokenAddress, 'token'),
        addressWord(lock.claimAddress, 'claim'),
        addressWord(lock.refundAddress, 'refund'),
        uintWord(lock.timelock, 'timelock'),
      ),
    )
    f.transaction.from = address('7')
    f.receipt.from = address('7')
    await expect(verifyEvmClaimEvidence(f.rpc, contract, lock, f.log, policy)).resolves.toEqual(preimage)
  })

  it.each([
    [
      'removed log',
      (f: ReturnType<typeof fixture>) => {
        f.log.removed = true
      },
    ],
    [
      'wrong emitting contract',
      (f) => {
        f.log.address = address('7')
      },
    ],
    [
      'wrong event topic',
      (f) => {
        f.log.topics[0] = hash('7')
      },
    ],
    [
      'wrong payment hash topic',
      (f) => {
        f.log.topics[1] = hash('7')
      },
    ],
    [
      'wrong preimage',
      (f) => {
        f.log.data = hash('7')
      },
    ],
    [
      'reverted receipt',
      (f) => {
        f.receipt.status = '0x0'
      },
    ],
    [
      'receipt belongs to another transaction',
      (f) => {
        f.receipt.transactionHash = hash('7')
      },
    ],
    [
      'receipt belongs to another block',
      (f) => {
        f.receipt.blockHash = hash('7')
      },
    ],
    [
      'receipt belongs to another height',
      (f) => {
        f.receipt.blockNumber = '0x65'
      },
    ],
    [
      'receipt omitted the claim log',
      (f) => {
        f.receipt.logs = []
      },
    ],
    [
      'different receipt log index',
      (f) => {
        f.receipt.logs[0]!.logIndex = '0x2'
      },
    ],
    [
      'removed receipt log',
      (f) => {
        f.receipt.logs[0]!.removed = true
      },
    ],
    [
      'wrong transaction hash',
      (f) => {
        f.transaction.hash = hash('7')
      },
    ],
    [
      'wrong transaction destination',
      (f) => {
        f.transaction.to = address('7')
      },
    ],
    [
      'wrong five-argument claimant',
      (f) => {
        f.transaction.from = address('7')
        f.receipt.from = address('7')
      },
    ],
    [
      'claiming another token',
      (f) => {
        f.transaction.input = asHex(encodeClaim(preimage, { ...lock, tokenAddress: bytes(address('7')) }))
      },
    ],
    [
      'claiming another amount',
      (f) => {
        f.transaction.input = asHex(encodeClaim(preimage, { ...lock, amount: lock.amount + 1n }))
      },
    ],
    [
      'claiming another refund recipient',
      (f) => {
        f.transaction.input = asHex(encodeClaim(preimage, { ...lock, refundAddress: bytes(address('7')) }))
      },
    ],
    [
      'claiming another timelock',
      (f) => {
        f.transaction.input = asHex(encodeClaim(preimage, { ...lock, timelock: lock.timelock + 1n }))
      },
    ],
    [
      'extra transaction calldata',
      (f) => {
        f.transaction.input += '00'
      },
    ],
    [
      'noncanonical block hash',
      (f) => {
        f.block.hash = hash('7')
      },
    ],
    [
      'future block timestamp',
      (f) => {
        f.block.timestamp = '0x400'
      },
    ],
    [
      'claim above current chain tip',
      (f) => {
        f.answers.eth_blockNumber = '0x63'
      },
    ],
    [
      'pending transaction receipt',
      (f) => {
        f.answers.eth_getTransactionReceipt = null
      },
    ],
    [
      'missing canonical block',
      (f) => {
        f.answers.eth_getBlockByNumber = null
      },
    ],
  ] satisfies [string, (sample: ReturnType<typeof fixture>) => void][])('rejects %s', async (_name, mutate) => {
    const f = fixture()
    mutate(f)
    await expect(verifyEvmClaimEvidence(f.rpc, contract, lock, f.log, policy)).resolves.toBeNull()
  })

  it('rejects canonical block replacement between evidence reads', async () => {
    const f = fixture()
    let reads = 0
    const rpc: JsonRpc = async (method, params) => {
      if (method === 'eth_getBlockByNumber' && ++reads === 2) return { ...f.block, hash: hash('7') }
      return f.rpc(method, params)
    }
    await expect(verifyEvmClaimEvidence(rpc, contract, lock, f.log, policy)).resolves.toBeNull()
  })

  it('skips incomplete event metadata and refuses invalid finality policies', async () => {
    const f = fixture()
    await expect(verifyEvmClaimEvidence(f.rpc, contract, lock, { data: asHex(preimage) }, policy)).resolves.toBeNull()
    for (const minConfirmations of [-1, 0.5, NaN, Infinity]) {
      await expect(
        verifyEvmClaimEvidence(f.rpc, contract, lock, f.log, { ...policy, minConfirmations }),
      ).rejects.toThrow('policy')
    }
  })

  it('preserves RPC failures rather than reporting an unproven payout as success', async () => {
    const f = fixture()
    const rpc: JsonRpc = async () => {
      throw new Error('RPC unavailable')
    }
    await expect(verifyEvmClaimEvidence(rpc, contract, lock, f.log, policy)).rejects.toThrow('RPC unavailable')
  })
})
