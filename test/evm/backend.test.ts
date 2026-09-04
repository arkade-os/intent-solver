import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { claimEventTopic, swapKey, type Erc20SwapLock } from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'
import { createEvmHtlcBackend, type JsonRpc } from '@arkade-os/solver-rails-evm/evm/backend.js'

const CONTRACT = hex.decode('4444444444444444444444444444444444444444')
const PREIMAGE = hex.decode('a'.repeat(64))

const lock: Erc20SwapLock = {
  preimageHash: sha256(PREIMAGE),
  amount: 1_000_000n,
  tokenAddress: hex.decode('1111111111111111111111111111111111111111'),
  claimAddress: hex.decode('2222222222222222222222222222222222222222'),
  refundAddress: hex.decode('3333333333333333333333333333333333333333'),
  timelock: 12_345n,
}

/** Records what was asked, and answers from a script. */
const rpcOf = (answers: Record<string, unknown>) => {
  const calls: { method: string; params: readonly unknown[] }[] = []
  const rpc: JsonRpc = async (method, params) => {
    calls.push({ method, params })
    if (!(method in answers)) throw new Error(`unexpected RPC ${method}`)
    return answers[method]
  }
  return { rpc, calls }
}

const backendWith = (answers: Record<string, unknown>) => {
  const { rpc, calls } = rpcOf(answers)
  return { backend: createEvmHtlcBackend({ contractAddress: CONTRACT, rpc }), calls }
}

const word = (last: string) => `0x${'00'.repeat(32 - last.length / 2)}${last}`

describe('currentBlock', () => {
  it('reads a minimal-length quantity, not a padded word', () => {
    // Nodes return `0x1a`, not a 32-byte word. Assuming the padded form here
    // would throw on every real response.
    return expect(backendWith({ eth_blockNumber: '0x1a' }).backend.currentBlock()).resolves.toBe(26n)
  })

  it('refuses a malformed response rather than reading it as height zero', async () => {
    // Height zero would make every timelock look expired, so a bad response
    // must be an error and not a number.
    for (const bad of [null, '', 'latest', 42, undefined]) {
      const { backend } = backendWith({ eth_blockNumber: bad })
      await expect(backend.currentBlock()).rejects.toThrow(/expected a 0x quantity/)
    }
  })
})

describe('isLocked', () => {
  it('calls swaps() with the contract`s own key for the lock', async () => {
    const { backend, calls } = backendWith({ eth_call: word('01') })
    await backend.isLocked(lock)
    const [params] = calls
    const arg = params!.params[0] as { to: string; data: string }
    expect(arg.to).toBe(`0x${hex.encode(CONTRACT)}`)
    // Pinned rather than recomputed, for the same reason the function selectors
    // are: hashing the same string on both sides of an assertion proves only
    // that keccak is deterministic, never that the string is right. `eb84e7f2`
    // was confirmed present in the deployed contract's bytecode.
    expect(arg.data.slice(0, 10)).toBe('0xeb84e7f2')
    expect(arg.data.slice(10)).toBe(hex.encode(swapKey(lock)))
    expect(params!.params[1]).toBe('latest')
  })

  it('reads a true word as funded and a zero word as not', async () => {
    await expect(backendWith({ eth_call: word('01') }).backend.isLocked(lock)).resolves.toBe(true)
    await expect(backendWith({ eth_call: word('00') }).backend.isLocked(lock)).resolves.toBe(false)
  })

  it('does not assume the node normalises the bool to the last byte', async () => {
    // Any non-zero byte anywhere in the word is true. Reading only the last
    // byte would call a funded lock unfunded.
    const oddly = `0x01${'00'.repeat(31)}`
    await expect(backendWith({ eth_call: oddly }).backend.isLocked(lock)).resolves.toBe(true)
  })

  it('refuses a result that is not exactly one word', async () => {
    await expect(backendWith({ eth_call: '0x01' }).backend.isLocked(lock)).rejects.toThrow(/expected one word/)
    await expect(backendWith({ eth_call: 'nonsense' }).backend.isLocked(lock)).rejects.toThrow(
      /expected 0x-prefixed hex/,
    )
  })
})

describe('findClaimPreimage', () => {
  const claimLog = (data: string) => ({ topics: [hex.encode(claimEventTopic()), 'irrelevant'], data })

  it('filters on the indexed preimageHash so the node returns only this swap', async () => {
    const { backend, calls } = backendWith({ eth_getLogs: [] })
    await backend.findClaimPreimage(lock, 100n)
    const filter = calls[0]!.params[0] as { address: string; fromBlock: string; topics: string[] }
    expect(filter.address).toBe(`0x${hex.encode(CONTRACT)}`)
    expect(filter.fromBlock).toBe('0x64')
    expect(filter.topics[0]).toBe(`0x${hex.encode(claimEventTopic())}`)
    expect(filter.topics[1]).toBe(`0x${hex.encode(lock.preimageHash)}`)
  })

  it('returns the preimage when it hashes to the one we locked against', async () => {
    const { backend } = backendWith({ eth_getLogs: [claimLog(`0x${hex.encode(PREIMAGE)}`)] })
    await expect(backend.findClaimPreimage(lock, 0n)).resolves.toEqual(PREIMAGE)
  })

  it('rejects a log whose preimage does not hash to ours, even though the node matched it', async () => {
    // THE security property of this function. A node's topic filter is a
    // convenience, not a guarantee, and the topic is attacker-chosen in the
    // case that counts. Returning an unverified preimage would drive the
    // solver to spend its own side for nothing.
    const forged = `0x${'c'.repeat(64)}`
    const { backend } = backendWith({ eth_getLogs: [claimLog(forged)] })
    await expect(backend.findClaimPreimage(lock, 0n)).resolves.toBeNull()
  })

  it('finds the real preimage past a forged one rather than stopping at the first log', async () => {
    const { backend } = backendWith({
      eth_getLogs: [claimLog(`0x${'c'.repeat(64)}`), claimLog(`0x${hex.encode(PREIMAGE)}`)],
    })
    await expect(backend.findClaimPreimage(lock, 0n)).resolves.toEqual(PREIMAGE)
  })

  it('skips malformed entries instead of throwing the whole scan away', async () => {
    const { backend } = backendWith({
      eth_getLogs: [{ topics: 'not-an-array', data: '0x00' }, { data: 42 }, claimLog(`0x${hex.encode(PREIMAGE)}`)],
    })
    await expect(backend.findClaimPreimage(lock, 0n)).resolves.toEqual(PREIMAGE)
  })

  it('accepts a log carrying a valid preimage even with no usable topics', async () => {
    // The topics are the node's own filter echoed back, so they prove nothing
    // the sha256 check does not. An earlier cut required `topics` to be an
    // array before looking at `data`, which read like a security guard while
    // filtering nothing — and would have discarded a real, provable claim on
    // the say-so of a field nobody reads.
    for (const shape of [
      { data: `0x${hex.encode(PREIMAGE)}` },
      { topics: 'not-an-array', data: `0x${hex.encode(PREIMAGE)}` },
    ]) {
      const { backend } = backendWith({ eth_getLogs: [shape] })
      await expect(backend.findClaimPreimage(lock, 0n)).resolves.toEqual(PREIMAGE)
    }
  })

  it('skips a `data` that is a string but not whole-byte hex', async () => {
    // REGRESSION. The first cut decoded with a throwing helper here, so an
    // entry whose `data` was a string that failed the hex test — `'garbage'`,
    // or odd-length `'0x1'` — aborted the whole scan. Every earlier "malformed
    // entry" test used a non-string, which took a different branch and missed
    // it entirely. One bad record from a node must not be able to hide a real
    // claim sitting later in the same response.
    for (const bad of ['garbage', '0x1', '0xzz', '', '0X41']) {
      const { backend } = backendWith({ eth_getLogs: [claimLog(bad), claimLog(`0x${hex.encode(PREIMAGE)}`)] })
      await expect(backend.findClaimPreimage(lock, 0n)).resolves.toEqual(PREIMAGE)
    }
  })

  it('returns null when nothing has claimed', async () => {
    await expect(backendWith({ eth_getLogs: [] }).backend.findClaimPreimage(lock, 0n)).resolves.toBeNull()
  })

  it('refuses a non-array response', async () => {
    await expect(backendWith({ eth_getLogs: {} }).backend.findClaimPreimage(lock, 0n)).rejects.toThrow(
      /expected an array/,
    )
  })
})

describe('transactionOutcome', () => {
  it('asks for the receipt of the hash it was given', async () => {
    const { backend, calls } = backendWith({ eth_getTransactionReceipt: { status: '0x1' } })
    await backend.transactionOutcome('0xabc')
    expect(calls).toEqual([{ method: 'eth_getTransactionReceipt', params: ['0xabc'] }])
  })

  it('reads a zero status as reverted and a one status as success', async () => {
    const reverted = backendWith({ eth_getTransactionReceipt: { status: '0x0' } })
    await expect(reverted.backend.transactionOutcome('0xabc')).resolves.toBe('reverted')
    const ok = backendWith({ eth_getTransactionReceipt: { status: '0x1' } })
    await expect(ok.backend.transactionOutcome('0xabc')).resolves.toBe('success')
  })

  it('reads a missing receipt as pending, never as a revert', async () => {
    for (const absent of [null, undefined]) {
      const { backend } = backendWith({ eth_getTransactionReceipt: absent })
      await expect(backend.transactionOutcome('0xabc')).resolves.toBe('pending')
    }
  })

  it('refuses a receipt with no readable status rather than assuming success', async () => {
    for (const bad of [{}, { status: null }, { status: 1 }, { status: 'ok' }]) {
      const { backend } = backendWith({ eth_getTransactionReceipt: bad })
      await expect(backend.transactionOutcome('0xabc')).rejects.toThrow(/expected a 0x quantity/)
    }
  })

  it('refuses a well-formed status the spec does not define', async () => {
    // `0x2` decodes fine; EIP-658 gives no third value.
    const { backend } = backendWith({ eth_getTransactionReceipt: { status: '0x2' } })
    await expect(backend.transactionOutcome('0xabc')).rejects.toThrow(/expected 0x0 or 0x1/)
  })
})

describe('the write half is built, never sent', () => {
  it('returns calldata addressed to the configured contract', () => {
    const { backend } = backendWith({})
    for (const call of [
      backend.lockCall(lock),
      backend.claimCall(PREIMAGE, lock),
      backend.refundCall(lock),
      backend.claimForCall(PREIMAGE, lock),
      backend.refundForCall(lock),
    ]) {
      expect(hex.encode(call.to)).toBe(hex.encode(CONTRACT))
      expect(call.data.length).toBeGreaterThan(4)
    }
  })

  it(`exposes the third-party paths with different selectors to the msg.sender ones`, () => {
    // Same swap, four different calls. If a For- variant ever emitted the
    // interactive selector, a third party submitting it would revert because
    // it is not the claimAddress — the exact failure these exist to remove.
    const { backend } = backendWith({})
    const selector = (data: Uint8Array) => hex.encode(data.subarray(0, 4))
    expect(selector(backend.claimForCall(PREIMAGE, lock).data)).toBe('bc586b28')
    expect(selector(backend.refundForCall(lock).data)).toBe('0e5bbd59')
    expect(selector(backend.claimCall(PREIMAGE, lock).data)).toBe('cd413efa')
    expect(selector(backend.refundCall(lock).data)).toBe('36504721')
  })

  it(`addresses approveCall to the TOKEN, not to the swap contract`, () => {
    // Every other call here goes to CONTRACT. This one must not: the allowance
    // lives on the token, and sending approve to the swap deployment reverts
    // with nothing that names the cause.
    const { backend } = backendWith({})
    const call = backend.approveCall(lock, 500n)
    expect(hex.encode(call.to)).toBe(hex.encode(lock.tokenAddress))
    expect(hex.encode(call.to)).not.toBe(hex.encode(CONTRACT))
    expect(hex.encode(call.data.subarray(0, 4))).toBe('095ea7b3')
  })

  it(`approves the SWAP CONTRACT as spender, since it is what calls transferFrom`, () => {
    const { backend } = backendWith({})
    const call = backend.approveCall(lock, 500n)
    // Word 0 is the spender, left-padded.
    expect(hex.encode(call.data.subarray(4, 36))).toBe('00'.repeat(12) + hex.encode(CONTRACT))
  })

  it(`reads an unlimited allowance without losing precision`, async () => {
    // 2**256-1 is what an infinite approval looks like. Read through a Number
    // this would come back smaller than it is, and the caller would re-approve
    // forever while believing the allowance was short.
    const max = 'ff'.repeat(32)
    const { backend } = backendWith({ eth_call: '0x' + max })
    expect(await backend.allowanceOf(lock, new Uint8Array(20).fill(9))).toBe(2n ** 256n - 1n)
  })
  it('makes no RPC call to build one', async () => {
    // The seam this module exists for: nothing here signs or broadcasts, so
    // building a call must not touch the network at all.
    const { backend, calls } = backendWith({})
    backend.lockCall(lock)
    backend.claimCall(PREIMAGE, lock)
    backend.refundCall(lock)
    expect(calls).toHaveLength(0)
  })

  it('hands out a copy of the address, so a caller cannot retarget later calls', () => {
    // The expected value is captured BEFORE the mutation. Comparing against
    // `hex.encode(CONTRACT)` afterwards would be vacuous: if the address were
    // handed out live, zeroing it would zero both sides of the assertion and
    // the test would pass while the bug was present.
    const expected = hex.encode(CONTRACT)
    const { backend } = backendWith({})
    backend.lockCall(lock).to.fill(0xff)
    expect(hex.encode(backend.refundCall(lock).to)).toBe(expected)
    expect(hex.encode(CONTRACT)).toBe(expected)
  })
})

describe('lockPrepayCall — the claimant`s gas money', () => {
  const SENDER = hex.decode('3333333333333333333333333333333333333333') // == lock.refundAddress

  it('attaches the prepay as call value', () => {
    const { backend } = backendWith({})
    const call = backend.lockPrepayCall(lock, 5_000_000_000_000_000n, SENDER)
    expect(call.value).toBe(5_000_000_000_000_000n)
    expect(hex.encode(call.data.subarray(0, 4))).toBe('b8080ab8')
    expect(hex.encode(call.to)).toBe(hex.encode(CONTRACT))
  })

  it('refuses a zero prepay, which would lock the tokens and fund nobody', () => {
    // Silent on chain: the lock succeeds and the client still cannot claim.
    const { backend } = backendWith({})
    expect(() => backend.lockPrepayCall(lock, 0n, SENDER)).toThrow(/must be positive/)
    expect(() => backend.lockPrepayCall(lock, -1n, SENDER)).toThrow(/must be positive/)
  })

  it('reports a wrong-LENGTH sender as such, not as a wrong address', () => {
    // Without a length check these take the same branch: `equalBytes` returns
    // false because the lengths differ, and the caller is told the address is
    // wrong when the real problem is its shape — a 32-byte hash passed where an
    // address belongs is the likely mistake.
    const { backend } = backendWith({})
    expect(() => backend.lockPrepayCall(lock, 1n, new Uint8Array(32))).toThrow(/must be 20 bytes, got 32/)
    expect(() => backend.lockPrepayCall(lock, 1n, new Uint8Array(19))).toThrow(/must be 20 bytes, got 19/)
  })

  it('refuses a sender that is not the lock`s refundAddress', () => {
    // The contract writes msg.sender in as refundAddress, so a mismatch keys
    // the stored lock differently from the one swapKey derives — we would be
    // unable to find or refund our own funded lock.
    const { backend } = backendWith({})
    const other = hex.decode('9999999999999999999999999999999999999999')
    expect(() => backend.lockPrepayCall(lock, 1n, other)).toThrow(/must be the sending address/)
  })

  it('leaves the plain lock call with no value', () => {
    const { backend } = backendWith({})
    expect(backend.lockCall(lock).value).toBeUndefined()
  })
})

describe('construction', () => {
  it('refuses a contract address that is not 20 bytes', () => {
    const { rpc } = rpcOf({})
    expect(() => createEvmHtlcBackend({ contractAddress: new Uint8Array(19), rpc })).toThrow(/20 bytes/)
  })
})

/**
 * The allowance the lock depends on.
 *
 * `ERC20Swap.lock` moves the tokens with `transferFrom`, so without a standing
 * allowance it reverts — and a revert is not distinguishable downstream from a
 * lock that has not landed yet, so the swap waits out its whole timeout and
 * then refunds a lock that never existed.
 */
describe('allowance', () => {
  const OWNER = hex.decode('5555555555555555555555555555555555555555')

  it('asks the TOKEN, not the swap contract', () => {
    // The calldata is identical either way; only `to` differs. Sent to the swap
    // contract this hits no matching selector and reverts, or worse decodes as
    // something else entirely.
    const { backend, calls } = backendWith({ eth_call: word('00') })
    return backend.allowance(lock.tokenAddress, OWNER).then(() => {
      expect((calls[0]!.params[0] as { to: string }).to).toBe(`0x${hex.encode(lock.tokenAddress)}`)
    })
  })

  it('names the swap contract as the SPENDER and the caller as the owner', async () => {
    const { backend, calls } = backendWith({ eth_call: word('00') })
    await backend.allowance(lock.tokenAddress, OWNER)
    const data = (calls[0]!.params[0] as { data: string }).data
    expect(data.slice(10, 74)).toBe('00'.repeat(12) + hex.encode(OWNER))
    expect(data.slice(74)).toBe('00'.repeat(12) + hex.encode(CONTRACT))
  })

  it('reads the returned word as a uint256', () => {
    return expect(backendWith({ eth_call: word('0f4240') }).backend.allowance(lock.tokenAddress, OWNER)).resolves.toBe(
      1_000_000n,
    )
  })

  it('refuses a response that is not one word rather than reading a partial number', async () => {
    // A short read decoded as a number would understate the allowance, which is
    // recoverable, or overstate it, which is not: the lock would go out against
    // an approval that does not cover it and revert.
    for (const bad of ['0x', '0x01', word('01') + 'ff']) {
      const { backend } = backendWith({ eth_call: bad })
      await expect(backend.allowance(lock.tokenAddress, OWNER)).rejects.toThrow(/32 bytes/)
    }
  })

  it('reads at `latest`, since the question is what stands NOW', async () => {
    const { backend, calls } = backendWith({ eth_call: word('00') })
    await backend.allowance(lock.tokenAddress, OWNER)
    expect(calls[0]!.params[1]).toBe('latest')
  })
})

describe('lockCalls', () => {
  const { backend } = backendWith({})
  const to = (call: { to: Uint8Array }) => hex.encode(call.to)
  const selector = (call: { data: Uint8Array }) => hex.encode(call.data.subarray(0, 4))

  it('approves then locks when nothing is approved yet', () => {
    const calls = backend.lockCalls(lock, 0n)
    expect(calls.map(selector)).toEqual(['095ea7b3', 'e64fafcc'])
    // The approval goes to the token, the lock to the swap contract.
    expect(calls.map(to)).toEqual([hex.encode(lock.tokenAddress), hex.encode(CONTRACT)])
  })

  it('approves EXACTLY the amount, never unbounded', () => {
    // An infinite approval is one compromise away from the whole balance.
    // Per-lock bounds the loss to one swap, and the lock consumes it so the
    // allowance is back to zero on success.
    const [approve] = backend.lockCalls(lock, 0n)
    expect(hex.encode(approve!.data.subarray(36))).toBe('00'.repeat(29) + '0f4240')
    expect(lock.amount).toBe(0x0f4240n)
  })

  it('skips the approval when the standing allowance is already exact', () => {
    // The retry path after a crash between approving and locking. Re-approving
    // the same value is a wasted transaction, and on a token that refuses
    // non-zero-to-non-zero it is a reverting one.
    expect(backend.lockCalls(lock, lock.amount).map(selector)).toEqual(['e64fafcc'])
  })

  it('zeroes a STALE non-zero allowance first', () => {
    // USDT and friends refuse to change a non-zero allowance to another
    // non-zero value. A previous lock that reverted leaves its approval behind,
    // so this is the ordinary retry path on exactly the tokens most worth
    // serving — and without the zero step the retry reverts forever.
    const calls = backend.lockCalls(lock, 7n)
    expect(calls.map(selector)).toEqual(['095ea7b3', '095ea7b3', 'e64fafcc'])
    expect(hex.encode(calls[0]!.data.subarray(36))).toBe('00'.repeat(32))
    expect(hex.encode(calls[1]!.data.subarray(36))).toBe('00'.repeat(29) + '0f4240')
  })

  it('zeroes a SURPLUS allowance down rather than locking against it', () => {
    // A leftover approval larger than this lock would let the lock succeed, so
    // the tempting shortcut is `allowance >= amount`. It would leave the
    // surplus standing after the lock consumed its part — a permanent approval
    // nobody asked for, which is what approving per-lock exists to avoid.
    const calls = backend.lockCalls({ ...lock, amount: 1n }, 10n ** 30n)
    expect(calls.map(selector)).toEqual(['095ea7b3', '095ea7b3', 'e64fafcc'])
    expect(hex.encode(calls[1]!.data.subarray(36))).toBe('00'.repeat(31) + '01')
  })

  it('always ends with the lock, whatever the allowance', () => {
    // The orchestrator records the LAST txid as the lock's. A list that ended
    // with an approval would put a transaction that moved nothing into the
    // row's `evm_lock_txid`, where an operator goes looking for their money.
    for (const standing of [0n, 1n, lock.amount, 2n ** 255n]) {
      const calls = backend.lockCalls(lock, standing)
      expect(selector(calls[calls.length - 1]!)).toBe('e64fafcc')
      expect(to(calls[calls.length - 1]!)).toBe(hex.encode(CONTRACT))
    }
  })
})
