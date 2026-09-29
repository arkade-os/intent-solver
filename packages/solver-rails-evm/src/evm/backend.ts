/**
 * The EVM HTLC port, and a JSON-RPC adapter for its read half.
 *
 * THE SEAM, AND WHY IT SITS HERE. Reads and writes are split deliberately:
 * this module *observes* the chain over JSON-RPC, but it does not sign or
 * broadcast anything. The three money functions are exposed as {@link EvmCall}
 * values — a destination and calldata — and whoever holds the solver's key
 * turns those into a signed transaction.
 *
 * That is not squeamishness about scope. Transaction signing needs RLP, an
 * EIP-1559 envelope, nonce and fee-market management, and a private key in
 * process; each is its own correctness surface and none of them is specific to
 * this contract. Keeping them out means everything here is deterministic and
 * testable, and the part that can lose money has one obvious place to live
 * rather than being smeared through the contract binding.
 *
 * Every read is also injectable ({@link JsonRpc}) so the adapter can be driven
 * against recorded responses without a node — which is what the tests do.
 *
 * NOTHING IS COMPILED IN. Contract address, chain and cadence all arrive as
 * configuration, because the corridor is required to work on any
 * EVM-compatible chain.
 */

import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { equalBytes } from '@noble/curves/utils.js'
import {
  claimEventTopic,
  encodeClaim,
  decodeUint256,
  encodeLock,
  encodeRefund,
  encodeRefundFor,
  refundEventTopic,
  swapKey,
  type Erc20SwapLock,
} from './erc20Swap.js'
import { approvalStepFor, encodeAllowance, encodeApprove } from './erc20Token.js'
// The port types live in core since the vendor-package split: a rail may only
// import core, so the interface a vendor implements cannot live in rails.
// Re-exported here so existing importers keep resolving.
export type {
  EvmCall,
  JsonRpc,
  Erc20SwapLock,
  EvmHtlcBackend,
  EvmHtlcBackendDeps,
} from '@arkade-os/solver-core/ports/evm.js'
import type { EvmCall, EvmHtlcBackend, EvmHtlcBackendDeps, JsonRpc } from '@arkade-os/solver-core/ports/evm.js'

/** `swaps(bytes32)` — the public mapping getter, cross-checked in tests. */
const SWAPS_SELECTOR_SIGNATURE = 'swaps(bytes32)'

const hexOf = (bytes: Uint8Array): string => '0x' + bytesToHex(bytes)

/** Decodes, or null when the string is not whole-byte hex. */
const tryBytesOfHex = (value: unknown): Uint8Array | null => {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) return null
  return hexToBytes(value.slice(2))
}

const bytesOfHex = (value: unknown, label: string): Uint8Array => {
  const bytes = tryBytesOfHex(value)
  if (!bytes) throw new Error(`${label}: expected 0x-prefixed hex, got ${JSON.stringify(value)}`)
  return bytes
}

/**
 * A quantity from a node.
 *
 * `eth_blockNumber` and friends return minimal-length hex (`0x1a`, not a padded
 * word), and BigInt handles that directly. Rejecting a non-string keeps a
 * malformed or errored response from being read as height zero, which would
 * make every timelock look expired.
 */
const quantityOf = (value: unknown, label: string): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label}: expected a 0x quantity, got ${JSON.stringify(value)}`)
  }
  return BigInt(value)
}

const DEFAULT_LOG_SCAN_RANGE = 10_000

export const createEvmHtlcBackend = (deps: EvmHtlcBackendDeps): EvmHtlcBackend => {
  const { contractAddress, rpc, logScanRange = DEFAULT_LOG_SCAN_RANGE } = deps
  if (contractAddress.length !== 20) {
    throw new Error(`contractAddress must be 20 bytes, got ${contractAddress.length}`)
  }
  if (!Number.isInteger(logScanRange) || logScanRange < 1) {
    throw new Error(`logScanRange must be a positive integer, got ${logScanRange}`)
  }
  const span = BigInt(logScanRange)
  const to = hexOf(contractAddress)
  const swapsSelector = keccak_256(new TextEncoder().encode(SWAPS_SELECTOR_SIGNATURE)).subarray(0, 4)
  const call = (data: Uint8Array): EvmCall => ({ to: Uint8Array.from(contractAddress), data })
  // Addressed to the TOKEN, not the swap contract: `approve` is the token's own
  // function and the spender it names is us. A `to` of the swap contract here
  // would approve nothing and revert nowhere.
  const approveTokenCall = (token: Uint8Array, amount: bigint): EvmCall => ({
    to: Uint8Array.from(token),
    data: encodeApprove(contractAddress, amount),
  })

  const readSwaps = async (lock: Erc20SwapLock, tag: string, hexLabel: string, wordLabel: string) => {
    const data = hexOf(concatBytes(swapsSelector, swapKey(lock)))
    const word = bytesOfHex(await rpc('eth_call', [{ to, data }, tag]), hexLabel)
    if (word.length !== 32) throw new Error(`${wordLabel}: expected one word, got ${word.length} bytes`)
    // A bool is a full word, zero or one. Testing every byte rather than the
    // last one costs nothing and does not assume the node normalises.
    return word.some((byte) => byte !== 0)
  }

  /**
   * Every log this swap matches in `[fromBlock, tip]`, a page at a time. ONLY
   * THE TIP ENDS THE LOOP, never an empty page: an unread stretch drops a Claim
   * exactly as a too-late floor would.
   */
  const scanLogs = async <T>(
    topic: Uint8Array,
    lock: Erc20SwapLock,
    fromBlock: bigint,
    take: (log: unknown) => Promise<T | null>,
  ): Promise<T | null> => {
    const tip = quantityOf(await rpc('eth_blockNumber', []), 'eth_blockNumber')
    for (let from = fromBlock; from <= tip; from += span) {
      const until = from + span - 1n
      const logs = await rpc('eth_getLogs', [
        {
          address: to,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${(until > tip ? tip : until).toString(16)}`,
          // Filtered on the INDEXED preimageHash, so the node returns only logs
          // for this swap rather than every claim on the contract.
          topics: [hexOf(topic), hexOf(lock.preimageHash)],
        },
      ])
      if (!Array.isArray(logs)) throw new Error('eth_getLogs: expected an array')
      for (const entry of logs) {
        const found = await take(entry)
        if (found !== null) return found
      }
    }
    return null
  }

  return {
    async currentBlock() {
      return quantityOf(await rpc('eth_blockNumber', []), 'eth_blockNumber')
    },

    // 'latest' rather than a pinned height: this answers "is it funded NOW",
    // and a caller that needs finality applies its own confirmation policy.
    isLocked: (lock) => readSwaps(lock, 'latest', 'eth_call swaps()', 'eth_call swaps()'),

    async findClaimPreimage(lock, fromBlock) {
      return scanLogs(claimEventTopic(), lock, fromBlock, async (entry) => {
        const log = entry as { data?: unknown }
        // No `topics` check: they are attacker-chosen, so the sha256 check below
        // is the whole filter. A malformed entry is SKIPPED, not thrown, so one
        // bad record cannot abort the scan and hide a later real claim.
        const preimage = tryBytesOfHex(log.data)
        if (!preimage || preimage.length !== 32) return null
        // THE CHECK THAT MATTERS. A node's filter is a convenience, not a
        // guarantee: the log is untrusted input and the topic it was matched
        // on is attacker-chosen in the case that counts. Only a preimage that
        // hashes to the one WE locked against may leave this function.
        return equalBytes(sha256(preimage), lock.preimageHash) ? preimage : null
      })
    },

    async findRefund(lock, fromBlock) {
      // The log carries only the hash, so unlike a Claim it cannot check
      // itself; the CALLDATA that emitted it is the lock fields verbatim.
      const refundFor = hexOf(encodeRefundFor(lock)).toLowerCase()
      const refundSelf = hexOf(encodeRefund(lock)).toLowerCase()
      const refundAddress = hexOf(lock.refundAddress).toLowerCase()
      const found = await scanLogs(refundEventTopic(), lock, fromBlock, async (entry) => {
        const hash = (entry as { transactionHash?: unknown }).transactionHash
        // Shaped, not just typed: the node REJECTS a malformed hash, and the throw leaves the loop.
        if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) return null
        const tx = (await rpc('eth_getTransactionByHash', [hash])) as {
          to?: unknown
          from?: unknown
          input?: unknown
        } | null
        if (tx === null || tx === undefined) return null
        if (typeof tx.to !== 'string' || tx.to.toLowerCase() !== to.toLowerCase()) return null
        if (typeof tx.input !== 'string') return null
        const input = tx.input.toLowerCase()
        // The 6-arg overload carries `refundAddress` so its calldata completes
        // the key; the 5-arg takes `msg.sender`, so the SENDER is that word.
        if (input === refundFor) return true
        if (input === refundSelf && typeof tx.from === 'string' && tx.from.toLowerCase() === refundAddress) {
          return true
        }
        return null
      })
      return found === true
    },

    isLockedAt: (lock, block) =>
      readSwaps(lock, `0x${block.toString(16)}`, 'eth_call swaps() at height', `eth_call swaps() at ${block}`),

    async blockTimestampAt(block) {
      const header = await rpc('eth_getBlockByNumber', [`0x${block.toString(16)}`, false])
      if (header === null || header === undefined) throw new Error(`eth_getBlockByNumber: no block ${block}`)
      // Seconds since the epoch fit a Number for the next quarter-million
      // years; the bigint is the wire form, not a range this needs to carry.
      return Number(quantityOf((header as { timestamp?: unknown }).timestamp, 'eth_getBlockByNumber timestamp'))
    },

    async transactionOutcome(txid) {
      const receipt = await rpc('eth_getTransactionReceipt', [txid])
      // No receipt covers "not mined yet" and "never seen this hash". Neither
      // is a failure, so neither may read as a revert.
      if (receipt === null || receipt === undefined) return 'pending'
      // EIP-658 defines only 0x1 and 0x0; anything else throws. Folding the
      // unrecognised into `success` restores the blindness this read removes.
      const status = quantityOf((receipt as { status?: unknown }).status, 'eth_getTransactionReceipt status')
      if (status === 0n) return 'reverted'
      if (status === 1n) return 'success'
      throw new Error(`eth_getTransactionReceipt status: expected 0x0 or 0x1, got ${status}`)
    },

    async transactionBlock(txid) {
      const receipt = await rpc('eth_getTransactionReceipt', [txid])
      if (receipt === null || receipt === undefined) return null
      return quantityOf((receipt as { blockNumber?: unknown }).blockNumber, 'eth_getTransactionReceipt blockNumber')
    },

    async allowance(token, owner) {
      const data = encodeAllowance(owner, contractAddress)
      const word = bytesOfHex(await rpc('eth_call', [{ to: hexOf(token), data: hexOf(data) }, 'latest']), 'allowance()')
      return decodeUint256(word, 'allowance()')
    },

    lockCalls(lock, currentAllowance) {
      // ONE place decides the sequence. `approvalStepFor` owns the
      // non-zero-to-non-zero rule (see erc20Token.ts); re-deriving it here would
      // be a second copy to keep in step with the first.
      const step = approvalStepFor(currentAllowance, lock.amount)
      if (step.kind === 'none') return [call(encodeLock(lock))]
      const calls: EvmCall[] = []
      if (step.kind === 'reset-then-approve') calls.push(approveTokenCall(lock.tokenAddress, 0n))
      calls.push(approveTokenCall(lock.tokenAddress, step.amount))
      calls.push(call(encodeLock(lock)))
      return calls
    },

    claimCall: (preimage, lock) => call(encodeClaim(preimage, lock)),
    refundCall: (lock) => call(encodeRefund(lock)),
    refundForCall: (lock) => call(encodeRefundFor(lock)),
  }
}
