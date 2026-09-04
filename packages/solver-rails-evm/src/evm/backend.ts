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
import {
  claimEventTopic,
  encodeClaim,
  encodeClaimFor,
  decodeUint256,
  encodeLock,
  encodeLockPrepayMinerfee,
  encodeRefund,
  encodeRefundFor,
  equalBytes,
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

/** A call for someone else to sign and broadcast: where it goes, the calldata, and any value. */
/** `swaps(bytes32)` — the public mapping getter, cross-checked in tests. */
const SWAPS_SELECTOR_SIGNATURE = 'swaps(bytes32)'

const hexOf = (bytes: Uint8Array): string => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`

/** Decodes, or null when the string is not whole-byte hex. */
const tryBytesOfHex = (value: unknown): Uint8Array | null => {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) return null
  const body = value.slice(2)
  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
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

export const createEvmHtlcBackend = (deps: EvmHtlcBackendDeps): EvmHtlcBackend => {
  const { contractAddress, rpc } = deps
  if (contractAddress.length !== 20) {
    throw new Error(`contractAddress must be 20 bytes, got ${contractAddress.length}`)
  }
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

  return {
    async currentBlock() {
      return quantityOf(await rpc('eth_blockNumber', []), 'eth_blockNumber')
    },

    async isLocked(lock) {
      const data = new Uint8Array(4 + 32)
      data.set(swapsSelector, 0)
      data.set(swapKey(lock), 4)
      // 'latest' rather than a pinned height: this answers "is it funded NOW",
      // and a caller that needs finality applies its own confirmation policy.
      const result = await rpc('eth_call', [{ to, data: hexOf(data) }, 'latest'])
      const word = bytesOfHex(result, 'eth_call swaps()')
      if (word.length !== 32) throw new Error(`eth_call swaps(): expected one word, got ${word.length} bytes`)
      // A bool is a full word, zero or one. Testing every byte rather than the
      // last one costs nothing and does not assume the node normalises.
      return word.some((byte) => byte !== 0)
    },

    async findClaimPreimage(lock, fromBlock) {
      // Filtered on the INDEXED preimageHash, so the node returns only logs
      // for this swap rather than every claim on the contract.
      const logs = await rpc('eth_getLogs', [
        {
          address: to,
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: 'latest',
          topics: [hexOf(claimEventTopic()), hexOf(lock.preimageHash)],
        },
      ])
      if (!Array.isArray(logs)) throw new Error('eth_getLogs: expected an array')
      for (const entry of logs) {
        const log = entry as { data?: unknown }
        // NO CHECK ON `topics` HERE, and that is not an oversight. An earlier
        // cut confirmed `topics` was an array and then never read it, which
        // reads as a security guard while filtering nothing. The topic is the
        // node's own matching criterion echoed back — untrusted, and in the
        // case that counts, attacker-chosen. The sha256 check below is the
        // whole filter, so a log with no usable topics at all is decided
        // correctly by it.
        // SKIPPED, not thrown. An earlier cut called `bytesOfHex` here, which
        // throws on a `data` that is a string but not whole-byte hex — so a
        // single malformed entry aborted the entire scan, including the later
        // log actually carrying the preimage. One bad record from a node must
        // not be able to hide a real claim.
        const preimage = tryBytesOfHex(log.data)
        if (!preimage || preimage.length !== 32) continue
        // THE CHECK THAT MATTERS. A node's filter is a convenience, not a
        // guarantee: the log is untrusted input and the topic it was matched
        // on is attacker-chosen in the case that counts. Only a preimage that
        // hashes to the one WE locked against may leave this function.
        if (equalBytes(sha256(preimage), lock.preimageHash)) return preimage
      }
      return null
    },

    async isLockedAt(lock, block) {
      const data = new Uint8Array(4 + 32)
      data.set(swapsSelector, 0)
      data.set(swapKey(lock), 4)
      const tag = `0x${block.toString(16)}`
      const result = await rpc('eth_call', [{ to, data: hexOf(data) }, tag])
      const word = bytesOfHex(result, 'eth_call swaps() at height')
      if (word.length !== 32)
        throw new Error(`eth_call swaps() at ${block}: expected one word, got ${word.length} bytes`)
      return word.some((byte) => byte !== 0)
    },

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

    async allowance(token, owner) {
      const data = encodeAllowance(owner, contractAddress)
      const word = bytesOfHex(await rpc('eth_call', [{ to: hexOf(token), data: hexOf(data) }, 'latest']), 'allowance()')
      return decodeUint256(word, 'allowance()')
    },

    lockCall: (lock) => call(encodeLock(lock)),

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

    lockPrepayCall: (lock, prepayWei, senderAddress) => {
      if (prepayWei <= 0n) {
        // Zero would lock the tokens and fund nobody — the exact failure this
        // function exists to prevent, and silent on chain. Use `lockCall` when
        // no prepay is wanted.
        throw new Error(`prepayWei must be positive, got ${prepayWei}; use lockCall for no prepay`)
      }
      // Length first, so a wrong-shaped input says so. Without this a 32-byte
      // hash passed by mistake fails `equalBytes` on LENGTH and reports "must
      // be the sending address", sending a caller to look at the wrong thing.
      if (senderAddress.length !== 20) {
        throw new Error(`senderAddress must be 20 bytes, got ${senderAddress.length}`)
      }
      if (!equalBytes(lock.refundAddress, senderAddress)) {
        // The contract writes msg.sender into the key as refundAddress. A
        // mismatch means the lock we fund is keyed differently from the one we
        // can address, so we could neither find nor refund it.
        throw new Error('lockPrepayCall: lock.refundAddress must be the sending address')
      }
      return { ...call(encodeLockPrepayMinerfee(lock)), value: prepayWei }
    },
    claimCall: (preimage, lock) => call(encodeClaim(preimage, lock)),
    claimForCall: (preimage, lock) => call(encodeClaimFor(preimage, lock)),
    refundCall: (lock) => call(encodeRefund(lock)),
    refundForCall: (lock) => call(encodeRefundFor(lock)),

    async allowanceOf(lock, owner) {
      if (owner.length !== 20) throw new Error(`owner must be 20 bytes, got ${owner.length}`)
      const result = await rpc('eth_call', [
        { to: hexOf(lock.tokenAddress), data: hexOf(encodeAllowance(owner, contractAddress)) },
        'latest',
      ])
      const word = bytesOfHex(result, 'eth_call allowance()')
      if (word.length !== 32) throw new Error(`eth_call allowance(): expected one word, got ${word.length} bytes`)
      // A uint256 word, big-endian. Read as a whole rather than assuming it fits
      // a Number: an unlimited approval is 2**256-1 and would silently lose
      // precision, reporting a smaller allowance than exists.
      return word.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n)
    },

    approveCall: (lock, amount) => ({
      // The TOKEN, not contractAddress — the one call here that is not addressed
      // to the swap deployment.
      to: Uint8Array.from(lock.tokenAddress),
      data: encodeApprove(contractAddress, amount),
    }),
  }
}
