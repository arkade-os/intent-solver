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
const claimForInput = asHex(
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
const nestedFixture = () => {
  const f = fixture()
  const wallet = address('7')
  const router = address('8')
  const rootInput = '0xabcdef01'
  f.transaction.to = router
  f.transaction.from = wallet
  f.transaction.input = rootInput
  f.receipt.to = router
  f.receipt.from = wallet
  const frame = {
    type: 'CALL',
    from: wallet,
    to: asHex(contract),
    input: claimForInput,
    logs: [{ address: asHex(contract), topics: f.log.topics, data: f.log.data }],
  }
  f.answers.debug_traceTransaction = {
    type: 'CALL',
    from: wallet,
    to: router,
    input: rootInput,
    calls: [frame],
  }
  return { ...f, frame, wallet, router }
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

  it('accepts logs where the RPC omits removed', async () => {
    const f = fixture()
    delete (f.log as unknown as Record<string, unknown>).removed
    delete (f.receipt.logs[0] as Record<string, unknown>).removed
    await expect(verifyEvmClaimEvidence(f.rpc, contract, lock, f.log, policy)).resolves.toEqual(preimage)
  })

  it.each([true, 'false', null, 0])('rejects malformed removed=%s', async (removed) => {
    const f = fixture()
    ;(f.log as unknown as Record<string, unknown>).removed = removed
    await expect(verifyEvmClaimEvidence(f.rpc, contract, lock, f.log, policy)).resolves.toBeNull()
  })

  it('attributes a nested claim event to its exact successful CALL frame', async () => {
    const f = nestedFixture()
    const rpc: JsonRpc = async (method, params) => {
      if (method === 'debug_traceTransaction') {
        expect(params).toEqual([hash('5'), { tracer: 'callTracer', tracerConfig: { withLog: true } }])
      }
      return f.rpc(method, params)
    }
    await expect(verifyEvmClaimEvidence(rpc, contract, lock, f.log, policy)).resolves.toEqual(preimage)
  })

  it('accepts a claim beside an unrelated reverted sibling frame', async () => {
    const f = nestedFixture()
    ;(f.answers.debug_traceTransaction as Record<string, unknown>).calls = [
      { type: 'CALL', error: 'execution reverted' },
      f.frame,
    ]
    await expect(verifyEvmClaimEvidence(f.rpc, contract, lock, f.log, policy)).resolves.toEqual(preimage)
  })

  it.each([
    [
      'root transaction mismatch',
      (f: ReturnType<typeof nestedFixture>) => {
        ;(f.answers.debug_traceTransaction as Record<string, unknown>).input = '0xdeadbeef'
      },
    ],
    [
      'delegatecall frame',
      (f: ReturnType<typeof nestedFixture>) => {
        f.frame.type = 'DELEGATECALL'
      },
    ],
    [
      'reverted claim frame',
      (f: ReturnType<typeof nestedFixture>) => {
        ;(f.frame as Record<string, unknown>).error = 'execution reverted'
      },
    ],
    [
      'claim event outside the matching frame',
      (f: ReturnType<typeof nestedFixture>) => {
        f.frame.logs = []
        ;(f.answers.debug_traceTransaction as Record<string, unknown>).calls = [
          { type: 'CALL', from: f.wallet, to: asHex(contract), input: claimForInput, logs: f.frame.logs },
          {
            type: 'CALL',
            from: f.wallet,
            to: address('9'),
            input: '0xdeadbeef',
            logs: [{ address: asHex(contract), topics: f.log.topics, data: f.log.data }],
          },
        ]
      },
    ],
    [
      'failed ancestor frame',
      (f: ReturnType<typeof nestedFixture>) => {
        ;(f.answers.debug_traceTransaction as Record<string, unknown>).calls = [
          { type: 'CALL', error: 'execution reverted', calls: [f.frame] },
        ]
      },
    ],
    [
      'ambiguous matching claim frames',
      (f: ReturnType<typeof nestedFixture>) => {
        ;(f.answers.debug_traceTransaction as Record<string, unknown>).calls = [f.frame, { ...f.frame }]
      },
    ],
    [
      'trace beyond the node limit',
      (f: ReturnType<typeof nestedFixture>) => {
        ;(f.answers.debug_traceTransaction as Record<string, unknown>).calls = [
          ...Array.from({ length: 256 }, () => ({ type: 'CALL', from: f.wallet, to: address('9'), input: '0x' })),
          f.frame,
        ]
      },
    ],
    [
      'different claim amount',
      (f: ReturnType<typeof nestedFixture>) => {
        f.frame.input = asHex(
          concatBytes(
            selectorFor(CLAIM_FOR_SIGNATURE),
            preimage,
            uintWord(lock.amount + 1n, 'amount'),
            addressWord(lock.tokenAddress, 'token'),
            addressWord(lock.claimAddress, 'claim'),
            addressWord(lock.refundAddress, 'refund'),
            uintWord(lock.timelock, 'timelock'),
          ),
        )
      },
    ],
    [
      'self claim from the wrong caller',
      (f: ReturnType<typeof nestedFixture>) => {
        f.frame.input = asHex(encodeClaim(preimage, lock))
        f.frame.from = address('9')
      },
    ],
    [
      'unavailable trace',
      (f: ReturnType<typeof nestedFixture>) => {
        f.answers.debug_traceTransaction = null
      },
    ],
  ] satisfies [string, (sample: ReturnType<typeof nestedFixture>) => void][])(
    'rejects nested evidence with %s',
    async (_name, mutate) => {
      const f = nestedFixture()
      mutate(f)
      await expect(verifyEvmClaimEvidence(f.rpc, contract, lock, f.log, policy)).resolves.toBeNull()
    },
  )

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
