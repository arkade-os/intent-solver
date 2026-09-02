/**
 * Talking to Boltz's `ERC20Swap` — the swap-key derivation, the calldata for
 * its three money functions, and reading the preimage back off a claim.
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
// SHA-256 IS NOT A CHOICE HERE, so it is not a parameter. The contract applies
// `sha256(abi.encodePacked(preimage))` and Lightning hashes payment preimages
// the same way; any other digest rejects every honest preimage and the
// cross-leg signal is simply never seen. It used to be injected "for
// testability", but every caller in src/ and test/ passed this exact function —
// so the seam bought nothing and offered one way to be silently wrong.
import { sha256 } from '@noble/hashes/sha2.js'
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
 * straight into {@link concat}, which copies into a fresh buffer, so a
 * defensive copy would protect nothing and allocate a word per parameter. If
 * this ever gains a call site that does NOT concat, it needs the copy back.
 */
const bytes32Word = (value: Uint8Array, label: string): Uint8Array => {
  assertLength(label, value, WORD)
  return value
}

export const concat = (parts: readonly Uint8Array[]): Uint8Array => concatBytes(...parts)

/**
 * Byte equality, shared with `backend.ts` rather than copied into it.
 *
 * Not from `@noble/hashes/utils` — v2 exports `concatBytes` but no
 * `equalBytes`, so there is nothing to import. Everything compared here is
 * public (a hash of a revealed preimage against a published payment hash), so
 * constant time buys nothing; the reason this is one function is that two
 * copies in two files drift invisibly.
 */
export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

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
export const swapKey = (lock: Erc20SwapLock): Uint8Array => keccak_256(concat(lockWords(lock)))

/** `lock(bytes32,uint256,address,address,address,uint256)`. */
export const LOCK_SIGNATURE = 'lock(bytes32,uint256,address,address,address,uint256)'
const LOCK_SELECTOR = selectorFor(LOCK_SIGNATURE)

export const encodeLock = (lock: Erc20SwapLock): Uint8Array => concat([LOCK_SELECTOR, ...lockWords(lock)])

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
const CLAIM_SELECTOR = selectorFor(CLAIM_SIGNATURE)

export const encodeClaim = (preimage: Uint8Array, lock: Erc20SwapLock): Uint8Array =>
  concat([
    CLAIM_SELECTOR,
    bytes32Word(preimage, 'preimage'),
    uintWord(lock.amount, 'amount'),
    addressWord(lock.tokenAddress, 'tokenAddress'),
    addressWord(lock.refundAddress, 'refundAddress'),
    uintWord(lock.timelock, 'timelock'),
  ])

/**
 * `claim(bytes32,uint256,address,address,address,uint256)` — the NON-INTERACTIVE
 * claim, and the EVM answer to what covclaimd does on Arkade.
 *
 * The contract declares this overload `public` and takes `claimAddress` as a
 * parameter rather than reading `msg.sender`, so ANYONE may submit it and the
 * tokens still land on `claimAddress`. That is the whole point: a client who is
 * offline, or who never acquires gas despite {@link encodeLockPrepayMinerfee},
 * no longer has to be the one to act. Without it a swap whose preimage is
 * already public resolves by timeout — the tokens sit until the refund opens
 * even though everything needed to settle them is known.
 *
 * The words are `lockWords` with the preimage in place of its hash, because the
 * overload's parameter list IS the lock's, in order. Reusing it rather than
 * re-listing five fields is the same defence the header describes: a caller
 * cannot assemble a second, subtly different argument set.
 *
 * Submitting it is not free — the sender pays gas and receives nothing — so who
 * runs it is a deployment question, not a protocol one. The solver already has
 * a reason to: on a receive corridor it is holding the counter-leg, and a claim
 * that never lands is capital parked until timeout.
 */
export const CLAIM_FOR_SIGNATURE = 'claim(bytes32,uint256,address,address,address,uint256)'
const CLAIM_FOR_SELECTOR = selectorFor(CLAIM_FOR_SIGNATURE)

export const encodeClaimFor = (preimage: Uint8Array, lock: Erc20SwapLock): Uint8Array =>
  concat([CLAIM_FOR_SELECTOR, bytes32Word(preimage, 'preimage'), ...lockWords(lock).slice(1)])

/**
 * `refund(bytes32,uint256,address,address,address,uint256)` — the same thing for
 * the refund leg.
 *
 * Also `public` with an explicit `refundAddress`, so a third party can push a
 * matured refund and the tokens still return to whoever funded the lock. The
 * argument list is exactly the lock's, so this is `lockWords` unchanged.
 */
export const REFUND_FOR_SIGNATURE = 'refund(bytes32,uint256,address,address,address,uint256)'
const REFUND_FOR_SELECTOR = selectorFor(REFUND_FOR_SIGNATURE)

export const encodeRefundFor = (lock: Erc20SwapLock): Uint8Array => concat([REFUND_FOR_SELECTOR, ...lockWords(lock)])

/**
 * `refund(bytes32,uint256,address,address,uint256)`.
 *
 * Mirror of claim: the refunder is `msg.sender`, so `claimAddress` is passed
 * and `refundAddress` is implicit.
 */
export const REFUND_SIGNATURE = 'refund(bytes32,uint256,address,address,uint256)'
const REFUND_SELECTOR = selectorFor(REFUND_SIGNATURE)

export const encodeRefund = (lock: Erc20SwapLock): Uint8Array =>
  concat([
    REFUND_SELECTOR,
    bytes32Word(lock.preimageHash, 'preimageHash'),
    uintWord(lock.amount, 'amount'),
    addressWord(lock.tokenAddress, 'tokenAddress'),
    addressWord(lock.claimAddress, 'claimAddress'),
    uintWord(lock.timelock, 'timelock'),
  ])

/**
 * `lockPrepayMinerfee(bytes32,uint256,address,address,uint256)`.
 *
 * The same lock, plus native currency forwarded to the claimant in the very
 * same transaction:
 *
 * ```solidity
 * function lockPrepayMinerfee(..., address payable claimAddress, uint256 timelock)
 *     external payable {
 *   lock(preimageHash, amount, tokenAddress, claimAddress, msg.sender, timelock);
 *   TransferHelper.transferEther(claimAddress, msg.value);
 * }
 * ```
 *
 * WHY THIS FUNCTION EXISTS FOR US. A client receiving tokens usually holds none
 * of the chain's native asset, so it cannot pay for the claim and the swap
 * resolves by timeout — for exactly the users most likely to want the corridor.
 * This funds them for gas at the moment the tokens are locked, atomically, with
 * no extra round trip and nothing to trust. It is the contract-level answer
 * that decided the contract choice, so the binding would be incomplete without
 * it.
 *
 * NOTE THE PARAMETER LIST. `refundAddress` is NOT passed — the locker is
 * `msg.sender` and the contract fills it in. Passing the full lock and dropping
 * the field here keeps a caller from assembling a second, subtly different
 * argument set, exactly as `encodeClaim` and `encodeRefund` do. The lock's
 * `refundAddress` must therefore BE the sender, or the swap key the contract
 * stores will not be the one {@link swapKey} derives.
 */
export const LOCK_PREPAY_SIGNATURE = 'lockPrepayMinerfee(bytes32,uint256,address,address,uint256)'
const LOCK_PREPAY_SELECTOR = selectorFor(LOCK_PREPAY_SIGNATURE)

export const encodeLockPrepayMinerfee = (lock: Erc20SwapLock): Uint8Array =>
  concat([
    LOCK_PREPAY_SELECTOR,
    bytes32Word(lock.preimageHash, 'preimageHash'),
    uintWord(lock.amount, 'amount'),
    addressWord(lock.tokenAddress, 'tokenAddress'),
    addressWord(lock.claimAddress, 'claimAddress'),
    uintWord(lock.timelock, 'timelock'),
  ])

/**
 * THE TOKEN'S OWN ABI, not `ERC20Swap`'s.
 *
 * `lock` moves the tokens with `transferFrom`, so it can only succeed against a
 * standing allowance. These two calls are addressed to the TOKEN contract while
 * everything above is addressed to the swap contract — a distinction that is
 * invisible in the calldata and fatal in the `to` field, which is why they are
 * named for it rather than folded in with the rest.
 *
 * Both are static-typed, so the same hand-rolled encoding argument in the module
 * header applies unchanged.
 */
const APPROVE_SIGNATURE = 'approve(address,uint256)'
const APPROVE_SELECTOR = selectorFor(APPROVE_SIGNATURE)
const ALLOWANCE_SIGNATURE = 'allowance(address,address)'
const ALLOWANCE_SELECTOR = selectorFor(ALLOWANCE_SIGNATURE)

/** `approve(spender, amount)` on the token. */
export const encodeApprove = (spender: Uint8Array, amount: bigint): Uint8Array =>
  concat([APPROVE_SELECTOR, addressWord(spender, 'spender'), uintWord(amount, 'amount')])

/**
 * `allowance(owner, spender)` on the token.
 *
 * ARGUMENT ORDER IS LOAD-BEARING and the two are the same type, so swapping
 * them does not fail — it reads what the OWNER may spend of the spender's
 * balance, which for our pair is reliably zero. That reads as "no allowance",
 * and the recovery it triggers (approve again) succeeds, so the mistake would
 * survive every happy path and only cost an extra transaction per lock.
 */
export const encodeAllowance = (owner: Uint8Array, spender: Uint8Array): Uint8Array =>
  concat([ALLOWANCE_SELECTOR, addressWord(owner, 'owner'), addressWord(spender, 'spender')])

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
 * The preimage carried by a `Claim` log, checked against the hash we expect.
 *
 * `preimageHash` is indexed and so rides in `topics[1]`; `preimage` is not
 * indexed and is the whole of `data`. That layout is the contract's
 * declaration, quoted verbatim:
 *
 * ```solidity
 * event Claim(bytes32 indexed preimageHash, bytes32 preimage);
 * ```
 *
 * The topic this derives from that signature was confirmed present in the
 * deployed bytecode (see the tests). The layout itself is NOT confirmed against
 * a live log — the Arbitrum deployment has emitted nothing in 2M blocks, and
 * every public RPC reachable from here gates the historical `eth_getLogs` range
 * needed to find one elsewhere. Source plus bytecode is the strongest evidence
 * available without a funded testnet claim.
 *
 * The verification is the point. A log is untrusted input — anyone may emit an
 * event shaped like this from another contract, and a node may hand us the
 * wrong one — so a preimage that does not hash to what we locked against must
 * never reach the code that would spend on it. The caller supplies the hash it
 * expects rather than trusting `topics[1]`, because the topic is attacker-chosen
 * in exactly the case that matters.
 */
export const preimageFromClaimLog = (
  log: { topics: readonly Uint8Array[]; data: Uint8Array },
  expectedPreimageHash: Uint8Array,
): Uint8Array => {
  const topic = log.topics[0]
  if (!topic || !equalBytes(topic, CLAIM_EVENT_TOPIC)) throw new Error('not a Claim log')
  if (log.data.length !== WORD) throw new Error(`Claim data must be ${WORD} bytes, got ${log.data.length}`)
  const preimage = Uint8Array.from(log.data)
  if (!equalBytes(sha256(preimage), expectedPreimageHash)) {
    throw new Error('Claim log preimage does not hash to the expected payment hash')
  }
  return preimage
}
