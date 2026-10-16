/**
 * Talking to Boltz's `ERC20Swap` — the swap-key derivation, the calldata for
 * its three money functions, and the topics of the events they emit.
 *
 * WHY WE HAND-ROLL THE ABI. `lock`, `claim` and `refund` take only static
 * types — `bytes32`, `uint256`, `address` — so every argument is exactly one
 * 32-byte word and the encoding is a selector followed by the words in order.
 * That is a few lines here against a whole ABI library in the dependency tree
 * of a service that moves money. The one place hand-rolling would be risky is a
 * dynamic type, and there are none.
 *
 * THE THING TO GET RIGHT. `ERC20Swap` stores `mapping(bytes32 => bool) swaps` —
 * a bare flag, keyed by the hash of every lock parameter. Nothing about a lock
 * is recoverable from the chain except through that key, so a derivation that
 * disagrees with the contract by one byte does not fail loudly: it reports that
 * our own funded lock does not exist. {@link swapKey} mirrors the contract's
 * `hashValues`, and the parameter order is shared with the calldata builders so
 * the two cannot drift.
 */

import { keccak_256 } from '@noble/hashes/sha3.js'
import { concatBytes } from '@noble/hashes/utils.js'
// The lock identity moved to the core port vocabulary with the vendor split.
// Re-exported so existing importers keep resolving; vendor packages read core.
export type { Erc20SwapLock } from '@arkade-os/solver-core/ports/evm.js'
import type { Erc20SwapLock } from '@arkade-os/solver-core/ports/evm.js'

/** Bytes in one ABI word. Every parameter of every function here is exactly one. */
const WORD = 32

/** Address length, in bytes. Left-padded into its word. */
const ADDRESS_BYTES = 20

const assertLength = (label: string, bytes: Uint8Array, expected: number): void => {
  if (bytes.length !== expected) throw new Error(`${label} must be ${expected} bytes, got ${bytes.length}`)
}

/** A `uint256` as one big-endian word. */
export const uintWord = (value: bigint, label: string): Uint8Array => {
  if (value < 0n) throw new Error(`${label} must not be negative, got ${value}`)
  if (value >= 2n ** 256n) throw new Error(`${label} does not fit in uint256`)
  const out = new Uint8Array(WORD)
  let v = value
  for (let i = WORD - 1; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** A 20-byte address as one LEFT-padded word, which is how the EVM holds one. */
export const addressWord = (address: Uint8Array, label: string): Uint8Array => {
  assertLength(label, address, ADDRESS_BYTES)
  const out = new Uint8Array(WORD)
  out.set(address, WORD - ADDRESS_BYTES)
  return out
}

/**
 * A `bytes32` as itself — already one word, so only its length is in question.
 *
 * Returns the caller's array rather than a copy. Every result here goes
 * straight into `concatBytes`, which copies into a fresh buffer, so a
 * defensive copy would protect nothing and allocate a word per parameter. If
 * this ever gains a call site that does NOT concat, it needs the copy back.
 */
const bytes32Word = (value: Uint8Array, label: string): Uint8Array => {
  assertLength(label, value, WORD)
  return value
}

/** The 4-byte selector for a canonical signature. */
export const selectorFor = (signature: string): Uint8Array =>
  keccak_256(new TextEncoder().encode(signature)).subarray(0, 4)

/**
 * The six words the contract hashes, in the contract's order.
 *
 * Shared by {@link swapKey} and {@link encodeLock} precisely so the order
 * cannot drift between "how we address the lock" and "how we create it" — a
 * drift that would produce a lock we funded and cannot find.
 */
const lockWords = (lock: Erc20SwapLock): readonly Uint8Array[] => [
  bytes32Word(lock.preimageHash, 'preimageHash'),
  uintWord(lock.amount, 'amount'),
  addressWord(lock.tokenAddress, 'tokenAddress'),
  addressWord(lock.claimAddress, 'claimAddress'),
  addressWord(lock.refundAddress, 'refundAddress'),
  uintWord(lock.timelock, 'timelock'),
]

/**
 * The contract's own key for a lock — its `hashValues`.
 *
 * The contract computes this in assembly, writing six full words and hashing
 * `0xc0` (192) bytes of them:
 *
 * ```solidity
 * mstore(ptr, preimageHash)              mstore(add(ptr, 0x60), claimAddress)
 * mstore(add(ptr, 0x20), amount)         mstore(add(ptr, 0x80), refundAddress)
 * mstore(add(ptr, 0x40), tokenAddress)   mstore(add(ptr, 0xa0), timelock)
 * result := keccak256(ptr, 0xc0)
 * ```
 *
 * Because every value occupies a whole word this is `keccak256(abi.encode(…))`
 * semantics — addresses LEFT-padded to 32 bytes — and emphatically **not**
 * `encodePacked`, which would pack them to 20 and yield a plausible-looking
 * hash matching nothing on chain.
 */
export const swapKey = (lock: Erc20SwapLock): Uint8Array => keccak_256(concatBytes(...lockWords(lock)))

/** `lock(bytes32,uint256,address,address,address,uint256)`. */
export const LOCK_SIGNATURE = 'lock(bytes32,uint256,address,address,address,uint256)'
const LOCK_SELECTOR = selectorFor(LOCK_SIGNATURE)

export const encodeLock = (lock: Erc20SwapLock): Uint8Array => concatBytes(LOCK_SELECTOR, ...lockWords(lock))

/**
 * `claim(bytes32,uint256,address,address,uint256)`.
 *
 * The parameter list is NOT the lock's: the caller is the claimer, so
 * `claimAddress` is `msg.sender` and only `refundAddress` is passed. This takes
 * the whole {@link Erc20SwapLock} anyway and drops the field here, so callers
 * never assemble a second, subtly different argument set.
 *
 * The preimage is `bytes32`, so it travels as itself. There is no text encoding
 * anywhere on this path and no way for one to be introduced — the property the
 * rejected Cancore contract could not offer.
 */
export const CLAIM_SIGNATURE = 'claim(bytes32,uint256,address,address,uint256)'

/** Boltz's long claim form. Nothing here encodes it; a downstream fork's e2e checks its contract ABI against it. */
export const CLAIM_FOR_SIGNATURE = 'claim(bytes32,uint256,address,address,address,uint256)'
const CLAIM_SELECTOR = selectorFor(CLAIM_SIGNATURE)

export const encodeClaim = (preimage: Uint8Array, lock: Erc20SwapLock): Uint8Array =>
  concatBytes(
    CLAIM_SELECTOR,
    bytes32Word(preimage, 'preimage'),
    uintWord(lock.amount, 'amount'),
    addressWord(lock.tokenAddress, 'tokenAddress'),
    addressWord(lock.refundAddress, 'refundAddress'),
    uintWord(lock.timelock, 'timelock'),
  )

/**
 * `refund(bytes32,uint256,address,address,address,uint256)` — the NON-INTERACTIVE
 * refund.
 *
 * `public` with an explicit `refundAddress`, so a third party can push a
 * matured refund and the tokens still return to whoever funded the lock. The
 * argument list is exactly the lock's, so this is `lockWords` unchanged.
 */
export const REFUND_FOR_SIGNATURE = 'refund(bytes32,uint256,address,address,address,uint256)'
const REFUND_FOR_SELECTOR = selectorFor(REFUND_FOR_SIGNATURE)

export const encodeRefundFor = (lock: Erc20SwapLock): Uint8Array => concatBytes(REFUND_FOR_SELECTOR, ...lockWords(lock))

/**
 * `refund(bytes32,uint256,address,address,uint256)`.
 *
 * Mirror of claim: the refunder is `msg.sender`, so `claimAddress` is passed
 * and `refundAddress` is implicit.
 */
export const REFUND_SIGNATURE = 'refund(bytes32,uint256,address,address,uint256)'
const REFUND_SELECTOR = selectorFor(REFUND_SIGNATURE)

export const encodeRefund = (lock: Erc20SwapLock): Uint8Array =>
  concatBytes(
    REFUND_SELECTOR,
    bytes32Word(lock.preimageHash, 'preimageHash'),
    uintWord(lock.amount, 'amount'),
    addressWord(lock.tokenAddress, 'tokenAddress'),
    addressWord(lock.claimAddress, 'claimAddress'),
    uintWord(lock.timelock, 'timelock'),
  )

/** One returned `uint256` word, big-endian. */
export const decodeUint256 = (word: Uint8Array, label: string): bigint => {
  assertLength(label, word, WORD)
  return word.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n)
}

/**
 * The `Claim(bytes32 indexed preimageHash, bytes32 preimage)` topic.
 *
 * THIS EVENT IS THE CROSS-LEG MECHANISM, not telemetry. On a send corridor the
 * client claims the tokens and the solver learns the preimage by watching for
 * this log — which is what lets it then take its own side. Losing it is losing
 * the swap's atomicity, so the topic is derived here rather than assembled at a
 * call site.
 */
export const CLAIM_EVENT_SIGNATURE = 'Claim(bytes32,bytes32)'

/**
 * Derived once at module load. `findClaimPreimage` runs on every watch tick
 * while a send corridor is open, so hashing this per call put a keccak on the
 * hot path for a value that never changes.
 */
const CLAIM_EVENT_TOPIC = keccak_256(new TextEncoder().encode(CLAIM_EVENT_SIGNATURE))

/** A COPY, so a caller cannot mutate the shared constant every later match compares against. */
export const claimEventTopic = (): Uint8Array => Uint8Array.from(CLAIM_EVENT_TOPIC)

/**
 * The `Refund(bytes32 indexed preimageHash)` topic - a `LOG2` in the deployed
 * bytecode, so one indexed field and no data (see tests).
 *
 * IT NAMES THE HASH, NEVER THE SWAP KEY, so it identifies no lock: minting a
 * throwaway token under another's hash costs gas alone. A match is a pointer
 * to a candidate transaction; `findRefund` does the binding.
 */
export const REFUND_EVENT_SIGNATURE = 'Refund(bytes32)'

const REFUND_EVENT_TOPIC = keccak_256(new TextEncoder().encode(REFUND_EVENT_SIGNATURE))

/** A COPY, for the reason {@link claimEventTopic} returns one. */
export const refundEventTopic = (): Uint8Array => Uint8Array.from(REFUND_EVENT_TOPIC)
