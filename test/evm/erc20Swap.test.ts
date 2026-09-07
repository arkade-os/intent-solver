import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import {
  CLAIM_EVENT_SIGNATURE,
  CLAIM_FOR_SIGNATURE,
  CLAIM_SIGNATURE,
  LOCK_PREPAY_SIGNATURE,
  LOCK_SIGNATURE,
  REFUND_EVENT_SIGNATURE,
  REFUND_FOR_SIGNATURE,
  REFUND_SIGNATURE,
  claimEventTopic,
  encodeClaim,
  encodeClaimFor,
  encodeLock,
  encodeLockPrepayMinerfee,
  encodeRefund,
  encodeRefundFor,
  preimageFromClaimLog,
  refundEventTopic,
  swapKey,
  type Erc20SwapLock,
} from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'

const TOKEN = hex.decode('1111111111111111111111111111111111111111')
const CLAIMER = hex.decode('2222222222222222222222222222222222222222')
const REFUNDER = hex.decode('3333333333333333333333333333333333333333')
const PREIMAGE = hex.decode('a'.repeat(64))

const lock = (over: Partial<Erc20SwapLock> = {}): Erc20SwapLock => ({
  preimageHash: sha256(PREIMAGE),
  amount: 1_000_000n,
  tokenAddress: TOKEN,
  claimAddress: CLAIMER,
  refundAddress: REFUNDER,
  timelock: 12_345n,
  ...over,
})

/** Selector positions are the same for every function here: 4 bytes, then whole words. */
const wordAt = (calldata: Uint8Array, index: number): string =>
  hex.encode(calldata.subarray(4 + index * 32, 4 + (index + 1) * 32))

describe('selectors — pinned against the public 4byte registry', () => {
  // Cross-checked against 4byte.directory rather than only against our own
  // keccak: a signature string with the parameters in the wrong order would
  // hash consistently here and fail on chain.
  it.each([
    [CLAIM_SIGNATURE, 'cd413efa'],
    [LOCK_SIGNATURE, 'e64fafcc'],
    [REFUND_SIGNATURE, '36504721'],
    [LOCK_PREPAY_SIGNATURE, 'b8080ab8'],
    // The third-party overloads: same names, one more address, different
    // selectors. Getting these wrong is not a compile error anywhere — it is a
    // transaction that reverts on chain.
    [CLAIM_FOR_SIGNATURE, 'bc586b28'],
    [REFUND_FOR_SIGNATURE, '0e5bbd59'],
  ])('%s -> %s', (signature, expected) => {
    expect(hex.encode(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4))).toBe(expected)
  })

  it('snapshots its inputs, so a caller mutating one afterwards cannot rewrite the calldata', () => {
    // `bytes32Word` hands its input straight through rather than copying,
    // because `concat` copies into a fresh buffer. That is only safe while
    // every word feeds a concat — this pins the property the shortcut rests on,
    // so a future word builder that returns a VIEW is caught here rather than
    // by a lock whose calldata changed under it between building and signing.
    const preimageHash = new Uint8Array(32).fill(0xaa)
    const encoded = encodeLock(lock({ preimageHash }))
    const before = hex.encode(encoded)
    preimageHash.fill(0xff)
    expect(hex.encode(encoded)).toBe(before)
    expect(before).toContain('aa'.repeat(32))
  })

  it('puts that selector at the front of the calldata it builds', () => {
    expect(hex.encode(encodeLock(lock()).subarray(0, 4))).toBe('e64fafcc')
    expect(hex.encode(encodeClaim(PREIMAGE, lock()).subarray(0, 4))).toBe('cd413efa')
    expect(hex.encode(encodeRefund(lock()).subarray(0, 4))).toBe('36504721')
  })
})

/**
 * The authoritative check: the DEPLOYED contract computed this, not us.
 *
 * `hashValues` is `public pure`, so it can be called read-only for free. These
 * values came back from Boltz's live `ERC20Swap` at
 * `0x6398B76DF91C5eBe9f488e3656658E79284dDc0F` on Arbitrum (chain 42161), via
 * `eth_call` at block 494981971:
 *
 *   eth_call hashValues(bytes32,uint256,address,address,address,uint256)
 *     -> 0xa5c153fd7efa565672e61b86ea1b1fb616ee3203e4217799aaa3236ec9e6aff6
 *
 * Pinned as a fixture rather than re-fetched: a unit suite must not depend on
 * a public RPC. But it means `swapKey` is checked against the bytecode that
 * will actually reject a mismatched key, rather than only against our own
 * reading of the contract's assembly — which is the difference between
 * "we think this is abi.encode" and "the contract agrees".
 *
 * To re-derive after a contract change, call `hashValues` on the deployment
 * with exactly these parameters.
 */
describe('swapKey — verified against the deployed contract', () => {
  it('matches what Boltz`s live ERC20Swap computes for the same lock', () => {
    const onchain: Erc20SwapLock = {
      preimageHash: sha256(hex.decode('a'.repeat(64))),
      amount: 123_456_789n,
      tokenAddress: hex.decode('af88d065e77c8cc2239327c5edb3a432268e5831'), // USDC on Arbitrum
      claimAddress: hex.decode('2222222222222222222222222222222222222222'),
      refundAddress: hex.decode('3333333333333333333333333333333333333333'),
      timelock: 987_654n,
    }
    expect(hex.encode(swapKey(onchain))).toBe('a5c153fd7efa565672e61b86ea1b1fb616ee3203e4217799aaa3236ec9e6aff6')
  })
})

describe('swapKey — the contract`s hashValues', () => {
  it('hashes exactly the six words, in the contract order', () => {
    // Rebuilt here from the contract's assembly rather than from our own
    // helper, so this fails if the layout in `lockWords` ever drifts.
    const l = lock()
    const expected = new Uint8Array(6 * 32)
    expected.set(l.preimageHash, 0)
    expected[63] = 0x40 // amount = 1_000_000 = 0x0f4240, low bytes below
    expected[62] = 0x42
    expected[61] = 0x0f
    expected.set(TOKEN, 2 * 32 + 12)
    expected.set(CLAIMER, 3 * 32 + 12)
    expected.set(REFUNDER, 4 * 32 + 12)
    expected[5 * 32 + 31] = 0x39 // timelock = 12345 = 0x3039
    expected[5 * 32 + 30] = 0x30
    expect(hex.encode(swapKey(l))).toBe(hex.encode(keccak_256(expected)))
  })

  it('left-pads addresses into whole words, not encodePacked', () => {
    // The trap this module's docblock names. `encodePacked` would pack the
    // three addresses to 20 bytes each and hash 132 bytes instead of 192 —
    // a plausible-looking key matching nothing on chain.
    const l = lock()
    const packed = new Uint8Array(32 + 32 + 20 + 20 + 20 + 32)
    packed.set(l.preimageHash, 0)
    packed.set(TOKEN, 64)
    packed.set(CLAIMER, 84)
    packed.set(REFUNDER, 104)
    expect(hex.encode(swapKey(l))).not.toBe(hex.encode(keccak_256(packed)))
  })

  it('changes when any single field changes', () => {
    const base = hex.encode(swapKey(lock()))
    const variants: Partial<Erc20SwapLock>[] = [
      { preimageHash: sha256(hex.decode('b'.repeat(64))) },
      { amount: 1_000_001n },
      { tokenAddress: REFUNDER },
      { claimAddress: REFUNDER },
      { refundAddress: CLAIMER },
      { timelock: 12_346n },
    ]
    for (const over of variants) expect(hex.encode(swapKey(lock(over)))).not.toBe(base)
  })

  it('distinguishes claimAddress from refundAddress', () => {
    // Two same-typed adjacent fields are exactly where a transposed order
    // survives every other test. Swapping them must not be a no-op.
    const swapped = lock({ claimAddress: REFUNDER, refundAddress: CLAIMER })
    expect(hex.encode(swapKey(swapped))).not.toBe(hex.encode(swapKey(lock())))
  })
})

describe('calldata layout', () => {
  it('lock carries all six parameters in the contract order', () => {
    const data = encodeLock(lock())
    expect(data).toHaveLength(4 + 6 * 32)
    expect(wordAt(data, 0)).toBe(hex.encode(sha256(PREIMAGE)))
    expect(wordAt(data, 1)).toBe(`${'00'.repeat(29)}0f4240`)
    expect(wordAt(data, 2)).toBe(`${'00'.repeat(12)}${hex.encode(TOKEN)}`)
    expect(wordAt(data, 3)).toBe(`${'00'.repeat(12)}${hex.encode(CLAIMER)}`)
    expect(wordAt(data, 4)).toBe(`${'00'.repeat(12)}${hex.encode(REFUNDER)}`)
    expect(wordAt(data, 5)).toBe(`${'00'.repeat(30)}3039`)
  })

  it('claim omits claimAddress and refund omits refundAddress', () => {
    // The asymmetry is the contract's, not ours: whoever calls is the party
    // being omitted, because it is `msg.sender`. Getting this backwards builds
    // calldata that reverts for a reason nothing explains.
    const claim = encodeClaim(PREIMAGE, lock())
    expect(claim).toHaveLength(4 + 5 * 32)
    expect(wordAt(claim, 0)).toBe(hex.encode(PREIMAGE))
    expect(wordAt(claim, 3)).toBe(`${'00'.repeat(12)}${hex.encode(REFUNDER)}`)

    const refund = encodeRefund(lock())
    expect(refund).toHaveLength(4 + 5 * 32)
    expect(wordAt(refund, 0)).toBe(hex.encode(sha256(PREIMAGE)))
    expect(wordAt(refund, 3)).toBe(`${'00'.repeat(12)}${hex.encode(CLAIMER)}`)
  })

  it('sends the preimage as raw bytes, with no text encoding anywhere', () => {
    // The property the rejected contract could not offer. A preimage that is
    // invalid UTF-8 must survive byte for byte.
    const invalidUtf8 = Uint8Array.from([0xff, 0xfe, 0xc0, 0xaf, ...new Uint8Array(28).fill(0x01)])
    const data = encodeClaim(invalidUtf8, lock())
    expect(wordAt(data, 0)).toBe(hex.encode(invalidUtf8))
  })

  it('lockPrepayMinerfee omits refundAddress, which the contract fills from msg.sender', () => {
    // Five parameters, not six. The locker IS the refunder here, so passing it
    // would be a different function; getting this wrong builds calldata that
    // reverts, or worse, locks under a key we cannot derive.
    const data = encodeLockPrepayMinerfee(lock())
    expect(data).toHaveLength(4 + 5 * 32)
    expect(hex.encode(data.subarray(0, 4))).toBe('b8080ab8')
    expect(wordAt(data, 0)).toBe(hex.encode(sha256(PREIMAGE)))
    expect(wordAt(data, 2)).toBe(`${'00'.repeat(12)}${hex.encode(TOKEN)}`)
    expect(wordAt(data, 3)).toBe(`${'00'.repeat(12)}${hex.encode(CLAIMER)}`)
    // The refunder is nowhere in the calldata.
    expect(hex.encode(data)).not.toContain(hex.encode(REFUNDER))
  })

  it('refuses inputs it cannot encode', () => {
    expect(() => encodeClaim(new Uint8Array(31), lock())).toThrow(/preimage must be 32 bytes/)
    expect(() => encodeLock(lock({ tokenAddress: new Uint8Array(19) }))).toThrow(/tokenAddress must be 20 bytes/)
    expect(() => encodeLock(lock({ amount: -1n }))).toThrow(/must not be negative/)
    expect(() => encodeLock(lock({ amount: 2n ** 256n }))).toThrow(/does not fit in uint256/)
  })
})

describe('preimageFromClaimLog', () => {
  const topic = claimEventTopic()

  it('returns the preimage when it hashes to what we locked against', () => {
    const log = { topics: [topic, sha256(PREIMAGE)], data: PREIMAGE }
    expect(hex.encode(preimageFromClaimLog(log, sha256(PREIMAGE)))).toBe(hex.encode(PREIMAGE))
  })

  it('refuses a preimage that does not hash to the expected value', () => {
    // THE security property. A log is untrusted: anyone can emit this shape
    // from another contract. Accepting an unverified preimage would let a
    // forged log drive the solver to spend its own side for nothing.
    const forged = hex.decode('c'.repeat(64))
    const log = { topics: [topic, sha256(PREIMAGE)], data: forged }
    expect(() => preimageFromClaimLog(log, sha256(PREIMAGE))).toThrow(/does not hash to the expected/)
  })

  it('refuses a log that is not a Claim', () => {
    const other = keccak_256(new TextEncoder().encode('Refund(bytes32)'))
    expect(() => preimageFromClaimLog({ topics: [other], data: PREIMAGE }, sha256(PREIMAGE))).toThrow(/not a Claim log/)
    expect(() => preimageFromClaimLog({ topics: [], data: PREIMAGE }, sha256(PREIMAGE))).toThrow(/not a Claim log/)
  })

  it('refuses data that is not one word', () => {
    const log = { topics: [topic], data: new Uint8Array(31) }
    expect(() => preimageFromClaimLog(log, sha256(PREIMAGE))).toThrow(/must be 32 bytes/)
  })

  it('derives the topic from the signature rather than hardcoding it', () => {
    expect(CLAIM_EVENT_SIGNATURE).toBe('Claim(bytes32,bytes32)')
    expect(hex.encode(claimEventTopic())).toBe(
      hex.encode(keccak_256(new TextEncoder().encode('Claim(bytes32,bytes32)'))),
    )
  })
})

/**
 * The NON-INTERACTIVE paths — the EVM equivalent of what covclaimd does on
 * Arkade, and the reason these overloads are bound at all.
 *
 * The contract declares both `public` with the address as a PARAMETER rather
 * than reading `msg.sender`, so anyone may submit them and the funds still
 * reach the intended party. That is the whole property, and it lives entirely
 * in the calldata layout: a wrong word order sends someone else's tokens
 * somewhere else, and nothing local would catch it.
 */
describe('third-party claim and refund', () => {
  it('addresses the SAME lock as encodeLock, so it cannot settle a different swap', () => {
    // Words 1-5 of both overloads are the lock's own words. If these ever drift
    // from `encodeLock`, the call would reference a swap key the contract does
    // not have and revert — or, worse, one it does.
    const l = lock()
    const locked = encodeLock(l)
    const claimed = encodeClaimFor(PREIMAGE, l)
    const refunded = encodeRefundFor(l)
    for (const index of [1, 2, 3, 4, 5]) {
      expect(wordAt(claimed, index)).toBe(wordAt(locked, index))
      expect(wordAt(refunded, index)).toBe(wordAt(locked, index))
    }
  })

  it('carries the PREIMAGE in word 0 for claim, and its HASH for refund', () => {
    const l = lock()
    expect(wordAt(encodeClaimFor(PREIMAGE, l), 0)).toBe(hex.encode(PREIMAGE))
    expect(wordAt(encodeRefundFor(l), 0)).toBe(hex.encode(l.preimageHash))
    // The interactive claim omits claimAddress entirely, so the two layouts
    // differ by exactly one word — the property that makes them separate calls.
    expect(encodeClaimFor(PREIMAGE, l).length).toBe(encodeClaim(PREIMAGE, l).length + 32)
  })

  it('names claimAddress explicitly, which is what lets a third party submit it', () => {
    const claimAddress = new Uint8Array(20).fill(0x7c)
    const encoded = encodeClaimFor(PREIMAGE, lock({ claimAddress }))
    // Left-padded to a word, and it must be the CLAIM address — sending it the
    // refund address would pay the wrong party from a call anyone can make.
    expect(wordAt(encoded, 3)).toBe('00'.repeat(12) + '7c'.repeat(20))
  })

  it('names refundAddress explicitly on the refund side', () => {
    const refundAddress = new Uint8Array(20).fill(0x3f)
    expect(wordAt(encodeRefundFor(lock({ refundAddress })), 4)).toBe('00'.repeat(12) + '3f'.repeat(20))
  })
})

/**
 * Who the prepay actually pays, pinned because the answer decides whether a
 * whole class of swap works.
 *
 * The contract forwards the attached value to `claimAddress`:
 * `TransferHelper.transferEther(claimAddress, msg.value)`. That is correct
 * when the claimant submits its own claim, and wrong the moment claimant and
 * submitter differ — paying a merchant, where `claimAddress` publishes an
 * address and runs nothing while a payer or daemon sends the transaction.
 *
 * Nothing here can tell those cases apart, so this pins the FACT instead: the
 * beneficiary is word 3, and word 3 is the claim address. A change that moved
 * the prepay to some other party would land here rather than in a swap that
 * quietly funds the wrong account.
 */
describe(`prepay beneficiary`, () => {
  it(`names claimAddress, which is who the contract forwards the value to`, () => {
    const claimAddress = new Uint8Array(20).fill(0x5a)
    const refundAddress = new Uint8Array(20).fill(0x6b)
    const encoded = encodeLockPrepayMinerfee(lock({ claimAddress, refundAddress }))
    expect(wordAt(encoded, 3)).toBe('00'.repeat(12) + '5a'.repeat(20))
    // And the refunder is NOT in the calldata at all — the contract takes
    // msg.sender for that, which is why lockPrepayCall insists the two agree.
    expect(hex.encode(encoded)).not.toContain('6b'.repeat(20))
  })
})

/**
 * THE PRECONDITION #36 rests on: the `REFUND_*` constants above are FUNCTION
 * encodings, and a scan built on an EVENT that does not exist never fires.
 */
describe('the Refund event, against the deployed runtime bytecode', () => {
  const runtime = Buffer.from(
    readFileSync(fileURLToPath(new URL('../e2e/fixtures/erc20swap.runtime.hex', import.meta.url)), 'utf8')
      .trim()
      .replace(/^0x/, ''),
    'hex',
  )

  /** First LOGn after a PUSH32 of `topic`, walking opcodes: a PUSH immediate is data. */
  const logOpcodeAfter = (topic: Uint8Array): number | null => {
    const at = runtime.indexOf(Buffer.from(topic))
    if (at < 1 || runtime[at - 1] !== 0x7f) return null
    for (let pc = at + 32; pc < runtime.length;) {
      const op = runtime[pc]!
      if (op >= 0xa0 && op <= 0xa4) return op
      pc += op >= 0x60 && op <= 0x7f ? 1 + (op - 0x5f) : 1
    }
    return null
  }

  it('is emitted by the deployed contract', () => {
    expect(runtime.includes(Buffer.from(refundEventTopic()))).toBe(true)
  })

  it('carries exactly one indexed field, so the hash is topics[1] and there is no data', () => {
    // LOG1 would put the hash in `data` and the filter would match nothing.
    // Lockup is the control that must NOT be LOG2, or the walker says LOG2 always.
    expect(logOpcodeAfter(refundEventTopic())).toBe(0xa2)
    expect(logOpcodeAfter(claimEventTopic())).toBe(0xa2)
    const lockup = keccak_256(new TextEncoder().encode('Lockup(bytes32,uint256,address,address,address,uint256)'))
    expect(logOpcodeAfter(lockup)).toBe(0xa4)
  })

  it('derives the topic from the signature rather than hardcoding it', () => {
    expect(REFUND_EVENT_SIGNATURE).toBe('Refund(bytes32)')
    expect(hex.encode(refundEventTopic())).toBe(hex.encode(keccak_256(new TextEncoder().encode('Refund(bytes32)'))))
    expect(hex.encode(refundEventTopic())).not.toBe(hex.encode(claimEventTopic()))
  })

  it('hands out a copy, so a caller cannot poison every later match', () => {
    const first = refundEventTopic()
    first.fill(0)
    expect(hex.encode(refundEventTopic())).not.toBe(hex.encode(first))
  })
})
